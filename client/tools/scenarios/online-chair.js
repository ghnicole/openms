import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assertion, failureDetails, measureStage } from "../native-evidence.js";
import { onlineIdentity } from "./online-lifecycle.js";
import {
  participant,
  ready,
  consoleSection,
  closeConsole,
} from "./online-ui-repairs.js";
import { login } from "./online-recycling-scrolls.js";
import { clickLabel } from "./native.js";

const ITEM = '.maple-ui-panel[aria-label="Item"]';
const CHAIR = 3010000;

/** Native setup-tab chair use → committed seat receipt → resident sit pose for self and peers. */
export async function runChair({ browser, url, output }) {
  await mkdir(output, { recursive: true });
  const report = {
    status: "running",
    timings: {},
    checks: [],
    results: [],
    errors: [],
  };
  const contexts = [],
    pages = [];
  try {
    report.identity = await onlineIdentity(url);
    for (const name of ["sitter", "witness"]) {
      const page = await participant(browser, contexts, pages, report);
      await measureStage(report.timings, `${name}-login`, () =>
        login(page, url, name),
      );
    }
    const [sitter, witness] = pages;
    await sitOnChair(sitter, output, report);
    await witnessSeesSeat(sitter, witness, report);
    await measureStage(report.timings, "seated-mp-recovery", () =>
      seatedRecovery(sitter, report),
    );
    await measureStage(report.timings, "player-count", () =>
      playerCount(sitter, witness, output, report),
    );
    report.status = "pass";
  } catch (error) {
    report.status = "fail";
    report.failure = failureDetails(error);
    for (const [index, page] of pages.entries()) {
      await page.screenshot({ path: join(output, `failure-${index}.png`) });
    }
  } finally {
    for (const context of contexts) await context.close();
    await Bun.write(
      join(output, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  }
  return report;
}

/** MP keeps recovering while seated even when no HP can be restored. */
async function seatedRecovery(page, report) {
  const before = await page.evaluate(() => window.maple.snapshot().profile);
  assertion(before.hp === before.maxHP, "Recovery fixture must have full HP");
  assertion(before.mp < before.maxMP, "Recovery fixture must be missing MP");
  await page.waitForFunction(
    (mp) => {
      const state = window.maple.snapshot();
      return state.simulation.seat !== null && state.profile.mp >= mp + 3;
    },
    { timeout: 15000 },
    before.mp,
  );
  const after = await page.evaluate(() => window.maple.snapshot().profile);
  assertion(after.hp === before.hp, "Seated recovery changed full HP");
  report.recovery = { beforeMP: before.mp, afterMP: after.mp, hp: after.hp };
  report.checks.push("Seated MP recovers with full HP");
  const epoch = await page.evaluate(
    () => window.mapleOnline.snapshot().connectionEpoch,
  );
  await consoleSection(page, "diagnostics");
  await clickLabel(page, "Reconnect session", "#state-testing-controls");
  await page.waitForFunction(
    (previous) => window.mapleOnline.snapshot().connectionEpoch !== previous,
    {},
    epoch,
  );
  await ready(page);
  await closeConsole(page);
  const resumed = await page.evaluate(() => window.maple.snapshot().profile.mp);
  assertion(resumed >= after.mp, "Recovered MP was lost on reconnect");
  report.checks.push("Recovered MP survives a native reconnect");
}

async function waitForPlayerCount(page, count) {
  await page.waitForFunction(
    (expected) =>
      document.querySelector("#project-players")?.textContent ===
      `Players online: ${expected}`,
    { timeout: 15000 },
    count,
  );
}

/** The public count and shell layout follow actual connections, independent of the field view. */
async function playerCount(sitter, witness, output, report) {
  await waitForPlayerCount(sitter, 2);
  await waitForPlayerCount(witness, 2);
  for (const size of [
    { width: 1280, height: 800 },
    { width: 800, height: 600 },
  ]) {
    await sitter.setViewport(size);
    const fits = await sitter.evaluate(() => {
      const nodes = document.querySelectorAll("#project-bar > *");
      let right = 0;
      for (const node of nodes) {
        if (node.hidden) continue;
        const rect = node.getBoundingClientRect();
        if (rect.left < right || rect.right > innerWidth) return false;
        right = rect.right;
      }
      return true;
    });
    assertion(fits, "Project bar controls overlap or overflow");
    await sitter.screenshot({
      path: join(output, `project-bar-${size.width}.png`),
      clip: { x: 0, y: 0, width: size.width, height: 27 },
    });
  }
  await witness.goto("about:blank");
  await waitForPlayerCount(sitter, 1);
  report.checks.push(
    "Player count updates from two connections to one at 800×600",
  );
}

function seated(page) {
  return page
    .waitForFunction(() => window.maple.snapshot().simulation?.seat !== null, {
      timeout: 2000,
    })
    .then(() => true)
    .catch(() => false);
}

async function sitOnChair(page, output, report) {
  await page.bringToFront();
  await page.keyboard.press("i");
  await page.waitForSelector(ITEM, { visible: true });
  await clickLabel(page, "Item tab 3", ITEM);
  const uid = await page.evaluate(() => {
    const item = window.maple
      .snapshot()
      .profile.inventory.find((entry) => entry.id === 3010000);
    return item?.uid ?? null;
  });
  assertion(uid, "Seeded chair instance is missing from the setup tab");
  const selector = `${ITEM} [data-item-uid="${uid}"]`;
  await page.waitForSelector(selector, { visible: true });
  await activate(page, selector);
  await page.waitForFunction(
    () => window.maple.snapshot().online.status === "active",
  );
  await page.waitForFunction(
    () =>
      window.maple.snapshot().simulation?.seat !== null &&
      window.maple.snapshot().chairs === 1 &&
      window.mapleOnline
        .observation()
        .entities.some(
          (entry) => entry.appearance?.name === "Sitter" && entry.seat?.id,
        ),
    { timeout: 5000 },
  );
  const state = await chairState(page);
  await page.screenshot({ path: join(output, "seated.png") });
  report.seated = state;
  assertion(
    state.status === "active",
    "Client left the active field after using a chair",
    state,
  );
  assertion(
    state.action === "sit",
    "Chair seat did not select the sit pose",
    state,
  );
  assertion(
    state.entity?.seat?.id === CHAIR,
    "Published entity did not retain the chair template",
    state.entity?.seat,
  );
  assertion(
    state.chairs === 1,
    "Local client did not build the seated chair artwork",
    state,
  );
  assertion(report.errors.length === 0, "Browser exceptions", report.errors);
  report.checks.push(
    "Seeded chair sits through the native setup tab without a reconnect",
  );
  await ready(page);
}

function chairState(page) {
  return page.evaluate(() => {
    const entity = window.mapleOnline
      .observation()
      .entities.find((entry) => entry.appearance?.name === "Sitter");
    const state = window.maple.snapshot();
    return {
      status: state.online.status,
      seat: state.simulation?.seat ?? null,
      action: state.simulation?.action ?? null,
      entity,
      chairs: state.chairs ?? null,
    };
  });
}

/** Native double click: the first down arms the carried instance, the second down (detail 2)
 *  consumes it. One synthetic clickCount:2 down never arms the carry, so it cannot use an item. */
async function activate(page, selector) {
  const box = await page.$eval(selector, (node) =>
    node.getBoundingClientRect().toJSON(),
  );
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.click(x, y, { clickCount: 1 });
  await page.mouse.click(x, y, { clickCount: 2 });
  await seated(page);
}

/** A peer on the same map must observe both the chair template and the seated pose. */
async function witnessSeesSeat(sitter, witness, report) {
  await witness.waitForFunction(
    () =>
      window.mapleOnline
        .observation()
        .entities.some(
          (entity) =>
            entity.appearance?.name === "Sitter" &&
            entity.seat?.id === 3010000 &&
            entity.action === 7,
        ),
    { timeout: 10000 },
  );
  const observed = await witness.evaluate(() => {
    const entity = window.mapleOnline
      .observation()
      .entities.find((entry) => entry.appearance?.name === "Sitter");
    return {
      seat: entity?.seat ?? null,
      action: entity?.action ?? null,
      chairs: window.maple.snapshot().chairs ?? null,
      status: window.maple.snapshot().online.status,
    };
  });
  report.witness = observed;
  assertion(
    observed.status === "active",
    "Witness left the active field while the peer sat down",
    observed,
  );
  assertion(
    observed.chairs === 1,
    "Peer did not build the seated chair artwork",
    observed,
  );
  report.checks.push(
    "Peer observes the published chair seat and seated pose on the same map",
  );
}
