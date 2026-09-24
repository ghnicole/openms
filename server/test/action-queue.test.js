import { expect, test } from "bun:test";
import { awaitActionSlot } from "../src/action-queue.js";
import { executeAction } from "../src/actions.js";
import { releaseSkill } from "../src/field-skills.js";

function fixture(kind = "skill.cast") {
  const actor = {
    id: "actor",
    state: "active",
    session: { expiresAt: Date.now() + 60000 },
    field: { epoch: "field", characters: new Map() },
    connection: { data: { epoch: "connection", closed: false } },
    skillField: { phase: "attack" },
  };
  actor.field.characters.set(actor.id, actor);
  const world = {
    actors: new Map([[actor.id, actor]]),
    participants: { busy: () => Boolean(actor.pending) },
  };
  const message = {
    fieldEpoch: "field",
    connectionEpoch: "connection",
    action: { kind },
  };
  return { actor, world, message };
}

test("queued casts wait for animation without reserving or freezing the actor", async () => {
  const { actor, world, message } = fixture();
  const pending = awaitActionSlot(world, actor, message, performance.now());
  expect(actor.pending).toBeUndefined();
  actor.skillField.phase = "idle";
  await pending;
});

test("waiting operations recheck connection and field ownership", async () => {
  for (const fieldChange of [true, false]) {
    const { actor, world, message } = fixture("inventory.move");
    actor.pending = true;
    const pending = awaitActionSlot(world, actor, message, performance.now());
    if (fieldChange) actor.field.epoch = "retired";
    else actor.connection.data.epoch = "reconnected";
    actor.pending = false;
    await expect(pending).rejects.toMatchObject({
      code: fieldChange ? "STALE_FIELD" : "STALE_CONNECTION",
    });
  }
});

test("expired combat cannot execute even if the actor becomes ready", async () => {
  const { actor, world, message } = fixture();
  actor.skillField.phase = "idle";
  await expect(
    awaitActionSlot(world, actor, message, performance.now() - 2001),
  ).rejects.toMatchObject({ code: "COOLDOWN" });
});

test("a release arriving before a queued cast starts is applied to that cast exactly once", async () => {
  const { actor, world, message } = fixture();
  actor.connection.data.ready = true;
  actor.revision = 0;
  actor.playSession = "session";
  const calls = [];
  actor.skills = { release: (id) => calls.push(id) };
  world.database = { receipt: async () => null };
  world.participants.reconcile = async (owner, receipt) => receipt;
  world.participants.signalIdle = () => {};
  world.cast = async () => ({
    status: "committed",
    code: "OK",
    domainRevision: 1,
    transactionId: null,
  });
  Object.assign(message, {
    operationId: "cast",
    expectedRevision: 0,
    action: { kind: "skill.cast", skillId: 2121001 },
  });
  const casting = executeAction(actor, message, world);
  const control = {
    ...message,
    operationId: "release",
    action: { kind: "skill.release", skillId: 2121001 },
  };
  const released = await executeAction(actor, control, world);
  expect(released.status).toBe("committed");
  expect(calls).toHaveLength(0);
  actor.skillField.phase = "idle";
  expect((await casting).status).toBe("committed");
  expect(actor.castIntents.size).toBe(0);
  expect(actor.skillRelease).toEqual(control.action);
  releaseSkill(world, actor, actor.skillRelease);
  actor.skillRelease = null;
  expect(calls).toEqual([2121001]);
  await executeAction(actor, control, world);
  expect(calls).toEqual([2121001]);
});
