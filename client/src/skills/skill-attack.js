import { skillAttackAction } from "./skill-action-rules.js";
import {
  createCharacterStats,
  projectCharacterStats,
} from "../character/character-stats.js";
import {
  COMBAT_SKILLS,
  COMBAT_PASSIVES,
  combatRankError,
} from "./skill-combat-rules.js";
import {
  SkillDamage,
  skillLineCount,
  learnedCombatInfo,
} from "./skill-damage.js";
import { skillNumber } from "./skill-costs.js";
import {
  createWeaponUse,
  selectAmmunition,
  projectileRange,
  projectileTargetDistance,
  isRangedWeapon,
} from "../combat/weapon-usage.js";
import { placeBody } from "../world/life-geometry-numeric.js";
import {
  overlaps,
  rectangleState,
  displaceMobSkill,
} from "../combat/offline-mobs.js";
import { actionWeapon, attackRectangle } from "./skill-rectangle.js";
import { applySkillStatus, setMobStatus } from "../combat/mob-skill-status.js";
import { BALLISTIC_SKILLS } from "./skill-ballistic-rules.js";
import { SkillChain } from "./skill-chain.js";

const MAX_TARGETS = 30;
const VENOM_SKILL = Object.freeze({
  id: 0,
  properties: Object.freeze({ elemAttr: "s" }),
});
const MAX_LINES = 30;
const MAX_IMPACTS = 120;
const SPLASH = new Set([3101005, 3111003, 3211003]);
const COMBO_COSTS = new Map([
  [21100004, 30],
  [21110004, 100],
  [21120006, 200],
  [21100005, 30],
  [21120007, 200],
]);
const EMPTY_STATS = Object.freeze({});
const WORLD_ATTACKS = new Set([
  1121006, 1221007, 1321003, 11101006, 13101005, 5201006, 4211002, 21100002,
]);
const FINAL_BUFFS = new Set([11101002, 13101002]);
const PROC_SPEC = Object.freeze({ kind: "proc" });
const WORLD_SPEC = Object.freeze({ kind: "melee" });
const MP_EATER = [2100000, 2200000, 2300000];
const ENERGY_ATTACKS = new Set([5111002, 5111004, 5121002, 15101005, 15111001]);
const TRANSFORM_ATTACKS = new Set([5111006, 5121004, 5121005, 15111003]);
const SHIP_ATTACKS = new Set([5221007, 5221008]);
const BASIC_SKILL = Object.freeze({ id: 0, properties: Object.freeze({}) });
const BASIC_INFO = Object.freeze({ damage: 100 });
const PICKPOCKET_ATTACKS = new Set([
  0, 4001334, 4201005, 4211002, 4211004, 4221001, 4221003, 4221007,
]);
const INTERNAL_PROCS = new Set([15111006, 5110001, 15100004]);
const DRAIN_ATTACKS = new Set([4101005, 5111004, 15111001, 14101006]);

function combatSpec(id) {
  const declared = COMBAT_SKILLS.get(id);
  if (declared) return declared;
  if (WORLD_ATTACKS.has(id)) return WORLD_SPEC;
  if (
    COMBAT_PASSIVES.get(id) === "final-attack" ||
    FINAL_BUFFS.has(id) ||
    INTERNAL_PROCS.has(id)
  ) {
    return PROC_SPEC;
  }
  return null;
}

function impactSlot() {
  return {
    active: false,
    age: 0,
    duration: 0,
    delay: 0,
    chain: false,
    beam: false,
    skill: null,
    info: null,
    target: null,
    onHit: null,
    facing: 1,
    rank: 0,
    count: 0,
    total: 0,
    x: 0,
    y: 0,
    summon: false,
    luk: 0,
    str: 0,
    sequence: 0,
    startX: 0,
    startY: 0,
    endX: 0,
    endY: 0,
    generation: 0,
    visual: null,
    projectileId: 0,
    feedbackId: null,
    inputSeq: null,
    dotDamage: 0,
    venomDamage: 0,
    venomId: 0,
    damage: new Float64Array(MAX_LINES),
    critical: new Uint8Array(MAX_LINES),
    hit: {
      skillId: 0,
      skillLine: true,
      line: 0,
      critical: false,
      knockbackChance: 0,
      roll: 0,
    },
  };
}

function createDamageContext(field, use, stats) {
  return {
    generator: field.damageGenerator,
    skillPercentScale: 1,
    dotDamage: 0,
    stats,
    effect: { duration: 0, source: 0 },
    aranCombo: 0,
    rank: 0,
    summon: false,
    kind: "player",
    temporary: EMPTY_STATS,
    chargeMs: -1,
    chargeMax: 1000,
    line: 0,
    targetCount: 1,
    str: 0,
    luk: 0,
    elementalBoost: null,
    hp: 0,
    maxHP: 1,
    combo: 0,
    use,
  };
}

