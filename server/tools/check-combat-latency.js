import { join } from "node:path";
import { parseFlags } from "../../client/tools/source-options.js";
import { grantItem } from "../../client/src/items/inventory-model.js";
import { createProfile } from "../../client/src/profile/profile-validation.js";
import { DelayedTraffic } from "../../client/tools/scenarios/delayed-traffic.js";
import { runCombatLatency } from "../../client/tools/scenarios/online-combat-latency.js";
import { runHitFeedback } from "../../client/tools/scenarios/online-hit-feedback.js";
import { isolatedOnlineCheck } from "./isolated-online-check.js";

async function seed(database, content, scope) {
  await seedCharacter(database, "fighter", 100, {
    skillId: 1001004,
    scope,
    items: content.items,
  });
  await seedCharacter(database, "mage", 200, {
    skillId: 2001004,
    scope,
    items: content.items,
  });
}

async function seedCharacter(database, name, job, { skillId, scope, items }) {
  const account = await database.createAccount({
    name,
    passwordHash: await Bun.password.hash("password"),
    role: scope === "hits" ? "developer" : "player",
  });
  const profile = createProfile({
    mapId: "000050000",
    x: 200,
    y: 335,
    facing: 1,
  });
  profile.name = name;
  grantItem(profile, items[2000000], 10);
  profile.job = job;
  if (job === 200) {
    profile.equipment.find((item) => item.slot === -11).id = 1372005;
  }
  profile.level = 20;
  profile.baseMaxHP = profile.maxHP = profile.hp = 5000;
  profile.baseMaxMP = profile.maxMP = profile.mp = 1000;
  profile.skills[skillId] = { level: 1, masterLevel: 0, expiresAt: null };
  profile.keyBindings.keys[32] = { type: 1, id: skillId };
  profile.settings.BGM.mute = true;
  await database.createCharacter(account.id, profile);
}

if (import.meta.main) {
  const flags = parseFlags(process.argv.slice(2), {
    output: { type: "string" },
    baseline: { type: "boolean" },
    scope: { type: "string" },
    help: { type: "boolean" },
  });
  if (flags.help) {
    console.log(
      "bun server/tools/check-combat-latency.js [--output DIR] [--baseline] [--scope combat|hits]\n500 ms RTT; combat (default) checks attack poses/projectiles, hits checks local impact/contact reactions. Output defaults to /tmp/openms-combat-latency. Baseline records without repaired-behavior assertions.",
    );
  } else {
    const timings = {},
      output = flags.output ?? "/tmp/openms-combat-latency";
    const scope = flags.scope ?? "combat";
    if (scope !== "combat" && scope !== "hits") {
      throw new Error("Unknown combat scope");
    }
    const run = scope === "hits" ? runHitFeedback : runCombatLatency;
    const report = await isolatedOnlineCheck({
      seed: (database, content) => seed(database, content, scope),
      output,
      timings,
      network: new DelayedTraffic(500),
      run: (options) => run({ ...options, baseline: Boolean(flags.baseline) }),
    });
    report.fixtureTimings = timings;
    await Bun.write(
      join(output, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(
      JSON.stringify({
        status: report.status,
        timings: report.timings,
        actions: report.actions,
        movement: report.movement,
        queue: report.queue,
        inventoryQueue: report.inventoryQueue,
        outgoing: report.outgoing,
        incoming: report.incoming,
        failure: report.failure,
      }),
    );
    process.exitCode = report.status === "pass" ? 0 : 1;
  }
}
