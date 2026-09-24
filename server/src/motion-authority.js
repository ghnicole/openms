/** Legacy wire flag for forced relocation and unpredicted movement restrictions.
 * All motion is server-derived, including ordinary checkpoints where this is false.
 * True retires incompatible client impulses (travel, death, seats and world skills).
 * Predicted knockback and impulse skills instead reconcile with their matching diverts. */
export function serverOwnsPosition(actor, sim) {
  // A pending inventory/skill database transaction does not own movement.
  if (actor.transition || actor.profile?.hp <= 0) return true;
  if (!sim) return true;
  if (sim.seat !== null) return true;
  return Boolean(actor.skills?.worldController?.ownsMotion);
}

/** Only the current admitted combat action may explain its local prediction lock. */
export function combatMotionOwner(actor) {
  const field = actor.skillField;
  return {
    feedbackId: field?.feedbackId ?? null,
    inputSeq: field?.feedbackInputSeq ?? null,
    locked: Boolean(field?.blocksMovement),
  };
}