/** Extends OfflineField; never owns HP, inventory, animation leases or a second mob list. */
export class SkillAttack {
  constructor(field) {
    this.field = field;
    this.prepared = new Map();
    this.resources = null;
    this.targetController = null;
    this.attackSequence = 0;
    this.chain = new SkillChain(this);
    this.shadowHit = {
      skillId: 4111002,
      skillLine: true,
      line: 1,
      critical: false,
      knockbackChance: 0,
      roll: 0,
    };
    this.stats = createCharacterStats();
    this.damage = new SkillDamage(field.damageGenerator, field.hooks);
    this.targets = new Array(MAX_TARGETS).fill(null);
    this.distances = new Float64Array(MAX_TARGETS);
    this.body = rectangleState();
    // Server-side view compensation: the outgoing target test may sweep a mob's body over
    // the latency window the attacker was rendering, in whole simulation ticks.
    this.rewindTicks = 0;
    this.lagBody = rectangleState();
    this.use = createWeaponUse();
    this.shots = Array.from({ length: MAX_IMPACTS }, impactSlot);
    this.basicShot = impactSlot();
    this.basicShot.skill = BASIC_SKILL;
    this.basicShot.info = BASIC_INFO;
    this.active = null;
    this.pendingFinal = null;
    this.onHit = null;
    this.chargeMs = -1;
    this.aranCombo = 0;
    this.comboElapsed = 0;
    this.energy = 0;
    this.energyRemaining = 0;
    this.homing = null;
    this.homingGeneration = 0;
    this.context = createDamageContext(field, this.use, this.stats);
    this.externalContext = {
      attack: null,
      target: null,
      rectangle: null,
      center: null,
    };
  }

  prepare(skill, info, rank) {
    const spec = combatSpec(skill.id);
    if (!spec) return;
    const action = this.actionName(skill, info, spec, this.field.combat);
    const actor = this.field.scene.actor.actions.get(action);
    const weapon = actionWeapon(this.field.combat, action);
    const rectangle = attackRectangle(info, weapon);
    this.prepared.set(skill.id, {
      skill,
      info,
      rank,
      spec,
      projectile:
        !!spec.projectile ||
        (spec.kind === "magic" &&
          Object.keys(skill.visuals).some((path) =>
            /(^|\/)ball(\/|$)/.test(path),
          )),
      action,
      rectangle,
      duration: actor?.duration ?? 0,
      finalCandidates: Object.entries(skill.properties.finalAttack ?? {}).map(
        ([id, weapons]) => ({
          id: Number(id),
          weapons: Object.values(weapons),
        }),
      ),
    });
  }

  /** Build detached weapon-dependent records before equipment/profile publication. */
  prepareActor(actor, combat) {
    const prepared = new Map();
    for (const [id, record] of this.prepared) {
      // Summons own their attack geometry through prepareExternal. They have no
      // weapon specification; replacing the player's weapon must not reinterpret it.
      if (record.spec === null) {
        prepared.set(id, { ...record });
        continue;
      }
      const action = this.actionName(
        record.skill,
        record.info,
        record.spec,
        combat,
      );
      prepared.set(id, {
        ...record,
        action,
        // Authored skill rectangles win; a skill whose action has no authored
        // rectangle (e.g. Savage Blow's dagger `savage`) uses the equipped
        // weapon's ordinary rectangle while keeping the skill action for the pose.
        rectangle: attackRectangle(record.info, actionWeapon(combat, action)),
        duration: actor.actions.get(action)?.duration ?? 0,
      });
    }
    return prepared;
  }

  actionName(skill, info, spec, combat) {
    return skillAttackAction(skill, info, spec, combat);
  }

  actorError(record, info) {
    if (this.field.dead || this.field.store.profile.hp <= 0) {
      return "Cannot attack while dead";
    }
    if (this.field.simulation.state === "ladder") {
      return "Cannot attack while climbing";
    }
    if (this.field.phase !== "idle" && this.field.phase !== "hold") {
      return "Another attack is active";
    }
    if (!record || record.info !== info) {
      return "Original skill combat record is not prepared";
    }
    if (!record.duration) {
      return "Original skill actor action/timing is unavailable";
    }
    return null;
  }

  weaponError(skill, record) {
    const type = this.field.combat?.weaponType ?? 0;
    const required = skillNumber(
      skill.properties.weapon ?? skill.properties["weapon "],
    );
    if (required && type !== required) {
      return "Skill requires its original weapon type";
    }
    if (record.spec.weapons && !record.spec.weapons.includes(type)) {
      return "Skill requires its original weapon family";
    }
    if (!type) return "Original skill weapon is not equipped";
    if (
      !record.rectangle &&
      !this.isRay(record) &&
      record.spec.kind !== "charge"
    ) {
      return "Original skill attack rectangle is unavailable";
    }
    return null;
  }

  capacityError(info) {
    let free = 0;
    for (const shot of this.shots) if (!shot.active) free++;
    if (free < skillNumber(info.mobCount, 1)) {
      return "Skill impact pool is full";
    }
    return null;
  }

  /** Called after actor admission has established the prepared combat record. */
  projectileAdmissionError(record) {
    if (!record.projectile) return null;
    const resources = this.resources;
    if (!resources) return "Skill projectile resources are not prepared";
    const path = resources.phasePath(record.skill, "ball", record.rank);
    const sequence = path && resources.sequence(record.skill, path);
    const needed =
      skillNumber(record.info.mobCount, 1) *
      Math.max(1, skillNumber(record.info.bulletCount, 1));
    if (sequence) {
      return resources.hasSlots(sequence, needed)
        ? null
        : "Skill projectile slots are busy";
    }
    if (!record.spec.ammunition) return null;
    return this.field.hooks.projectileAdmissionError?.(needed) ?? null;
  }

  error(skill, info) {
    const record = this.prepared.get(skill.id);
    return (
      this.actorError(record, info) ??
      this.weaponError(skill, record) ??
      this.capacityError(info) ??
      combatRankError(info, skill) ??
      this.stateError(skill) ??
      this.field.hooks.eventSkillError?.(skill) ??
      this.projectileAdmissionError(record)
    );
  }

  stateError(skill) {
    const temporary = this.field.hooks.derivedStats?.() ?? EMPTY_STATS;
    return (
      this.comboStateError(skill, temporary) ??
      this.transformationError(skill) ??
      (skill.id === 4221001 && !temporary.darkSight
        ? "Assassinate requires Dark Sight"
        : null)
    );
  }

