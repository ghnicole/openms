import {
  selectAmmunition,
  selectWeaponUse,
  createWeaponUse,
} from "../combat/weapon-usage.js";
import { projectilePreview } from "./local-projectile-rules.js";
import { COMBAT_SKILLS } from "../skills/skill-combat-rules.js";
import { skillAttackAction } from "../skills/skill-action-rules.js";

/** Presentation selection shares the authored action rules, never their damage/RNG owner. */
export function localAttackSpec(owner, skillId, variant) {
  const actor = owner.scene?.actor,
    profile = owner.store.profile;
  const sim = owner.scene?.simulation;
  if (!canPresent(actor, sim, profile)) return null;
  const combat = actor.avatar?.combat;
  const derived = owner.state?.self.entity.combatState?.modifiers ?? {};
  if (skillId) return skillSpec(owner, combat, derived, skillId);
  if (!combat) return null;
  const use = createWeaponUse();
  selectWeaponUse(
    combat,
    {
      crouching: sim.crouching,
      job: profile.job,
      randomWord: variant,
      ammunition: selectAmmunition(
        profile,
        owner.catalog.ui.items,
        combat.weaponId,
      ),
      unlimitedAmmunition: Boolean(derived.soulArrow || derived.shadowStars),
      closeTarget: false,
      items: owner.catalog.ui.items,
    },
    use,
  );
  return {
    action: use.action,
    speed: attackSpeed(combat, derived, null, null),
    sfx: combat.equipment.sfx,
    projectile: projectilePreview(owner, combat, {}, use),
    // Local hit presentation reuses the same admitted weapon row; the server still owns
    // whether the damage lands.
    use,
    info: null,
    spec: null,
  };
}

function skillSpec(owner, combat, derived, skillId) {
  const skill = owner.catalog.ui.skills[skillId];
  const rank = owner.store.profile.skills[skillId]?.level ?? 0;
  const info = skill?.levels[rank];
  if (!info) return null;
  const spec = COMBAT_SKILLS.get(skillId);
  const action = spec
    ? skillAttackAction(skill, info, spec, combat)
    : skill.actions[0];
  return action
    ? {
        action,
        projectile: projectilePreview(owner, combat, {
          id: skillId,
          skill,
          info,
          spec,
        }),
        speed: spec ? attackSpeed(combat, derived, spec, skillId) : null,
        // Local hit presentation reads the authored rectangle and damage percent; the
        // server still resolves admission, HP and rewards.
        use: null,
        info,
        spec: spec ?? null,
      }
    : null;
}

function attackSpeed(combat, derived, spec, skillId) {
  const magic =
    spec && (spec.kind === "magic" || spec.magic || spec.kind === "heal");
  const base = magic
    ? 6
    : (combat?.equipment.attackSpeed ?? 6) + (skillId === 4001334 ? -2 : 0);
  return Math.max(
    2,
    Math.min(
      10,
      base +
        (derived.booster ?? 0) +
        (magic ? 0 : (derived.speedInfusion ?? 0)),
    ),
  );
}

function canPresent(actor, sim, profile) {
  return (
    actor &&
    sim &&
    profile &&
    profile.hp > 0 &&
    sim.state !== "ladder" &&
    !sim.seat
  );
}
