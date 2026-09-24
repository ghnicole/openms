import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assertion, failureDetails, measureStage } from "../native-evidence.js";
import { onlineIdentity } from "./online-lifecycle.js";
import { participant, focusGame, ready } from "./online-ui-repairs.js";
import { clickLabel } from "./native.js";
import { reconnect } from "./online-latency.js";
import { login } from "./online-recycling-scrolls.js";

const EMPTY_RECORD = Object.freeze({});
const pause = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function sample() {
  const probe = { rows: [], running: true };
  window.__combatProbe = probe;
  function frame() {
    if (!probe.running || probe.rows.length >= 600) return;
    const state = window.maple.snapshot();
    probe.rows.push({
      time: performance.now(),
      pose: state.presentation.action,
      local: state.localCombat ?? null,
      ready: state.prediction.ready,
      simAction: state.simulation.action,
      actors: state.actors,
      feedback: state.localSkillFeedback,
      visuals: state.skillVisuals,
      online: state.online.status,
    });
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

async function action(page, network, key) {
  await focusGame(page);
  await page.evaluate(sample);
  const start = await page.evaluate(() => performance.now());
  network.stall(1200);
  await page.keyboard.down(key);
  await pause(90);
  await page.keyboard.up(key);
  await pause(2400);
  const probe = await page.evaluate(() => {
    window.__combatProbe.running = false;
    return window.__combatProbe;
  });
  const first = probe.rows.find((row) =>
    /swing|stab|shoot|shot/i.test(row.pose),
  );
  return {
    key,
    latencyMs: first ? first.time - start : null,
    rows: probe.rows,
    ...actionSummary(probe.rows, start),
  };
}

async function monsters(page, network) {
  await page.waitForFunction(
    () =>
      window.mapleOnline
        .observation()
        .entities.some(
          (entity) => entity.kind === "mob" && Math.abs(entity.velocity.x) > 5,
        ),
    { timeout: 15000 },
  );
  await page.evaluate(sample);
  network.stall(450);
  await pause(1000);
  return page.evaluate(() => {
    window.__combatProbe.running = false;
    return window.__combatProbe.rows;
  });
}

function movement(rows) {
  const observed = new Map();
  let lateMoving = 0;
  let stalls = 0,
    moving = 0,
    maximumStep = 0,
    maximumRateExcess = 0;
  for (let i = 1; i < rows.length; i++) {
    for (const actor of rows[i].actors.filter(
      (entry) => entry.kind === "mob",
    )) {
      const previous = rows[i - 1].actors.find(
        (entry) => entry.id === actor.id,
      );
      if (!previous) continue;
      const distance = Math.hypot(actor.x - previous.x, actor.y - previous.y);
      maximumStep = Math.max(maximumStep, distance);
      const elapsed = Math.min(100, rows[i].time - rows[i - 1].time);
      // RemoteMotion permits 1.2 px/ms. Frame scheduling need not be exactly 60 Hz.
      maximumRateExcess = Math.max(maximumRateExcess, distance - 1.2 * elapsed);
      const age = observationAge(observed, actor, rows[i].time);
      if (age > 150 && distance > 0.001) lateMoving++;
      if (distance > 0.001) moving++;
      else stalls++;
    }
  }
  return { stalls, moving, maximumStep, maximumRateExcess, lateMoving };
}

export async function runCombatLatency({
  browser,
  url,
  network,
  output,
  baseline,
}) {
  await mkdir(output, { recursive: true });
  const report = {
    status: "running",
    baseline,
    timings: {},
    errors: [],
    results: [],
    actions: [],
  };
  const contexts = [],
    pages = [];
  try {
    report.identity = await measureStage(report.timings, "identity", () =>
      onlineIdentity(url),
    );
    const page = await participant(browser, contexts, pages, report);
    await measureStage(report.timings, "login", () =>
      login(page, url, "fighter"),
    );
    await page.waitForFunction(
      () => window.maple.snapshot().simulation.state === "ground",
    );
    await attacks(page, network, { output, report });
    const rows = await measureStage(report.timings, "monsters", () =>
      monsters(page, network),
    );
    report.movement = movement(rows);
    await Bun.write(join(output, "monster-frames.json"), JSON.stringify(rows));
    verifyMovement(report);
    await ready(page);
    if (!baseline) {
      const mage = await participant(browser, contexts, pages, report);
      await mageAttack(mage, { network, url, output, report });
    }
    await verifySource(url, report);
    report.status = "pass";
  } catch (error) {
    report.status = "fail";
    report.failure = failureDetails(error);
    for (const page of pages) {
      await page.screenshot({ path: join(output, "failure.png") });
    }
  } finally {
    await measureStage(report.timings, "teardown", async () => {
      for (const context of contexts) await context.close();
    });
  }
  return report;
}

async function attacks(
  page,
  network,
  { output, report, character = "fighter" },
) {
  for (const key of character === "mage" ? ["d"] : ["ControlLeft", "d"]) {
    const result = await measureStage(
      report.timings,
      `${character}-${key}`,
      () => action(page, network, key),
    );
    await Bun.write(
      join(output, `${character}-${key}-frames.json`),
      JSON.stringify(result.rows),
    );
    report.actions.push({
      character,
      key,
      latencyMs: result.latencyMs,
      runs: result.runs,
      confirmed: result.confirmed,
      previewMs: result.previewMs,
      projectileConfirmed: result.projectileConfirmed,
    });
    if (!report.baseline) {
      assertion(
        result.latencyMs !== null && result.latencyMs < 150,
        "Local action waited for the network",
        report.actions,
      );
      assertion(
        result.runs === 1,
        "Server replayed a locally completed attack",
        report.actions,
      );
      assertion(
        result.confirmed,
        "Server did not confirm the original local action",
        report.actions,
      );
      if (character === "mage") {
        assertion(
          result.previewMs !== null && result.previewMs < 1000,
          "Spell projectile waited for the held reply",
          report.actions,
        );
        assertion(
          result.projectileConfirmed,
          "Server projectile lost its cast identity",
          report.actions,
        );
      }
    }
  }
  if (!report.baseline && character === "fighter") {
    await queuedActions(page, network, report);
  }
}

function actionSummary(rows, start) {
  let runs = 0,
    attacking = false,
    previewMs = null,
    confirmed = false,
    projectileConfirmed = false;
  const identity = rows.find((row) => row.local?.active)?.local.active;
  for (const row of rows) {
    const next = /swing|stab|shoot|shot/i.test(row.pose);
    if (next && !attacking) runs++;
    attacking = next;
    const record =
      row.local?.records.find((entry) => entry.identity === identity) ??
      EMPTY_RECORD;
    if (record.confirmed) confirmed = true;
    if (record.serverProjectile) projectileConfirmed = true;
    if (previewMs === null && record.previewCount) {
      previewMs = row.time - start;
    }
  }
  return { runs, confirmed, previewMs, projectileConfirmed };
}

async function mageAttack(page, { network, url, output, report }) {
  await measureStage(report.timings, "mageLogin", () =>
    login(page, url, "mage"),
  );
  await attacks(page, network, { output, report, character: "mage" });
  await ready(page);
  assertion(report.errors.length === 0, "Browser errors", report.errors);
}

function observationAge(observed, actor, time) {
  let last = observed.get(actor.id);
  if (!last || last.x !== actor.observedX || last.y !== actor.observedY) {
    last = { x: actor.observedX, y: actor.observedY, time };
    observed.set(actor.id, last);
  }
  return time - last.time;
}

function verifyMovement(report) {
  if (report.baseline) return;
  assertion(
    report.movement.lateMoving > 0,
    "Moving mobs froze while updates were held",
    report.movement,
  );
  assertion(
    report.movement.maximumRateExcess <= 2,
    "A mob snapped during ordinary delayed motion",
    report.movement,
  );
}

async function verifySource(url, report) {
  assertion(report.errors.length === 0, "Browser errors", report.errors);
  assertion(
    (await onlineIdentity(url)).sourceBuildId === report.identity.sourceBuildId,
    "Source changed during check",
  );
}

/** Real key edges: the next cast and both cost previews precede delayed confirmation. */
async function queuedCasts(page, network) {
  await focusGame(page);
  const before = await page.evaluate(() => ({
    mp: window.maple.snapshot().profile.mp,
    ids: window.maple
      .snapshot()
      .localCombat.records.map((record) => record.identity),
  }));
  network.stall(1500);
  await page.keyboard.press("d", { delay: 30 });
  await page.waitForFunction(
    () => {
      const local = window.maple.snapshot().localCombat;
      const current = local.records.find(
        (record) => record.identity === local.active,
      );
      return current && current.duration - current.age < 180;
    },
    { polling: "raf", timeout: 3000 },
  );
  await page.keyboard.press("d", { delay: 30 });
  await page.waitForFunction(
    (ids) =>
      window.maple
        .snapshot()
        .localCombat.records.filter((record) => !ids.includes(record.identity))
        .length >= 2,
    { polling: "raf", timeout: 2000 },
    before.ids,
  );
  const preview = await page.evaluate(() => ({
    mp: window.maple.snapshot().profile.mp,
    records: window.maple.snapshot().localCombat.records.slice(-2),
  }));
  assertion(preview.mp < before.mp, "Queued casts did not reserve MP", {
    before,
    preview,
  });
  assertion(
    preview.records.every((record) => !record.confirmed),
    "Preview waited for a reply",
    preview,
  );
  return {
    beforeMP: before.mp,
    previewMP: preview.mp,
    count: 2,
    ...(await confirmQueuedCasts(
      page,
      preview.records.map((record) => record.identity),
    )),
  };
}

async function confirmQueuedCasts(page, ids) {
  await page.waitForFunction(
    (ids) => {
      const state = window.maple.snapshot();
      return ids.every((id) =>
        state.localCombat.records.some(
          (record) =>
            record.identity === id && record.confirmed && !record.rejected,
        ),
      );
    },
    { timeout: 12000 },
    ids,
  );
  await pause(1000);
  const confirmedMP = await page.evaluate(
    () => window.maple.snapshot().profile.mp,
  );
  await reconnect(page);
  const restoredMP = await page.evaluate(
    () => window.maple.snapshot().profile.mp,
  );
  assertion(
    restoredMP === confirmedMP,
    "Reconnect changed committed cast costs",
    { confirmedMP, restoredMP },
  );
  return { confirmedMP, restoredMP };
}

async function queuedInventory(page, network) {
  const panel = '.maple-ui-panel[aria-label="Item"]';
  await focusGame(page);
  await page.keyboard.press("i");
  await page.waitForSelector(panel, { visible: true });
  await clickLabel(page, "Item tab 2", panel);
  const uid = await page.evaluate(
    () =>
      window.maple
        .snapshot()
        .profile.inventory.find((item) => item.id === 2000000).uid,
  );
  network.stall(1500);
  for (const slot of [2, 3]) {
    const source = `${panel} [data-item-id="2000000"][data-item-slot="${slot - 1}"]`;
    await page.waitForSelector(source, {
      visible: true,
    });
    await page.click(source);
    await page.click(`${panel} [data-item-slot="${slot}"]`);
    await page.waitForFunction(
      (expected) =>
        window.maple
          .snapshot()
          .profile.inventory.find((item) => item.id === 2000000)?.slot ===
        expected,
      { timeout: 1000 },
      slot,
    );
  }
  const observedSlot = await page.evaluate(
    () =>
      window.mapleOnline
        .observation()
        .presentation.profile.inventory.find((item) => item.id === 2000000)
        .slot,
  );
  assertion(observedSlot === 1, "Inventory preview waited for confirmation", {
    observedSlot,
  });
  await page.waitForFunction(
    () =>
      window.mapleOnline
        .observation()
        .presentation.profile.inventory.find((item) => item.id === 2000000)
        ?.slot === 3,
    { timeout: 12000 },
  );
  return confirmInventory(page, uid);
}

async function confirmInventory(page, uid) {
  await page.keyboard.press("i");
  await reconnect(page);
  const restored = await page.evaluate(
    (id) =>
      window.maple.snapshot().profile.inventory.find((item) => item.uid === id),
    uid,
  );
  assertion(
    restored.slot === 3 && restored.count === 10,
    "Queued inventory moves changed identity, count or final slot",
    restored,
  );
  return { slot: restored.slot, quantity: restored.count, sameIdentity: true };
}

async function queuedActions(page, network, report) {
  report.queue = await measureStage(report.timings, "queued-casts", () =>
    queuedCasts(page, network),
  );
  report.inventoryQueue = await queuedInventory(page, network);
}