  comboStateError(skill, temporary) {
    const spec = COMBAT_SKILLS.get(skill.id);
    if (spec?.kind === "finisher" && temporary.combo < 2) {
      return "A combo orb is required";
    }
    if (skill.id === 1211002 && !temporary.charge) {
      return "Charged Blow requires an active charge";
    }
    const combo = COMBO_COSTS.get(skill.id);
    if (combo && this.aranCombo < combo) return "Insufficient Aran combo count";
    if (skill.id === 1121010 && temporary.combo < 11) {
      return "Enrage requires ten combo orbs";
    }
    return null;
  }

  transformationError(skill) {
    if (ENERGY_ATTACKS.has(skill.id) && this.energyRemaining <= 0) {
      return "Energy must be fully charged";
    }
    if (TRANSFORM_ATTACKS.has(skill.id) && !this.field.hooks.transformed?.()) {
      return "Transformation is required";
    }
    if (
      SHIP_ATTACKS.has(skill.id) &&
      !this.field.hooks.worldSkillActive?.(5221006)
    ) {
      return "Battleship is required";
    }
    return null;
  }

  consumeState(skill) {
    if (COMBO_COSTS.has(skill.id)) this.aranCombo = 0;
    if (skill.id === 1121010) {
      this.field.hooks.setSkillStateValue?.(1111002, "combo", 1);
    }
  }

  begin(skill, info, onHit, chargeMs = -1) {
    const record = this.prepared.get(skill.id);
    this.targetController = null;
    this.attackSequence++;
    // Captured from the owner at admission: the authoritative field sets it from the acting
    // connection's latency; the offline field leaves it at zero.
    const rewind = this.field.lagToleranceTicks;
    this.rewindTicks = Number.isSafeInteger(rewind) && rewind > 0 ? rewind : 0;
    this.field.hooks.interruptChakra?.();
    this.field.hooks.consumeEventSkill?.(skill);
    this.active = record;
    this.onHit = onHit;
    this.chargeMs = chargeMs;
    const field = this.field;
    field.attack = null;
    field.attackSkill = skill;
    field.attackInfo = info;
    field.attackOnHit = onHit;
    field.startPose(record.action, "attack");
    this.use.action = record.action;
    this.use.ranged = !!record.spec.projectile;
    const ammo = selectAmmunition(
      field.store.profile,
      field.hooks.items,
      field.combat.weaponId,
    );
    this.use.projectilePAD = ammo
      ? (field.hooks.items[ammo.id].info.incPAD ?? 0)
      : 0;
    this.consumeState(skill);
  }

  isRay(record) {
    return (
      record.spec.projectile ||
      record.spec.kind === "magic" ||
      record.spec.kind === "magnet"
    );
  }

  usesRectangle(record) {
    if (
      record.rectangle &&
      !SPLASH.has(record.skill.id) &&
      ((record.info.lt && record.info.rb) || !this.isRay(record)) &&
      !(record.spec.kind === "charge" && record.spec.magic)
    ) {
      return true;
    }
    return false;
  }

  place(record, origin) {
    if (this.usesRectangle(record)) {
      placeBody(this.body, record.rectangle, origin, origin.facing > 0);
      return;
    }
    if (record.spec.kind === "charge" && record.spec.magic) {
      const x = 100 + Math.trunc(this.chargeMs / 50);
      const y = 75 + Math.trunc((this.chargeMs * 3) / 200);
      this.body.left = origin.x - x;
      this.body.right = origin.x + x;
      this.body.top = origin.y - y;
      this.body.bottom = origin.y + y;
    } else {
      const range =
        skillNumber(record.info.range) ||
        (record.spec.kind === "magic" || record.spec.kind === "fixed"
          ? 300
          : projectileRange(
              this.field.combat.weaponType,
              this.field.store.profile.job,
              this.field.hooks,
            ));
      this.body.left = origin.x + (origin.facing > 0 ? 0 : -range);
      this.body.right = origin.x + (origin.facing > 0 ? range : 0);
      this.body.top = origin.y - 28;
      this.body.bottom = origin.y - 27;
    }
    this.body.active = true;
  }

  select(limit, skill, origin, ray = false) {
    let count = 0;
    for (const mob of this.field.mobs) {
      if (!this.eligible(mob, skill)) continue;
      const distance = this.targetDistance(mob, skill, origin, ray);
      if (!Number.isFinite(distance)) continue;
      if (count === limit && distance >= this.distances[count - 1]) continue;
      let index = Math.min(count, limit - 1);
      while (index > 0 && distance < this.distances[index - 1]) {
        this.targets[index] = this.targets[index - 1];
        this.distances[index] = this.distances[index - 1];
        index--;
      }
      this.targets[index] = mob;
      this.distances[index] = distance;
      if (count < limit) count++;
    }
    return count;
  }

  /** Return acquisition distance, or Infinity for a body outside the attack.
   *  Original 00678476 selects against 00664559(...,1), the union of the mob's current and
   *  previous receiver, so one tick of target motion cannot carry a body out of a swing.
   *  `rewindTicks` extends that same sweep across the latency window the attacker was
   *  rendering, so a client drawing remote actors in the past is judged against what it
   *  saw rather than against the server's present tick. */
  targetDistance(mob, skill, origin, ray) {
    const body = this.targetBody(mob);
    if (ray) {
      return projectileTargetDistance(
        body,
        origin,
        Math.max(this.body.right - origin.x, origin.x - this.body.left),
        COMBAT_SKILLS.get(skill.id)?.kind === "magic" ? 50 : 65,
      );
    }
    return overlaps(this.body, body) ? Math.abs(mob.x - origin.x) : Infinity;
  }

