import { expect, test } from "bun:test";
import { retainAttackInput, takeAttackInput } from "../src/attack-input.js";

function actor() {
  return { field: { tick: 100 }, attackEdges: [], receivedAttack: false };
}
function sample(attack, inputSeq, targetTick = 80) {
  return { attack, inputSeq, targetTick };
}

test("an expired movement sample preserves one attack through a bunched press/release", () => {
  const a = actor();
  retainAttackInput(a, sample(true, 1));
  retainAttackInput(a, sample(true, 2));
  retainAttackInput(a, sample(false, 3));
  expect(takeAttackInput(a)).toBe(false);
  a.field.tick++;
  expect(takeAttackInput(a)).toBe(true);
  expect(a.combatInputSeq).toBe(1);
  expect(takeAttackInput(a)).toBe(false);
});

test("future, ancient, overloaded and expired attack edges have explicit bounds", () => {
  const a = actor();
  retainAttackInput(a, sample(true, 1, 1000));
  retainAttackInput(a, sample(false, 2));
  retainAttackInput(a, sample(true, 3, 1));
  expect(a.attackEdges).toHaveLength(0);
  for (let i = 0; i < 8; i++) {
    retainAttackInput(a, sample(false, i * 2 + 4));
    retainAttackInput(a, sample(true, i * 2 + 5));
  }
  retainAttackInput(a, sample(false, 20));
  expect(() => retainAttackInput(a, sample(true, 21))).toThrow();
  a.field.tick = 1000;
  expect(takeAttackInput(a)).toBe(false);
});

test("queued attacks survive an active animation but their age never resets", () => {
  const a = actor();
  retainAttackInput(a, sample(true, 1, 99));
  retainAttackInput(a, sample(false, 2, 100));
  retainAttackInput(a, sample(true, 3, 101));
  a.field.tick = 110;
  expect(takeAttackInput(a, false)).toBe(false);
  expect(a.attackEdges).toHaveLength(2);
  expect(takeAttackInput(a, true)).toBe(true);
  expect(a.combatInputSeq).toBe(1);
  a.field.tick = 169;
  expect(takeAttackInput(a, true)).toBe(false);
  expect(a.attackEdges).toHaveLength(0);
});
