import { PROTOCOL } from "../../../shared/protocol.js";

/** Received ticks are already one network leg old; prediction must cover both legs.
 * This is a client history bound, not permission to schedule arbitrary server ticks. */
export function inputHorizonTicks(timing) {
  return Math.min(
    PROTOCOL.INPUT_HISTORY - PROTOCOL.MAX_CATCH_UP,
    Math.ceil(timing.roundTripMs / PROTOCOL.TICK_MS) +
      PROTOCOL.INPUT_LEAD_TICKS,
  );
}

export function inputTargetTick(timing, now) {
  const arrival = Math.floor(
    (now + timing.oneWayMs + timing.tickOffsetMs) / PROTOCOL.TICK_MS,
  );
  // History capacity and observation age bound speculation in OnlinePrediction.
  // A delayed server packet must not stop the local simulation clock.
  return Math.max(timing.serverTick, arrival) + PROTOCOL.INPUT_BUFFER_TICKS;
}