  /** The mob receiver used for outgoing selection: the native current+previous union,
   *  widened by the mob's last-tick delta across the compensation window. Recomputed into
   *  one reusable slot; never mutates the mob. */
  targetBody(mob) {
    const base = mob.sweptBody?.active ? mob.sweptBody : mob.body;
    if (this.rewindTicks <= 0 || !base?.active) return base;
    const dx = (mob.delta?.x ?? 0) * this.rewindTicks;
    const dy = (mob.delta?.y ?? 0) * this.rewindTicks;
    const out = this.lagBody;
    out.active = true;
    out.left = base.left + Math.min(0, dx);
    out.right = base.right + Math.max(0, dx);
    out.top = base.top + Math.min(0, dy);
    out.bottom = base.bottom + Math.max(0, dy);
    return out;
  }

  eligible(mob, skill) {
    if (
      !mob.alive ||
      !mob.active ||
      mob.fault ||
      mob.template.info.invincible
    ) {
      return false;
    }
    if (mob.selectedSkills.length && !mob.selectedSkills.includes(skill.id)) {
      return false;
    }
    return skill.id !== 2301002 || mob.template.info.undead === 1;
  }

  impact() {
    const record = this.active;
    if (!record) return;
    if (this.targetController?.handleImpact(record, this)) return;
    const origin = this.field.simulation;
    const count = this.impactTargets(record, origin);
    if (record.skill.id === 2301002) this.heal(record.info);
    if (record.spec.kind === "magnet") {
      this.magnet(record, count, origin);
      return;
    }
    this.generate(record, count, origin, "player");
    if (count) {
      this.advanceCounters(record.skill, count);
      this.field.hooks.onEventAttack?.(
        record.skill,
        this.targets[0],
        this.attackSequence,
      );
    }
    this.finishImpact(record, count);
  }

  impactTargets(record, origin) {
    this.place(record, origin);
    if (record.skill.id === 1001005 || record.skill.id === 11001003) {
      this.extendSlashBlast(record, origin);
    }
    const limit = skillNumber(record.info.mobCount, 1);
    let count =
      record.skill.id === 2221006
        ? this.chain.select(record, origin)
        : this.select(
            SPLASH.has(record.skill.id) ? 1 : limit,
            record.skill,
            origin,
            this.isRay(record) && !this.usesRectangle(record),
          );
    if (count && SPLASH.has(record.skill.id)) {
      placeBody(this.body, record.rectangle, this.targets[0], false);
      count = this.select(limit, record.skill, origin);
    }
    return count;
  }

  finishImpact(record, count) {
    if (record.spec.kind === "finisher") {
      this.field.hooks.setSkillStateValue?.(
        this.field.hooks.skillLevel?.(1111002) ? 1111002 : 11111001,
        "combo",
        1,
      );
    }
    if (
      record.skill.id === 1211002 &&
      !learnedCombatInfo(this.field.hooks, 1220010)
    ) {
      this.field.hooks.cancelSkillFamily?.("charge");
    }
    if (count) this.scheduleFinal(record);
    this.field.hooks.cancelSkillFamily?.("dark-sight");
    this.field.hooks.cancelSkillFamily?.("wind-walk");
  }

  prepareDamageContext(record, count, kind) {
    const context = this.context;
    context.stats = this.stats;
    context.skillPercentScale = 1;
    context.kind = kind;
    context.summon = kind === "summon";
    context.rank = record.rank;
    context.temporary = this.field.hooks.derivedStats?.() ?? EMPTY_STATS;
    context.chargeMs = kind === "player" ? this.chargeMs : -1;
    context.chargeMax = record.spec?.chargeMs ?? 1000;
    context.targetCount = count;
    context.hp = this.field.store.profile.hp;
    context.maxHP = this.field.store.profile.maxHP;
    context.combo = context.temporary.combo ?? 0;
    context.aranCombo = this.aranCombo;
    projectCharacterStats(
      this.field.store.profile,
      this.field.hooks,
      this.stats,
      context.temporary,
    );
    this.enhanceStats(this.stats);
    context.elementalBoost = learnedCombatInfo(this.field.hooks, 5220001);
  }

  generate(record, count, origin, kind) {
    this.prepareDamageContext(record, count, kind);
    if (!count && record.projectile) {
      const shot = this.reserveShot(record, null, origin);
      shot.count = 0;
      this.launchShot(shot);
      return;
    }
    const baseLines =
      record.spec?.kind === "status" ? 0 : skillLineCount(record.info);
    const shadow = this.hasShadowPartner(record, kind);
    for (let index = 0; index < count; index++) {
      const shot = this.reserveShot(record, this.targets[index], origin);
      if (record.skill.id === 2221006 || record.skill.id === 15111006) {
        this.chain.stage(shot, index, origin);
      }
      this.generateShot(shot, baseLines, shadow);
      if (!shot.delay) this.launchShot(shot);
    }
  }

  hasShadowPartner(record, kind) {
    return (
      kind === "player" &&
      this.context.temporary.shadowPartner &&
      !record.spec?.magic &&
      record.spec?.kind !== "magic"
    );
  }

