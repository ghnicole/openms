import { OptimisticProfile } from "./optimistic-profile.js";
import { SOCIAL_MESSAGES } from "../../../shared/social-feedback.js";

const OPERATION_MESSAGES = Object.freeze({
  SERVER_BUSY: "The server is busy. Please try again in a moment.",
  REQUIREMENTS_NOT_MET: "You do not meet the requirements for this action.",
});

/** A terminal gameplay refusal is feedback, distinct from an unexpected exception. */
export class NativeOperationRefusal extends Error {
  constructor(outcome) {
    super(outcome.reason);
    this.name = "NativeOperationRefusal";
    this.code = outcome.code;
  }
}

/** Read-only confirmed state plus disposable previews; never a save target. */
export class NativeProfileSource {
  constructor(owner) {
    this.owner = owner;
    this.listeners = new Set();
    this.optimistic = new OptimisticProfile(owner);
  }
  get profile() {
    return this.optimistic.profile();
  }
  get id() {
    return this.owner.state?.self.entity.id ?? null;
  }
  get profileTransactionPending() {
    return this.owner.pending > 0;
  }
  get pending() {
    return this.profileTransactionPending;
  }
  get status() {
    return this.owner.connection?.status ?? "disconnected";
  }
  subscribe(listener) {
    if (typeof listener !== "function" || this.listeners.size >= 64) {
      throw new Error("Invalid native profile observer");
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  publish() {
    for (const listener of this.listeners) listener(this);
  }
  destroy() {
    this.optimistic.clear();
    this.listeners.clear();
  }
}

export function unsupported(domain) {
  return {
    ok: false,
    code: "UNSUPPORTED_CAPABILITY",
    reason: `The server does not provide ${domain}.`,
  };
}

/** Native controls receive the actual terminal receipt, never an optimistic profile edit. */
export function nativeOutcome(receipt) {
  const code = receipt?.code;
  return {
    ok: receipt?.status === "committed",
    code: code ?? "OUTCOME_UNKNOWN",
    reason:
      receipt?.status === "committed"
        ? undefined
        : (OPERATION_MESSAGES[code] ??
          SOCIAL_MESSAGES[code] ??
          code ??
          "Operation outcome is unknown; reconnect to recover it."),
    receipt,
    value: receipt?.value,
  };
}
