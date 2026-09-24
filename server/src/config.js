import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { POW_MIN_BITS, POW_MAX_BITS } from "../../shared/proof-of-work.js";
import { loadEnvironment } from "../../shared/environment.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function port(value, fallback) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < 1 || result > 65535) {
    throw new Error("Server port must be an integer in 1..65535");
  }
  return result;
}

function configuredOrigin(environment, key = "OPENMS_ORIGIN") {
  const origin = new URL(environment[key] ?? "http://127.0.0.1:3102");
  if (
    origin.origin !== origin.href.slice(0, -1) ||
    origin.username ||
    origin.password
  ) {
    throw new Error(`${key} must be an exact origin without a path`);
  }
  if (!["http:", "https:"].includes(origin.protocol)) {
    throw new Error(`${key} must use HTTP or HTTPS`);
  }
  return origin.origin;
}

function proofBits(value) {
  const bits = value === undefined ? 15 : Number(value);
  if (!Number.isSafeInteger(bits)) {
    throw new Error("OPENMS_POW_BITS must be an integer");
  }
  return Math.max(POW_MIN_BITS, Math.min(POW_MAX_BITS, bits));
}

/** Rules pinning is optional; a configured digest still has to be well formed. */
function reviewedRulesHash(environment) {
  const value = environment.OPENMS_RULES_HASH;
  if (!value) return null;
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(
      "OPENMS_RULES_HASH must be a 64-character lowercase SHA-256 hex digest",
    );
  }
  return value;
}

function studioOrigin(environment) {
  if (!environment.OPENMS_STUDIO_ORIGIN) return null;
  return configuredOrigin(environment, "OPENMS_STUDIO_ORIGIN");
}

/** Temporarily disabled by default; reject typos instead of silently choosing a mode. */
function watchdogEnabled(value) {
  if (value === undefined) return false;
  if (value !== "true" && value !== "false") {
    throw new Error("OPENMS_MOTION_WATCHDOG_ENABLED must be true or false");
  }
  return value === "true";
}

/** Damage evidence is cheap and always worth keeping; it can be turned off explicitly. */
function combatWatchdogEnabled(value) {
  if (value === undefined) return true;
  if (value !== "true" && value !== "false") {
    throw new Error("OPENMS_COMBAT_WATCHDOG_ENABLED must be true or false");
  }
  return value === "true";
}

/** Origins stay exact in every mode; only host configuration decides transport. */
export function serverConfig(environment = loadEnvironment("server")) {
  const development = environment.OPENMS_MODE === "development";
  const origin = configuredOrigin(environment);
  const hostname = environment.OPENMS_HOST ?? "127.0.0.1";
  if (typeof hostname !== "string" || !hostname.trim()) {
    throw new Error(
      "OPENMS_HOST must be a non-empty bind hostname or IP address",
    );
  }
  if (!environment.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL must point to PostgreSQL; no in-memory economy fallback",
    );
  }
  if (!/^postgres(ql)?:\/\//.test(environment.DATABASE_URL)) {
    throw new Error("DATABASE_URL must use PostgreSQL");
  }
  return Object.freeze({
    development,
    origin,
    studioOrigin: studioOrigin(environment),
    hostname,
    port: port(environment.OPENMS_PORT, 3200),
    databaseUrl: environment.DATABASE_URL,
    contentRoot:
      environment.OPENMS_CONTENT_ROOT ??
      resolve(ROOT, "client/public/generated"),
    expectedRulesHash: reviewedRulesHash(environment),
    secureCookie: new URL(origin).protocol === "https:",
    powBits: proofBits(environment.OPENMS_POW_BITS),
    watchdogEnabled: watchdogEnabled(
      environment.OPENMS_MOTION_WATCHDOG_ENABLED,
    ),
    combatWatchdogEnabled: combatWatchdogEnabled(
      environment.OPENMS_COMBAT_WATCHDOG_ENABLED,
    ),
    sessionMs: 12 * 60 * 60 * 1000,
    reconnectMs: 30_000,
    maxSessions: 1024,
    maxConnections: 128,
  });
}
