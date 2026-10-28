import test from "node:test";
import assert from "node:assert/strict";
import { createRenderLoop } from "../src/render-loop.js";

function setup() {
  const pending = new Map();
  let id = 0, renders = 0, active = false, paused = false;
  const loop = createRenderLoop({
    render() { renders++; }, isAnimating: () => active, isPaused: () => paused,
    requestFrame(callback) { pending.set(++id, callback); return id; },
    cancelFrame(frame) { pending.delete(frame); },
  });
  return { loop, pending, get renders() { return renders; },
    set active(value) { active = value; }, set paused(value) { paused = value; },
    step() { const [key, fn] = pending.entries().next().value; pending.delete(key); fn(); },
  };
}

test("idle scenes stop drawing and pointer bursts share one frame", () => {
  const s = setup();
  for (let i = 0; i < 50; i++) s.loop.invalidate();
  assert.equal(s.pending.size, 1);
  s.step();
  assert.equal(s.renders, 1);
  assert.equal(s.pending.size, 0);
  s.loop.invalidate(); s.step();
  assert.equal(s.renders, 2);
  assert.equal(s.pending.size, 0);
});

test("effects keep drawing until settled; paused pages resume on invalidation", () => {
  const s = setup();
  s.active = true;
  s.loop.invalidate(); s.step(); s.step();
  assert.equal(s.renders, 2);
  assert.equal(s.pending.size, 1);
  s.paused = true; s.step();
  s.loop.invalidate();
  assert.equal(s.renders, 2);
  assert.equal(s.pending.size, 0);
  s.paused = false;
  s.loop.invalidate(); s.step();
  assert.equal(s.renders, 3);
  s.active = false; s.step();
  assert.equal(s.pending.size, 0);
  s.loop.dispose(); s.loop.invalidate();
  assert.equal(s.pending.size, 0);
});

test("finishing an animation draws its settled state before sleeping", () => {
  const pending = [];
  let active = true, draws = 0;
  const loop = createRenderLoop({
    render() { draws++; active = false; }, isAnimating: () => active, isPaused: () => false,
    requestFrame(callback) { pending.push(callback); return pending.length; }, cancelFrame() {},
  });
  loop.invalidate();
  pending.shift()();
  assert.equal(draws, 1);
  assert.equal(pending.length, 1);
  pending.shift()();
  assert.equal(draws, 2);
  assert.equal(pending.length, 0);
});
