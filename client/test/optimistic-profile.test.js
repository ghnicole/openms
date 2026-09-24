import { expect, test } from "bun:test";
import { OnlineUI } from "../src/online/ui.js";
import { localAttackSpec } from "../src/online/local-combat-rules.js";
import { NativeProfileSource } from "../src/online/native-source.js";
import { createProfile } from "../src/profile/profile-validation.js";
import { freezeView } from "../src/online/read-model.js";

async function fixture() {
  const catalog = await Bun.file(
    new URL("../public/generated/catalog.json", import.meta.url),
  ).json();
  const profile = createProfile({ mapId: "000050000", x: 0, y: 0, facing: 1 });
  profile.skills[1001004] = { level: 1 };
  profile.mp = 20;
  const owner = {
    catalog,
    state: {
      presentation: { profile: freezeView(profile), stats: {} },
      revisions: { character: 0, inventory: 0 },
    },
  };
  owner.store = new NativeProfileSource(owner);
  return {
    owner,
    store: owner.store,
    previews: owner.store.optimistic,
    profile,
  };
}

test("pending casts reserve resources, refuse overspending and keep publications immutable", async () => {
  const { store, previews, profile } = await fixture();
  const action = { kind: "skill.cast", skillId: 1001004 };
  const plan = previews.plan(action);
  expect(plan.mp).toBeGreaterThan(0);
  previews.add("first", plan);
  expect(store.profile.mp).toBe(20 - plan.mp);
  expect(profile.mp).toBe(20);
  for (let n = 1; n < Math.floor(20 / plan.mp); n++) {
    previews.add(`cast${n}`, previews.plan(action));
  }
  expect(() => previews.plan(action)).toThrow("Insufficient MP");
  previews.settle("first", { status: "unknown" });
  expect(store.profile.mp).toBe(20 % plan.mp);
  previews.settle("first", { status: "rejected" });
  expect(store.profile.mp).toBe((20 % plan.mp) + plan.mp);
});

test("confirmed costs retire only when the covering publication arrives, in either order", async () => {
  for (const snapshotFirst of [true, false]) {
    const { owner, store, previews, profile } = await fixture();
    const plan = previews.plan({ kind: "skill.cast", skillId: 1001004 });
    previews.add("cast", plan);
    const receipt = { status: "committed", domainRevision: 1 };
    const publish = () => {
      owner.state = {
        ...owner.state,
        revisions: { character: 1, inventory: 0 },
        presentation: {
          ...owner.state.presentation,
          profile: freezeView({ ...profile, mp: 20 - plan.mp }),
        },
      };
    };
    if (snapshotFirst) publish();
    previews.settle("cast", receipt);
    if (!snapshotFirst) {
      expect(store.profile.mp).toBe(20 - plan.mp);
      publish();
    }
    expect(store.profile.mp).toBe(20 - plan.mp);
    expect(previews.records.size).toBe(0);
  }
});

test("whole-stack moves project by stable identity and a refusal rebases following moves", async () => {
  const { owner, store, previews, profile } = await fixture();
  const item = {
    uid: "item",
    id: 2000000,
    slot: 1,
    count: 10,
    flags: 0,
    owner: "",
    expiresAt: null,
  };
  owner.state.presentation.profile = freezeView({
    ...profile,
    inventory: [item],
  });
  const move = (slot) => ({
    kind: "inventory.move",
    itemId: "item",
    quantity: 10,
    to: { tab: "use", slot },
  });
  previews.add("first", previews.plan(move(2)));
  previews.add("second", previews.plan(move(3)));
  expect(store.profile.inventory[0].slot).toBe(3);
  expect(item.slot).toBe(1);
  previews.settle("first", { status: "rejected" });
  previews.settle("second", { status: "rejected" });
  expect(store.profile.inventory[0].slot).toBe(1);
  expect(previews.plan({ ...move(4), quantity: 5 })).toBeNull();
});

test("published cost modifiers allow Infinity and reserve Concentrate's adjusted debit", async () => {
  const { owner, previews, profile } = await fixture();
  owner.state.self = {
    entity: { combatState: { modifiers: { infinity: true } } },
  };
  owner.state.presentation.profile = freezeView({ ...profile, mp: 0 });
  const action = { kind: "skill.cast", skillId: 1001004 };
  expect(previews.plan(action).mp).toBe(0);
  owner.state.presentation.profile = profile;
  owner.state.self.entity.combatState.modifiers = { concentrate: 50 };
  const discounted = previews.plan(action).mp;
  owner.state.self.entity.combatState.modifiers = {};
  const full = previews.plan(action).mp;
  expect(discounted).toBe(full - Math.trunc(full / 2));
});

test("the last arrow starts its projectile before its resource reservation hides the stack", async () => {
  const { owner, previews, profile, store } = await fixture();
  const draft = structuredClone(profile);
  draft.job = 300;
  draft.equipment.find((entry) => entry.slot === -11).id = 1452000;
  draft.skills[3001004] = { level: 1 };
  draft.inventory.push({
    uid: "arrow",
    id: 2060000,
    slot: 1,
    count: 1,
    flags: 0,
    owner: "",
    expiresAt: null,
  });
  owner.state.presentation.profile = freezeView(draft);
  owner.state.self = { entity: { combatState: { modifiers: {} } } };
  owner.scene = {
    actor: {
      avatar: { combat: owner.catalog.ui.avatar.entries[1452000].combat },
    },
    simulation: { state: "ground", facing: 1 },
  };
  let spec;
  owner.localCombat = {
    begin: (id) => {
      spec = localAttackSpec(owner, id, 0);
    },
  };
  owner.optimisticImpulse = () => null;
  const pending = Promise.withResolvers();
  pending.promise.operationId = "last-arrow";
  owner.command = () => pending.promise;
  const plan = previews.plan({ kind: "skill.cast", skillId: 3001004 });
  expect(plan.items).toEqual([{ uid: "arrow", quantity: 1 }]);
  expect(OnlineUI.prototype.startCast.call(owner, 3001004, plan)).toBe(true);
  expect(spec.projectile.templateId).toBe(2060000);
  expect(
    store.profile.inventory.find((entry) => entry.uid === "arrow").count,
  ).toBe(0);
  pending.resolve({ status: "committed" });
  await pending.promise;
});
