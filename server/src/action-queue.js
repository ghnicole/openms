import { PROTOCOL, protocolError } from "../../shared/protocol.js";
import { admitActor } from "./action-rules.js";

const COMBAT_WAIT_MS = 2000;
const OPERATION_WAIT_MS = 10000;
const MAX_WAITS = Math.ceil(OPERATION_WAIT_MS / PROTOCOL.TICK_MS);

function validateWaitingActor(world, actor, message) {
  admitActor(actor, world, message.fieldEpoch);
  if (
    actor.connection?.data.epoch !== message.connectionEpoch ||
    actor.connection?.data.closed
  ) {
    throw protocolError("STALE_CONNECTION");
  }
  if (
    world.closed ||
    world.overloaded ||
    actor.retiring ||
    actor.deliveryError
  ) {
    throw protocolError("SERVER_BUSY");
  }
}

function actionAnimating(actor, combat) {
  const phase = actor.skillField?.phase;
  return combat && phase && phase !== "idle" && phase !== "dead";
}

/** Wait without reserving the actor: simulation, incoming damage and release controls
 * must continue while an intention waits for its legal execution slot. */
export async function awaitActionSlot(world, actor, message, queuedAt) {
  const combat = message.action.kind === "skill.cast";
  const deadline = queuedAt + (combat ? COMBAT_WAIT_MS : OPERATION_WAIT_MS);
  for (let count = 0; count < MAX_WAITS; count++) {
    validateWaitingActor(world, actor, message);
    if (performance.now() >= deadline) {
      throw protocolError(combat ? "COOLDOWN" : "SERVER_BUSY");
    }
    if (!world.participants.busy(actor) && !actionAnimating(actor, combat)) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, PROTOCOL.TICK_MS);
    });
  }
  throw protocolError("SERVER_BUSY");
}

const MAX_CAST_INTENTS = 32;

/** Keep a release arriving during queue admission attached to its pending cast. */
export function retainCastIntent(actor, message) {
  if (message.action.kind !== "skill.cast") return null;
  actor.castIntents ??= new Map();
  if (actor.castIntents.has(message.operationId)) return null;
  if (actor.castIntents.size >= MAX_CAST_INTENTS) {
    throw protocolError("SERVER_BUSY");
  }
  const intent = {
    skillId: message.action.skillId,
    fieldEpoch: message.fieldEpoch,
    control: null,
  };
  actor.castIntents.set(message.operationId, intent);
  return intent;
}

export function queueCastControl(actor, action) {
  let target = null;
  const cancelAll =
    action.kind === "skill.cancel" && action.skillId === undefined;
  for (const intent of actor.castIntents?.values() ?? []) {
    if (cancelAll) intent.control = action;
    else if (intent.skillId === action.skillId) target = intent;
  }
  if (!target) return false;
  if (target.control?.kind !== "skill.cancel") target.control = action;
  return true;
}

export function finishCastIntent(actor, operationId, intent, receipt) {
  if (!intent || actor.castIntents.get(operationId) !== intent) return;
  actor.castIntents.delete(operationId);
  if (
    receipt?.status === "committed" &&
    actor.field?.epoch === intent.fieldEpoch &&
    intent.control
  ) {
    actor.skillRelease = intent.control;
  }
}
