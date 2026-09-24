import { parseFlags } from "../../client/tools/source-options.js";
import { createProfile } from "../../client/src/profile/profile-validation.js";
import { grantItem } from "../../client/src/items/inventory-model.js";
import { isolatedOnlineCheck } from "./isolated-online-check.js";
import { runChair } from "../../client/tools/scenarios/online-chair.js";

/** Explicit fixture only: one authored chair in a disposable setup tab, plus a same-map peer. */
async function seed(database, content) {
  const passwordHash = await Bun.password.hash("password");
  for (const name of ["sitter", "witness"]) {
    const account = await database.createAccount({
      name,
      passwordHash,
      role: "player",
    });
    const profile = createProfile({
      mapId: "001000000",
      x: 520,
      y: 274,
      facing: 1,
    });
    profile.name = name === "sitter" ? "Sitter" : "Witness";
    profile.settings.BGM.mute = true;
    if (name === "sitter") {
      grantItem(profile, content.items[3010000], 1);
      profile.hp = profile.maxHP;
      profile.mp = 0;
      profile.baseMaxMP = 100;
      profile.maxMP = 100;
    }
    await database.createCharacter(account.id, profile);
  }
}

if (import.meta.main) {
  const flags = parseFlags(process.argv.slice(2), {
    output: { type: "string" },
    help: { type: "boolean" },
  });
  if (flags.help) {
    console.log(
      "bun server/tools/check-chair.js [--output DIR]\nDefault: /tmp/openms-chair. Disposable accounts/database; native chair use, seated MP recovery and project-bar player count.",
    );
  } else {
    const report = await isolatedOnlineCheck({
      seed,
      run: runChair,
      output: flags.output ?? "/tmp/openms-chair",
    });
    console.log(
      JSON.stringify({ status: report.status, failure: report.failure }),
    );
    process.exitCode = report.status === "pass" ? 0 : 1;
  }
}
