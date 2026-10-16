import { RULESET } from "./ranking-rules.js";

export function validPending(item) {
  return item && item.ruleset === RULESET && typeof item.key === "string" &&
    Number.isSafeInteger(item.score) && item.score > 0 && Array.isArray(item.events) && item.events.length > 0;
}
export function queueBest(queue, item) {
  const result = queue.filter(validPending).filter(entry => entry.key !== item.key);
  const existing = result.find(entry => entry.day === item.day);
  if (existing && existing.score >= item.score) return result;
  const next = result.filter(entry => entry.day !== item.day);
  next.push(item);
  if (next.length <= 7) return next;
  const best = next.reduce((a, b) => a.score >= b.score ? a : b);
  const newest = next.filter(entry => entry !== best).sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 6);
  return [best, ...newest].sort((a, b) => a.finishedAt - b.finishedAt);
}
export function serializableQueue(queue) {
  return queue.filter(validPending).map(({ key, ruleset, events, score, session, finishedAt, day }) =>
    ({ key, ruleset, events, score, session, finishedAt, day }));
}
