import test from "node:test";
import assert from "node:assert/strict";
import { messages, resolveLanguage } from "../src/ranking-i18n.js";
import { queueBest, serializableQueue } from "../src/ranking-sync.js";
import { RULESET } from "../src/ranking-rules.js";

function pending(key, score, day, finishedAt = 1) {
  return { key, score, day, finishedAt, ruleset: RULESET, events: [["deal", ["DOT"]]], session: null };
}
test("all surrounding interface messages have English and Japanese translations", () => {
  assert.deepEqual(Object.keys(messages.en).sort(), Object.keys(messages.ja).sort());
  for (const [key, english] of Object.entries(messages.en)) {
    assert.ok(messages.ja[key].trim());
    assert.deepEqual(english.match(/\{\w+\}/g)?.sort() || [], messages.ja[key].match(/\{\w+\}/g)?.sort() || []);
  }
  assert.equal(resolveLanguage("auto", ["ja-JP", "en-US"]), "ja");
  assert.equal(resolveLanguage("en", ["ja-JP"]), "en");
  assert.equal(resolveLanguage("ja", ["en-US"]), "ja");
});
test("offline queue keeps a higher pending score and does not persist promises", () => {
  let queue = queueBest([], pending("high", 200, "2026-10-16"));
  queue = queueBest(queue, pending("low", 100, "2026-10-16"));
  assert.equal(queue.length, 1);
  assert.equal(queue[0].key, "high");
  queue = queueBest(queue, pending("higher", 300, "2026-10-16"));
  assert.equal(queue[0].key, "higher");
  queue = queueBest(queue, pending("next-day", 10, "2026-10-17"));
  assert.equal(queue.length, 2);
  queue[0].sessionPromise = Promise.resolve();
  assert.equal("sessionPromise" in serializableQueue(queue)[0], false);
  for (let i = 0; i < 20; i++) queue = queueBest(queue, pending(`later-${i}`, 1, `day-${i}`, i + 100));
  assert.equal(queue.length, 7);
  assert.ok(queue.some(item => item.score === 300));
});