  generateShot(shot, baseLines, shadow) {
    const context = this.context;
    shot.count = baseLines * (shadow ? 2 : 1);
    shot.summon = context.summon;
    shot.luk = this.stats.luk;
    shot.str = this.stats.str;
    shot.dotDamage = this.damage.dot(
      shot.skill,
      shot.info,
      shot.target.skillStatus.projected,
      context,
    );
    this.prepareVenomDamage(shot);
    this.field.damageGenerator.beginTarget();
    for (let line = 0; line < baseLines; line++) {
      context.line = line;
      shot.damage[line] = Math.max(
        0,
        this.damage.generate(shot.skill, shot.info, shot.target, context),
      );
      shot.critical[line] = this.damage.critical ? 1 : 0;
      if (shadow) {
        context.skillPercentScale = context.temporary.shadowPartnerSkill / 100;
        shot.damage[line + baseLines] = this.damage.generate(
          shot.skill,
          shot.info,
          shot.target,
          context,
        );
        shot.critical[line + baseLines] = this.damage.critical ? 1 : 0;
        context.skillPercentScale = 1;
      }
    }
  }

  /** Claim one inactive entry from the bounded impact pool. */
  acquireShot() {
    for (const candidate of this.shots) {
      if (!candidate.active) {
        candidate.active = true;
        return candidate;
      }
    }
    throw new Error("Admitted skill impact pool exhausted");
  }

  reserveShot(record, target, origin) {
    const shot = this.acquireShot();
    shot.dotDamage = 0;
    shot.venomDamage = 0;
    shot.venomId = 0;
    shot.age = 0;
    shot.feedbackId = this.field.feedbackId;
    shot.inputSeq = this.field.feedbackInputSeq;
    shot.skill = record.skill;
    shot.info = record.info;
    shot.delay = 0;
    shot.chain = false;
    shot.beam = false;
    shot.target = target;
    shot.generation = target?.deaths ?? 0;
    shot.rank = record.rank;
    shot.sequence = this.attackSequence;
    shot.facing = origin.facing;
    shot.onHit = record.spec ? this.onHit : this.field.hooks.onSkillHit;
    shot.hit.skillId = record.skill.id;
    shot.hit.knockbackChance = 0;
    // Tie optional client telemetry to this exact attack.
    shot.hit.reportId = shot.feedbackId ?? shot.inputSeq ?? null;
    shot.projectileId = this.use.projectileId;
    shot.startX =
      origin.x +
      (record.projectile
        ? origin.facing * (record.spec.kind === "magic" ? 50 : 65)
        : 0);
    shot.startY = origin.y - 28;
    const range = Math.max(
      this.body.right - origin.x,
      origin.x - this.body.left,
    );
    shot.endX = target
      ? (target.body.left + target.body.right) / 2
      : origin.x + origin.facing * range;
    shot.endY = target
      ? (target.body.top + target.body.bottom) / 2
      : shot.startY;
    shot.x = shot.startX;
    shot.y = shot.startY;
    shot.duration = record.projectile
      ? Math.max(
          1,
          Math.trunc(Math.hypot(shot.endX - shot.x, shot.endY - shot.y) * 1.5),
        )
      : 0;
    shot.visual = null;
    return shot;
  }

  launchShot(shot) {
    if (
      shot.target &&
      (!shot.target.alive || shot.target.deaths !== shot.generation)
    ) {
      shot.active = false;
      return;
    }
    const visual = shot.duration
      ? (this.field.hooks.onSkillProjectile?.(shot) ?? null)
      : null;
    // Native lightning segment leases outlive the damage record; resources own their270ms expiry.
    if (!shot.beam) shot.visual = visual;
    if (shot.chain || !shot.duration) this.resolve(shot);
  }

  resolve(shot) {
    shot.active = false;
    if (shot.visual) this.resources?.stop(shot.visual);
    shot.visual = null;
    const target = shot.target;
    if (!target || !target.alive || target.deaths !== shot.generation) return;
    let total = 0;
    for (let line = 0; line < shot.count; line++) {
      const amount = Math.min(target.hp, shot.damage[line]);
      shot.hit.line = line;
      shot.hit.critical = !!shot.critical[line];
      this.field.damageTarget(target, shot.damage[line], shot.hit, shot.facing);
      total += amount;
    }
    this.resolveStatus(shot, total);
  }

  resolveStatus(shot, total) {
    const target = shot.target;
    const context = this.context;
    context.dotDamage = shot.dotDamage;
    context.rank = shot.rank;
    context.summon = shot.summon;
    context.str = shot.str;
    context.luk = shot.luk;
    context.elementalBoost = learnedCombatInfo(this.field.hooks, 5220001);
    if (total > 0 || COMBAT_SKILLS.get(shot.skill.id)?.kind === "status") {
      if (applySkillStatus(target, shot.skill, shot.info, context)) {
        this.field.hooks.onMobStatus?.(target, shot.skill.id);
      }
      shot.onHit?.(shot.skill.id, target);
      this.displaceImpact(shot);
      this.onPositiveHit(shot, total);
    }
  }

  displaceImpact(shot) {
    if (!WORLD_ATTACKS.has(shot.skill.id) || shot.skill.id === 5201006) return;
    displaceMobSkill(
      shot.target,
      shot.facing *
        Math.max(
          0,
          Math.abs(shot.info.lt?.x ?? 0) -
            Math.abs(shot.target.x - this.field.simulation.x),
        ),
    );
  }

  step(ms) {
    this.chain.step();
    for (const shot of this.shots) {
      if (!shot.active) continue;
      if (shot.delay > 0) {
        const waiting = Math.min(ms, shot.delay);
        shot.delay -= waiting;
        if (shot.delay > 0) continue;
        this.launchShot(shot);
        if (!shot.active) continue;
        shot.age = -waiting;
      }
      shot.age = Math.min(shot.duration, shot.age + ms);
      if (!shot.beam) {
        shot.x =
          shot.startX + ((shot.endX - shot.startX) * shot.age) / shot.duration;
        shot.y =
          shot.startY + ((shot.endY - shot.startY) * shot.age) / shot.duration;
        if (shot.visual) shot.visual.animation.setPosition(shot.x, shot.y);
      }
      if (shot.age >= shot.duration) this.resolve(shot);
    }
    this.comboElapsed += ms;
    if (this.comboElapsed > 3500) this.aranCombo = 0;
    if (this.energyRemaining > 0) {
      this.energyRemaining = Math.max(0, this.energyRemaining - ms);
      if (!this.energyRemaining) this.energy = 0;
    }
  }

