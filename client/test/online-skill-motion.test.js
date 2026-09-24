import { test, expect } from "bun:test";
import { NativeProfileSource } from "../src/online/native-source.js";
import { OnlineUI } from "../src/online/ui.js";
import { OnlinePrediction } from "../src/online/prediction.js";
import { skillImpulseFor } from "../src/online/optimistic-skill.js";
import { createSimulation } from "../src/physics/simulation.js";
import {
  captureMotion,
  createHeldInput,
  stepMotion,
} from "../../shared/motion.js";
import { SkillWorldController } from "../src/skills/skill-world-controller.js";
import { loadContent } from "../../server/src/content.js";
const content = await loadContent();
const original = { globals: (await content.map(10000)).physics.globals };

function fixture() {
  const simulation = createSimulation(
    {
      schemaVersion: 1,
      globals: original.globals,
      map: {},
      ladders: [],
      footholds: [
        {
          id: 1,
          layer: 1,
          group: 0,
          x1: -2000,
          y1: 0,
          x2: 2000,
          y2: 0,
          prev: 0,
          next: 0,
          properties: {},
        },
      ],
    },
    { x: 0, y: -100 },
  );
  const prediction = new OnlinePrediction();
  prediction.install(simulation, 10);
  const profile = { hp: 100, mp: 100, skills: { 4111006: { level: 20 } } };
  const catalog = {
    ui: { skills: { 4111006: { levels: { 20: { mpCon: 13 } } } } },
  };
  const scene = { simulation };
  let resolve;
  const response = new Promise((done) => {
    resolve = done;
  });
  const ui = Object.assign(Object.create(OnlineUI.prototype), {
    state: {
      presentation: { profile, stats: {} },
      revisions: { character: 0, inventory: 0 },
    },
    ui: { status: fail },
    catalog,
    hooks: { scene: () => ({ scene }), prediction },
    blocked: () => false,
    command: () => response,
  });
  ui.store = new NativeProfileSource(ui);
  return {
    simulation,
    prediction,
    profile,
    catalog,
    scene,
    ui,
    resolve,
    response,
  };
}

test("native online skill reads the live nested scene and moves before its receipt", async () => {
  const f = fixture();
  expect(f.ui.cast(4111006)).toBe(true);
  expect(f.simulation.vx).toBe(550);
  expect(f.simulation.vy).toBe(-350);
  expect(f.prediction.pendingImpulses).toHaveLength(1);
  f.resolve({ status: "committed" });
  await f.response;
  f.prediction.applyDiverts([
    { source: "skill", skillId: 4111006, vx: 550, vy: -350 },
  ]);
  expect(f.simulation.vx).toBe(550);
  expect(f.prediction.pendingImpulses).toHaveLength(0);
});

test("grounded, locked or exhausted casts do not inject a speculative jump", () => {
  const f = fixture();
  f.simulation.state = "ground";
  expect(skillImpulseFor(f.profile, f.catalog, f.scene, 4111006)).toBeNull();
  f.simulation.state = "air";
  f.simulation.movementLocked = true;
  expect(f.ui.optimisticImpulse(4111006)).toBeNull();
  f.simulation.movementLocked = false;
  f.profile.mp = 0;
  expect(f.ui.optimisticImpulse(4111006)).toBeNull();
});

test("repeating Flash Jump in the same airborne interval never restarts the arc", () => {
  const f = fixture();
  f.ui.cast(4111006);
  f.simulation.vx = 400;
  f.simulation.vy = 30;
  const before = captureMotion(f.simulation);
  f.ui.cast(4111006);
  expect(captureMotion(f.simulation)).toEqual(before);
  f.prediction.applyDiverts([
    { source: "skill", skillId: 4111006, vx: 550, vy: -350 },
  ]);
  f.ui.cast(4111006);
  expect(captureMotion(f.simulation)).toEqual(before);
});

test("a delayed refusal cannot restore motion from a departed field", () => {
  const f = fixture();
  const token = f.prediction.beginOptimistic(
    f.ui.optimisticImpulse(4111006),
    4111006,
  );
  f.prediction.install(f.simulation, 100);
  f.simulation.x = 700;
  f.prediction.rejectOptimistic(token);
  expect(f.simulation.x).toBe(700);
});

test("a landing during a paused skill clock still permits Flash Jump on the next jump", () => {
  const f = fixture();
  const controller = Object.assign(
    Object.create(SkillWorldController.prototype),
    {
      system: { scene: f.scene, hooks: {} },
      visuals: { play() {} },
      flashUsed: false,
      flashJumpSequence: null,
      impulseCooldown: 0,
    },
  );
  controller.impulse(4111006, {}, 20);
  expect(controller.impulseError(4111006)).not.toBeNull();
  const input = createHeldInput();
  // A database transaction can suspend the skill clock while physics continues.
  for (let tick = 0; tick < 100 && f.simulation.state !== "ground"; tick++) {
    stepMotion(f.simulation, input);
  }
  expect(f.simulation.state).toBe("ground");
  expect(controller.impulseError(4111006)).not.toBeNull();
  input.jump = true;
  input.jumpPressed = true;
  stepMotion(f.simulation, input);
  expect(f.simulation.state).toBe("air");
  expect(controller.impulseError(4111006)).toBeNull();
  controller.impulse(4111006, {}, 20);
  expect(controller.impulseError(4111006)).not.toBeNull();
});

function fail(message) {
  throw new Error(message);
}
