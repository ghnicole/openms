import { SkillCosts } from "../skills/skill-costs.js";
import { moveInventory } from "../items/inventory-action-rules.js";
import { freezeView } from "./read-model.js";

const MAX_PREVIEWS = 32;
const TABS = [null, "equip", "use", "setup", "etc", "cash"];

/** Disposable overlays never modify a publication or become a persistence source. */
export class OptimisticProfile {
  constructor(owner) {
    this.owner = owner;
    this.records = new Map();
    this.cooldowns = new Map();
    this.base = null;
    this.view = null;
    const skills = () => owner.catalog.ui.skills;
    this.costs = new SkillCosts({
      store: {
        get profile() {
          return owner.store.profile;
        },
      },
      derived: () => owner.state?.self?.entity.combatState?.modifiers ?? {},
      level: (id) => owner.store.profile.skills[id]?.level ?? 0,
      info: (id, rank) => skills()[id]?.levels[rank],
      hooks: {
        get items() {
          return owner.catalog.ui.items;
        },
      },
    });
  }
  profile() {
    const base = this.owner.state?.presentation.profile ?? null;
    if (base !== this.base) this.invalidate();
    if (this.view || !base) return this.view;
    this.base = base;
    this.retire();
    if (!this.records.size) return (this.view = base);
    const view = structuredClone(base);
    for (const record of this.records.values()) this.apply(view, record.plan);
    this.view = freezeView(view);
    return this.view;
  }
  plan(action) {
    if (this.records.size >= MAX_PREVIEWS) return null;
    if (action.kind === "skill.cast") return this.skillPlan(action.skillId);
    if (action.kind !== "inventory.move") return null;
    const source = this.profile().inventory.find(
      (item) => item.uid === action.itemId,
    );
    // A split needs a new server identity. Keep that operation confirmation-bound.
    if (!source || source.count !== action.quantity) return null;
    const plan = { domain: "inventory", action };
    const draft = structuredClone(this.profile());
    return this.apply(draft, plan) ? plan : null;
  }
  skillPlan(id) {
    const now = performance.now();
    for (const [key, value] of this.cooldowns) {
      if (value.until <= now) this.cooldowns.delete(key);
    }
    if (this.cooldowns.size >= MAX_PREVIEWS) return null;
    if (this.cooldowns.has(id)) {
      throw new Error("This skill is still cooling down.");
    }
    const skill = this.owner.catalog.ui.skills[id];
    const rank = this.profile().skills[id]?.level ?? 0;
    const info = skill?.levels[rank];
    if (!info) throw new Error("This skill is not learned.");
    const error = this.costs.error(skill, info);
    if (error) throw new Error(error);
    const costs = this.costs;
    const items = [];
    for (let index = 0; index < costs.count; index++) {
      items.push({
        uid: costs.entries[index].uid,
        quantity: costs.quantities[index],
      });
    }
    return {
      domain: "character",
      skillId: id,
      hp: costs.hp,
      mp: costs.mp,
      meso: reservedMesos(id, costs.meso, this.profile().meso),
      items,
      cooldown: Number(info.cooltime ?? 0) * 1000,
    };
  }
  add(id, plan) {
    if (!id || !plan) return;
    this.records.set(id, { plan, receipt: null });
    if (plan.cooldown > 0) {
      this.cooldowns.set(plan.skillId, {
        id,
        until: performance.now() + plan.cooldown,
      });
    }
    this.invalidate();
  }
  settle(id, receipt) {
    const record = this.records.get(id);
    if (!record || receipt.status === "unknown") return;
    if (receipt.status === "rejected") {
      this.records.delete(id);
      if (this.cooldowns.get(record.plan.skillId)?.id === id) {
        this.cooldowns.delete(record.plan.skillId);
      }
    } else record.receipt = receipt;
    this.invalidate();
  }
  retire() {
    const revisions = this.owner.state?.revisions;
    for (const [id, record] of this.records) {
      if (
        record.receipt &&
        revisions?.[record.plan.domain] >= record.receipt.domainRevision
      ) {
        this.records.delete(id);
      }
    }
  }
  apply(profile, plan) {
    if (plan.action) {
      try {
        return moveInventory(profile, this.owner.catalog.ui.items, {
          uid: plan.action.itemId,
          count: plan.action.quantity,
          type: TABS.indexOf(plan.action.to.tab),
          slot: plan.action.to.slot,
        });
      } catch {
        // A newer publication can invalidate a preview; its server receipt still decides.
        return false;
      }
    }
    profile.hp = Math.max(0, profile.hp - plan.hp);
    profile.mp = Math.max(0, profile.mp - plan.mp);
    profile.meso = Math.max(0, profile.meso - plan.meso);
    for (const debit of plan.items) {
      const item = profile.inventory.find((entry) => entry.uid === debit.uid);
      if (item) item.count = Math.max(0, item.count - debit.quantity);
    }
    return true;
  }
  invalidate() {
    this.base = null;
    this.view = null;
  }
  clear() {
    this.records.clear();
    this.cooldowns.clear();
    this.invalidate();
  }
}

/** Reserve the largest legal randomized meso debit; the confirmed snapshot refunds excess. */
function reservedMesos(id, cost, available) {
  if (id !== 4111004) return cost;
  return Math.min(available, cost + Math.max(0, Math.trunc(cost / 2) - 1));
}