  heal(info) {
    if (this.field.hooks.authoritativePartyHealing) return;
    const profile = this.field.store.profile;
    const amount = Math.min(
      profile.maxHP - profile.hp,
      Math.trunc((profile.maxHP * skillNumber(info.hp)) / 100),
    );
    if (amount <= 0) return;
    profile.hp += amount;
    this.field.hooks.onRecovery?.(amount, this.field.simulation);
    this.field.changed();
  }

  onPositiveHit(shot, total) {
    if (!total) return;
    const id = shot.skill.id;
    const drain = DRAIN_ATTACKS.has(id)
      ? skillNumber(shot.info.x)
      : (this.field.hooks.derivedStats?.().comboDrain ?? 0);
    if (drain) {
      const profile = this.field.store.profile;
      const restored = Math.min(
        Math.trunc((total * drain) / 100),
        Math.trunc(profile.maxHP / 2),
        profile.maxHP - profile.hp,
      );
      profile.hp += restored;
      this.field.changed();
    }
    if (id === 5211006 || id === 5220011) {
      this.homing = shot.target;
      this.homingGeneration = shot.generation;
    }
    if (id === 1311005) {
      const profile = this.field.store.profile;
      profile.hp = Math.max(
        1,
        profile.hp - Math.trunc((total * skillNumber(shot.info.x)) / 100),
      );
      this.field.changed();
    }
    this.applyOnHitPassives(shot);
    this.pickpocket(shot);
    this.chain.queue(shot);
  }

  applyOnHitPassives(shot) {
    for (const id of MP_EATER) {
      if (!skillNumber(shot.info.mad) && shot.skill.id !== 2301002) break;
      const info = learnedCombatInfo(this.field.hooks, id);
      if (
        !info ||
        this.field.damageGenerator.next() % 100 >= skillNumber(info.prop)
      ) {
        continue;
      }
      const amount = Math.min(
        shot.target.mp,
        Math.trunc((shot.target.maxMP * skillNumber(info.x)) / 100),
      );
      shot.target.mp -= amount;
      const profile = this.field.store.profile;
      profile.mp = Math.min(profile.maxMP, profile.mp + amount);
      this.field.changed();
      break;
    }
    this.applyStatusBuff(shot, "hamstring", "speed");
    this.applyStatusBuff(shot, "blind", "accuracy");
    this.applyVenom(shot);
  }

  applyStatusBuff(shot, name, status) {
    const id = this.field.hooks.derivedStats?.()[name];
    if (!id || shot.target.template.info.boss) return;
    const info = learnedCombatInfo(this.field.hooks, id);
    if (this.field.damageGenerator.next() % 100 < skillNumber(info.prop)) {
      const effect = this.context.effect;
      effect.duration = skillNumber(info.y) * 1000;
      effect.source = id;
      setMobStatus(
        shot.target,
        status,
        name === "blind" ? -skillNumber(info.x) : skillNumber(info.x),
        effect,
      );
    }
  }

  pickpocket(shot) {
    const id = this.field.hooks.derivedStats?.().pickpocket;
    if (!id || !PICKPOCKET_ATTACKS.has(shot.skill.id)) return;
    const info = learnedCombatInfo(this.field.hooks, id);
    const maximum = skillNumber(info?.x);
    const drops = this.field.hooks.drops?.();
    if (!drops || maximum <= 0) return;
    for (let index = 0; index < shot.count; index++) {
      if (
        shot.damage[index] <= 0 ||
        this.field.damageGenerator.next() % 100 >= skillNumber(info.prop)
      ) {
        continue;
      }
      const amount = Math.min(
        maximum,
        Math.max(1, Math.trunc((shot.damage[index] * maximum) / 20000)),
      );
      drops.spawnPickpocket(shot.target, amount);
    }
  }

  advanceCounters(skill, count) {
    if (
      this.field.hooks.skillLevel?.(21000000) ||
      this.field.hooks.skillLevel?.(20000017)
    ) {
      this.aranCombo = Math.min(30000, this.aranCombo + count);
      this.comboElapsed = 0;
    }
    const temporary = this.field.hooks.derivedStats?.() ?? EMPTY_STATS;
    if (
      temporary.combo > 0 &&
      COMBAT_SKILLS.get(skill.id)?.kind !== "finisher"
    ) {
      this.advanceComboOrbs(temporary);
    }
    this.advanceEnergy(count);
  }

  advanceComboOrbs(temporary) {
    const id = this.field.hooks.skillLevel?.(1111002) ? 1111002 : 11111001;
    const advanced = this.field.hooks.skillLevel?.(1120003)
      ? 1120003
      : 11110005;
    const info =
      learnedCombatInfo(this.field.hooks, advanced) ??
      learnedCombatInfo(this.field.hooks, id);
    const extra =
      learnedCombatInfo(this.field.hooks, advanced) &&
      this.field.damageGenerator.next() % 100 < skillNumber(info.prop)
        ? 2
        : 1;
    if (info) {
      this.field.hooks.setSkillStateValue?.(
        id,
        "combo",
        Math.min(skillNumber(info.x) + 1, temporary.combo + extra),
      );
    }
  }

