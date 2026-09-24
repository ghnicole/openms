/** Optional diagnostic evidence for provisional client damage reports.
 *
 *  The original client rolls and shows its own outgoing lines (`009581a9`), and the
 *  server independently rolls final damage and HP changes. This module compares the
 *  reported values with the server's independent samples without accepting, rejecting
 *  or changing combat outcomes. It is supplementary telemetry, not validation.
 *
 *  The reference is the authority's own `PhysicalDamage`/`SkillDamage` roll for the same
 *  target and line, so no formula needs to be re-derived here. A uniform honest client
 *  sits above 95% of the observed maximum about 5% of the time; a client reporting the
 *  ceiling sits there almost always. Evidence is keyed on field ticks, never wall clock,
 *  so a verdict is reproducible from the same tick sequence in a test.
 *
 *  Verdicts:
 *  - `suspicious: false` — inside the observed range, or too few samples to judge.
 *  - `suspicious: true` — an improbable share of high-end or above-maximum lines inside
 *    one window. This is evidence only; reported values never become authoritative. */

/** One evidence window: 900 ticks is 27 s at the 30 ms kernel quantum. */
const WINDOW_TICKS = 900;
/** Bound each actor/skill window so a busy field allocates nothing per hit. */
const WINDOW_SAMPLES = 64;
/** Below this many samples the reference maximum is not yet meaningful. */
export const DAMAGE_WATCHDOG_MIN_SAMPLES = 24;
/** A line at or above this share of the observed maximum is "high-end". */
export const DAMAGE_WATCHDOG_HIGH_END = 0.95;
/** Flag when more than this share of the window is high-end. */
export const DAMAGE_WATCHDOG_HIGH_END_FRACTION = 0.5;
/** A line this far above every reference sample in the window is over-range. */
export const DAMAGE_WATCHDOG_OVER_FACTOR = 1.05;
/** Bounded memory: at most this many actor/skill windows are tracked at once. */
const MAX_TRACKED = 256;

function createEvidence(tick) {
  return {
    window: tick,
    samples: [],
    faults: 0,
    peakReported: 0,
    peakReference: 0,
    flaggedAt: -Infinity,
  };
}

/** Inspect one reported outgoing line. Never mutates the caller's simulation. */
export class DamageWatchdog {
  constructor({ enabled = true, log = null } = {}) {
    this.enabled = enabled;
    this.log = log;
    this.actors = new Map();
    this.reviewed = 0;
    this.highEnd = 0;
    this.suspicious = 0;
    this.faults = 0;
  }

  /** Compare a reported value with the authority's own roll for the same line. */
  observe(id, skillId, tick, { reported, reference }) {
    if (!this.enabled || !Number.isSafeInteger(reported) || reported < 0) {
      return { suspicious: false, high: false, over: false, score: 0 };
    }
    this.reviewed++;
    const evidence = this.track(id, skillId, tick);
    this.recordSample(evidence, tick, reported, reference);
    const ceiling = evidence.peakReference;
    const high = ceiling > 0 && reported >= ceiling * DAMAGE_WATCHDOG_HIGH_END;
    const over =
      ceiling > 0 && reported > ceiling * DAMAGE_WATCHDOG_OVER_FACTOR;
    if (high) this.highEnd++;
    const score = this.count(evidence, ceiling);
    if (
      score.samples < DAMAGE_WATCHDOG_MIN_SAMPLES ||
      (score.highEnd * 2 <= score.samples && score.over === 0)
    ) {
      return { suspicious: false, high, over, score: score.highEnd };
    }
    this.suspicious++;
    if (tick - evidence.flaggedAt >= WINDOW_TICKS) {
      evidence.flaggedAt = tick;
      evidence.faults++;
      this.faults++;
      this.log?.("combat.damage-suspicious", {
        character: id,
        skillId,
        tick,
        samples: score.samples,
        highEnd: score.highEnd,
        over: score.over,
        peakReported: evidence.peakReported,
        peakReference: evidence.peakReference,
      });
    }
    return { suspicious: true, high, over, score: score.highEnd };
  }

  /** Retain one sample within the count and tick bounds before evaluating it. */
  recordSample(evidence, tick, reported, reference) {
    evidence.samples.push({
      tick,
      reported,
      reference:
        Number.isSafeInteger(reference) && reference > 0 ? reference : 0,
    });
    if (evidence.samples.length > WINDOW_SAMPLES) {
      evidence.samples.shift();
    }
    evidence.peakReported = Math.max(evidence.peakReported, reported);
    evidence.peakReference = Math.max(evidence.peakReference, reference);
    this.prune(evidence, tick);
  }

  /** Recompute the window against its current observed maximum, not an early one. */
  count(evidence, ceiling) {
    let highEnd = 0;
    let over = 0;
    for (const sample of evidence.samples) {
      if (
        ceiling > 0 &&
        sample.reported >= ceiling * DAMAGE_WATCHDOG_HIGH_END
      ) {
        highEnd++;
      }
      if (
        ceiling > 0 &&
        sample.reported > ceiling * DAMAGE_WATCHDOG_OVER_FACTOR
      ) {
        over++;
      }
    }
    return { samples: evidence.samples.length, highEnd, over };
  }

  /** Drop samples once they leave the window; reset the range with them. */
  prune(evidence, tick) {
    const threshold = tick - WINDOW_TICKS;
    let index = 0;
    while (
      index < evidence.samples.length &&
      evidence.samples[index].tick <= threshold
    ) {
      index++;
    }
    if (index > 0) evidence.samples.splice(0, index);
    if (!evidence.samples.length) {
      evidence.peakReference = 0;
      return;
    }
    let peakReference = 0;
    for (const sample of evidence.samples) {
      if (sample.reference > peakReference) peakReference = sample.reference;
    }
    evidence.peakReference = peakReference;
  }

  track(id, skillId, tick) {
    const key = `${id}:${skillId}`;
    let evidence = this.actors.get(key);
    if (evidence) return evidence;
    if (this.actors.size >= MAX_TRACKED) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [candidateKey, value] of this.actors) {
        const last =
          value.samples[value.samples.length - 1]?.tick ?? value.window;
        if (last < oldest) {
          oldest = last;
          oldestKey = candidateKey;
        }
      }
      if (oldestKey !== null) this.actors.delete(oldestKey);
    }
    evidence = createEvidence(tick);
    this.actors.set(key, evidence);
    return evidence;
  }

  /** Release an actor's evidence when it leaves the world. */
  forget(id) {
    for (const key of [...this.actors.keys()]) {
      if (key === id || key.startsWith(`${id}:`)) this.actors.delete(key);
    }
  }

  /** Allocate only on explicit inspection. */
  snapshot() {
    const actors = [];
    for (const [key, evidence] of this.actors) {
      const score = this.count(evidence, evidence.peakReference);
      actors.push({
        key,
        samples: score.samples,
        highEnd: score.highEnd,
        over: score.over,
        peakReported: evidence.peakReported,
        peakReference: evidence.peakReference,
        faults: evidence.faults,
      });
    }
    return {
      enabled: this.enabled,
      reviewed: this.reviewed,
      highEnd: this.highEnd,
      suspicious: this.suspicious,
      faults: this.faults,
      actors,
    };
  }
}
