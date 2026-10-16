import { MAX_EVENTS, RULESET } from "./ranking-rules.js";

const PENDING_KEY = "blockBlastPendingScoreV1";
const NAME_KEY = "blockBlastRankingName";
let run = null;
let pending = readStored(PENDING_KEY);
let period = "all";
let loadVersion = 0;
let lastFocus = null;

function readStored(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}
function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Gameplay still works without persistent storage. */ }
}
function removeStored(key) {
  try { localStorage.removeItem(key); } catch { /* A private browser may deny storage access. */ }
}
function hasPending() {
  return pending?.ruleset === RULESET && Array.isArray(pending.events) && Number.isSafeInteger(pending.score);
}
async function api(path, data) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...(data === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    }),
    signal: AbortSignal.timeout(15000),
  });
  let result;
  try { result = await response.json(); } catch { throw new Error("Rankings are unavailable on this host."); }
  if (!response.ok) {
    const error = new Error(result.error || "The request failed. Try again.");
    error.status = response.status;
    throw error;
  }
  return result;
}
async function acquireSession(target) {
  if (target.session) return target.session;
  if (!target.sessionPromise) {
    target.sessionPromise = api("/api/session", {}).then(session => {
      target.session = session;
      if (pending?.key === target.key) { pending.session = session; persistPending(); }
      return session;
    }).finally(() => { target.sessionPromise = null; });
  }
  return target.sessionPromise;
}
export function beginRankedRun() {
  run = { key: crypto.randomUUID(), events: [], session: null, sessionPromise: null, eligible: true };
  acquireSession(run).catch(() => { /* The session can be retried after the game ends. */ });
}
export function recordHand(pieces) {
  if (!run || !run.eligible) return;
  pieces.forEach((piece, slot) => { piece.rankingSlot = slot; });
  run.events.push(["deal", pieces.map(piece => piece.name)]);
  checkLength();
}
export function recordMove(piece, row, col) {
  if (!run || !run.eligible) return;
  run.events.push(["move", piece.rankingSlot, row, col]);
  checkLength();
}
function checkLength() {
  if (run.events.length > MAX_EVENTS) { run.eligible = false; run.events = []; }
}
export function endRankedRun(score) {
  if (!run?.eligible || score <= 0) return;
  pending = { key: run.key, ruleset: RULESET, events: run.events.slice(), score, session: run.session, submitted: false };
  persistPending();
  updateSubmitButton();
}
function persistPending() {
  if (pending) store(PENDING_KEY, pending);
}
function updateSubmitButton() {
  const button = document.getElementById("open-submit");
  if (button) button.disabled = !hasPending() || pending.submitted;
}
function setSubmissionStatus(text, error = false) {
  const element = document.getElementById("submission-status");
  element.textContent = text;
  element.classList.toggle("is-error", error);
}
function openDialog(showSubmit) {
  const dialog = document.getElementById("ranking-dialog");
  const panel = document.getElementById("submit-panel");
  panel.hidden = !showSubmit || !hasPending();
  if (!panel.hidden) {
    document.getElementById("finished-score").textContent = pending.score.toLocaleString();
    document.getElementById("player-name").value = readStored(NAME_KEY) || "";
    document.getElementById("submit-score").disabled = Boolean(pending.submitted);
    setSubmissionStatus(pending.submitted ? "Score submitted." : "");
  }
  lastFocus = document.activeElement;
  document.getElementById("gameCanvas").inert = true;
  dialog.showModal();
  loadRankings();
}
async function loadRankings() {
  const version = ++loadVersion;
  const summary = document.getElementById("ranking-summary");
  summary.textContent = "Loading rankings…";
  summary.classList.remove("is-error");
  const body = document.getElementById("ranking-entries");
  const mine = document.getElementById("my-ranking");
  body.replaceChildren();
  mine.hidden = true;
  try {
    const result = await api(`/api/leaderboard?period=${period}`);
    if (version !== loadVersion) return;
    summary.textContent = result.total ? `${result.total.toLocaleString()} ${result.total === 1 ? "player" : "players"} · Top 50` : "No scores yet. Be the first!";
    for (const entry of result.entries) {
      const row = document.createElement("tr");
      row.classList.toggle("is-you", entry.mine);
      for (const value of [`#${entry.rank}`, `${entry.name}${entry.mine ? " (you)" : ""}`, entry.score.toLocaleString()]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      body.append(row);
    }
    if (result.me) {
      mine.textContent = `Your rank: #${result.me.rank} · ${result.me.score.toLocaleString()} points`;
      mine.hidden = false;
    }
    document.getElementById("ranking-calendar").textContent =
      `Calendar: ${result.timezone}. Today starts at midnight; each week starts on Monday.`;
  } catch (error) {
    if (version !== loadVersion) return;
    summary.textContent = error.message;
    summary.classList.add("is-error");
  }
}
async function submitScore(event) {
  event.preventDefault();
  if (!hasPending() || pending.submitted) return;
  const target = pending;
  const name = document.getElementById("player-name").value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!name || Array.from(name).length > 20 || /[\p{Cc}\p{Cf}<>]/u.test(name)) {
    setSubmissionStatus("Use a name with 1–20 characters, without control characters or angle brackets.", true);
    return;
  }
  const button = document.getElementById("submit-score");
  const input = document.getElementById("player-name");
  button.disabled = true;
  input.disabled = true;
  setSubmissionStatus("Submitting your score…");
  try {
    if (target.session?.expiresAt < Date.now()) target.session = null;
    const session = await acquireSession(target);
    await api("/api/scores", {
      ruleset: RULESET, runId: session.runId, token: session.token,
      name, score: target.score, events: target.events,
    });
    target.submitted = true;
    target.events = [];
    store(NAME_KEY, name);
    removeStored(PENDING_KEY);
    updateSubmitButton();
    setSubmissionStatus("Score submitted! Your best score is shown in the rankings.");
    await loadRankings();
  } catch (error) {
    setSubmissionStatus(error.message, true);
    button.disabled = false;
    if (error.status === 410) { target.session = null; persistPending(); }
  } finally { input.disabled = false; }
}
export function initRankingUI() {
  const dialog = document.getElementById("ranking-dialog");
  document.getElementById("open-rankings").addEventListener("click", () => openDialog(false));
  document.getElementById("open-submit").addEventListener("click", () => openDialog(true));
  document.getElementById("close-rankings").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    document.getElementById("gameCanvas").inert = false;
    lastFocus?.focus({ preventScroll: true });
  });
  dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
  document.getElementById("score-form").addEventListener("submit", submitScore);
  document.getElementById("refresh-rankings").addEventListener("click", loadRankings);
  document.querySelectorAll("[data-period]").forEach(button => button.addEventListener("click", () => {
    period = button.dataset.period;
    document.querySelectorAll("[data-period]").forEach(tab => tab.setAttribute("aria-pressed", String(tab === button)));
    loadRankings();
  }));
  updateSubmitButton();
}