  advanceEnergy(count) {
    const id = this.field.hooks.skillLevel?.(5110001) ? 5110001 : 15100004;
    const info = learnedCombatInfo(this.field.hooks, id);
    if (!info || this.energyRemaining > 0) return;
    this.energy = Math.min(10000, this.energy + skillNumber(info.x) * count);
    if (this.energy === 10000) {
      this.energy = 15000;
      this.energyRemaining = skillNumber(info.time) * 1000;
    }
  }

  extendSlashBlast(record, origin) {
    const range = skillNumber(record.info.range);
    if (!range || !this.select(1, record.skill, origin)) return;
    if (origin.facing > 0) {
      this.body.right = Math.max(this.body.right, origin.x + range);
    } else this.body.left = Math.min(this.body.left, origin.x - range);
  }

  magnet(record, count, origin) {
    for (let index = 0; index < count; index++) {
      const target = this.targets[index];
      const success =
        !target.template.info.boss &&
        this.field.damageGenerator.next() % 100 < skillNumber(record.info.prop);
      if (success) {
        displaceMobSkill(target, origin.x + origin.facing * 50 - target.x);
        this.onHit?.(record.skill.id, target);
      }
      this.field.hooks.onMagnetResult?.(target, success);
    }
  }

  scheduleFinal(record) {
    for (const candidate of record.finalCandidates) {
      if (
        FINAL_BUFFS.has(candidate.id) &&
        !this.field.hooks.derivedStats?.().finalAttack
      ) {
        continue;
      }
      const proc = this.prepared.get(candidate.id);
      if (
        !proc ||
        this.field.damageGenerator.next() % 100 >= skillNumber(proc.info.prop)
      ) {
        continue;
      }
      this.pendingFinal = proc;
      return;
    }
  }

  beginFinal() {
    const record = this.pendingFinal;
    this.pendingFinal = null;
    if (!record) return false;
    this.begin(record.skill, record.info, this.onHit);
    return true;
  }

  prepareVenomDamage(shot) {
    const type = this.stats.weaponType;
    shot.venomId =
      type === 33
        ? 4220005
        : type === 47
          ? this.field.hooks.skillLevel?.(4120005)
            ? 4120005
            : 14110004
          : 0;
    const info = learnedCombatInfo(this.field.hooks, shot.venomId);
    shot.venomDamage = info
      ? this.damage.dot(
          VENOM_SKILL,
          info,
          shot.target.skillStatus.projected,
          this.context,
        )
      : 0;
  }

  applyVenom(shot) {
    if (!shot.target.alive || !shot.venomId || shot.venomDamage <= 0) return;
    const info = learnedCombatInfo(this.field.hooks, shot.venomId);
    if (
      !info ||
      this.field.damageGenerator.next() % 100 >= skillNumber(info.prop)
    ) {
      return;
    }
    const state = shot.target.skillStatus;
    state.venomStacks = Math.min(3, state.venomStacks + 1);
    const effect = this.context.effect;
    effect.duration = skillNumber(info.time) * 1000;
    effect.source = shot.venomId;
    setMobStatus(
      shot.target,
      "poison",
      shot.venomDamage * state.venomStacks,
      effect,
    );
  }

  external(skill, info, origin) {
    if (
      !origin ||
      !Number.isFinite(origin.x) ||
      !Number.isFinite(origin.y) ||
      (origin.facing !== -1 && origin.facing !== 1)
    ) {
      throw new Error("Invalid external skill origin");
    }
    const record = this.prepared.get(skill.id);
    if (!record) return 0;
    if (!this.prepareExternalContext(skill, info, origin)) return 0;
    const count = this.selectExternal(skill, info);
    this.context.rank = record.rank;
    this.context.summon = false;
    if (origin.kind === "area") {
      this.prepareDamageContext(record, count, "area");
      for (let index = 0; index < count; index++) {
        this.context.dotDamage = this.damage.dot(
          skill,
          info,
          this.targets[index].skillStatus.projected,
          this.context,
        );
        if (applySkillStatus(this.targets[index], skill, info, this.context)) {
          this.field.hooks.onMobStatus?.(this.targets[index], skill.id);
        }
      }
      return count;
    }
    this.generateExternal(record, count, origin);
    return count;
  }

  generateExternal(record, count, origin) {
    const previousCharge = this.chargeMs;
    if (origin.kind === "ballistic") {
      this.chargeMs = origin.chargeMs > 0 ? origin.chargeMs : -1;
    }
    this.generate(
      record,
      count,
      origin,
      origin.kind === "summon" ? "summon" : "player",
    );
    this.chargeMs = previousCharge;
  }

  prepareExternalContext(skill, info, origin) {
    const context = this.externalContext;
    context.attack = skill.properties.summon?.attack1?.info;
    context.target = this.externalTarget(origin);
    context.rectangle = origin.kind === "summon" ? context.attack?.range : info;
    context.center =
      context.attack?.type === 1 && context.target ? context.target : origin;
    if (context.rectangle?.lt && context.rectangle.rb) {
      this.placeExternal(context, origin);
      return true;
    }
    return !!context.target;
  }

  externalTarget(origin) {
    if (origin.targetId === null || origin.targetId === undefined) return null;
    return this.field.byId.get(origin.targetId);
  }

  placeExternal(context, origin) {
    const rectangle = context.rectangle;
    const center = context.center;
    const flip =
      origin.kind === "summon" &&
      context.attack.type === 0 &&
      origin.facing > 0;
    this.body.left = center.x + (flip ? -rectangle.rb.x : rectangle.lt.x);
    this.body.right = center.x + (flip ? -rectangle.lt.x : rectangle.rb.x);
    this.body.top = center.y + rectangle.lt.y;
    this.body.bottom = center.y + rectangle.rb.y;
    this.body.active = true;
  }

  selectExternal(skill, info) {
    const context = this.externalContext;
    const limit = Math.min(
      15,
      skillNumber(context.attack?.mobCount, skillNumber(info.mobCount, 1)),
    );
    if (!context.rectangle?.lt && context.target) {
      const count = this.eligible(context.target, skill) ? 1 : 0;
      this.targets[0] = context.target;
      return count;
    }
    return this.select(limit, skill, context.center);
  }

  prepareExternal(skill, info, rank) {
    if (BALLISTIC_SKILLS.has(skill.id)) {
      this.prepare(skill, info, rank);
      return;
    }
    this.prepared.set(skill.id, {
      skill,
      info,
      rank,
      spec: null,
      rectangle: null,
    });
  }

  enhanceStats(stats) {
    const hooks = this.field.hooks;
    const combo =
      learnedCombatInfo(hooks, 21000000) ?? learnedCombatInfo(hooks, 20000017);
    if (combo) {
      const stacks = Math.min(
        skillNumber(combo.z),
        Math.trunc(this.aranCombo / 10),
      );
      stats.pad += stacks * skillNumber(combo.x);
      stats.padWithoutProjectile += stacks * skillNumber(combo.x);
      stats.acc += stacks * skillNumber(combo.y);
    }
    const critical =
      learnedCombatInfo(hooks, 21110000) ?? learnedCombatInfo(hooks, 20000018);
    if (critical) {
      const stacks = Math.min(
        skillNumber(critical.y),
        Math.trunc(this.aranCombo / 10),
      );
      stats.criticalChance += stacks * skillNumber(critical.x);
      stats.criticalDamage += stacks * skillNumber(critical.damage);
    }
    if (this.energyRemaining <= 0) return;
    const energy =
      learnedCombatInfo(hooks, 5110001) ?? learnedCombatInfo(hooks, 15100004);
    stats.pad += skillNumber(energy.pad);
    stats.padWithoutProjectile += skillNumber(energy.pad);
    stats.acc += skillNumber(energy.acc);
    stats.eva += skillNumber(energy.eva);
  }

  basicDamage(stats, mob, use) {
    const context = this.context;
    context.stats = stats;
    context.kind = "player";
    context.summon = false;
    context.rank = 0;
    context.temporary = this.field.hooks.derivedStats?.() ?? EMPTY_STATS;
    context.chargeMs = -1;
    context.line = 0;
    context.use = use;
    context.hp = this.field.store.profile.hp;
    context.maxHP = this.field.store.profile.maxHP;
    context.combo = context.temporary.combo ?? 0;
    this.field.damageGenerator.beginTarget();
    let damage = this.damage.generate(BASIC_SKILL, BASIC_INFO, mob, context);
    damage = this.mortalBlow(damage, mob, use);
    context.use = this.use;
    this.field.damageGenerator.lastGenerated = damage;
    this.field.damageGenerator.lastOutcome = damage > 0 ? "hit" : "nonpositive";
    return damage;
  }

  mortalBlow(damage, mob, use) {
    if (use.ranged || !isRangedWeapon(this.field.combat.weaponType)) {
      return damage;
    }
    const id = this.field.combat.weaponType === 45 ? 3110001 : 3210001;
    const info = learnedCombatInfo(this.field.hooks, id);
    if (
      !info ||
      this.field.damageGenerator.next() % 100 >= skillNumber(info.prop)
    ) {
      return damage;
    }
    if (
      !mob.template.info.boss &&
      mob.hp * 100 < mob.maxHP * skillNumber(info.x) &&
      this.field.damageGenerator.next() % 100 < skillNumber(info.y)
    ) {
      return mob.hp;
    }
    return Math.trunc((damage * skillNumber(info.damage)) / 100);
  }

  basicHit(target, amount) {
    if (amount <= 0) return;
    this.basicShot.target = target;
    this.basicShot.luk = this.field.impactStats.luk;
    this.basicShot.str = this.field.impactStats.str;
    this.basicShot.count = 1;
    this.basicShot.damage[0] = amount;
    this.basicShot.sequence = this.attackSequence;
    const shadow = this.field.hooks.derivedStats?.().shadowPartner ?? 0;
    if (shadow) {
      this.field.damageTarget(
        target,
        Math.trunc((amount * shadow) / 100),
        this.shadowHit,
      );
    }
    this.onPositiveHit(this.basicShot, amount);
    this.advanceCounters(BASIC_SKILL, 1);
  }

  energyStance() {
    if (this.energyRemaining <= 0) return 0;
    const info =
      learnedCombatInfo(this.field.hooks, 5110001) ??
      learnedCombatInfo(this.field.hooks, 15100004);
    return skillNumber(info?.prop);
  }

  energyTouch(target) {
    if (this.energyRemaining <= 0 || !target.alive) return;
    const id = this.field.hooks.skillLevel?.(5110001) ? 5110001 : 15100004;
    const record = this.prepared.get(id);
    if (!record) return;
    this.targets[0] = target;
    this.generate(record, 1, this.field.simulation, "player");
  }

  clear() {
    this.chain.clear();
    for (const shot of this.shots) {
      if (shot.visual) this.resources?.stop(shot.visual);
      shot.visual = null;
      shot.active = false;
      shot.target = null;
    }
    this.pendingFinal = null;
    this.active = null;
    this.aranCombo = 0;
    this.energy = 0;
    this.energyRemaining = 0;
    this.homing = null;
  }
}
