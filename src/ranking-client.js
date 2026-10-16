import { MAX_EVENTS, RULESET } from "./ranking-rules.js";
import { queueBest, serializableQueue, validPending } from "./ranking-sync.js";
import { initLanguage, t, number } from "./ranking-i18n.js";

const QUEUE_KEY = "blockBlastPendingScoresV2";
const LEGACY_KEY = "blockBlastPendingScoreV1";
const NAME_KEY = "blockBlastRankingName";
const NAME_SYNC_KEY = "blockBlastPendingName";
let playerName = normalizeName(readStored(NAME_KEY));
let dirtyName = normalizeName(readStored(NAME_SYNC_KEY)) || null;
const storedQueue = readStored(QUEUE_KEY);
let queue = (Array.isArray(storedQueue) ? storedQueue : []).filter(validPending);
const legacy = readStored(LEGACY_KEY);
if (legacy && !legacy.submitted && validPending(legacy)) {
  const finishedAt = legacy.finishedAt || Date.now();
  queue = queueBest(queue, { ...legacy, finishedAt, day: calendarDay(finishedAt) });
}
let run = null;
let identityPromise = null;
let profilePromise = null;
let flushPromise = null;
let retryTimer = null;
let retryDelay = 5000;
let nameRevision = 0;
let period = "all";
let loadVersion = 0;
let lastRanking = null;
let rankingError = null;
let rankingLoading = false;
let syncState = { key: playerName ? "syncReady" : "syncNeedName", error: false };
let profileState = { key: "", error: false };
let keyboardNavigation = false;
const focusOrigins = new WeakMap();

function readStored(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}
function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { setSync("storageUnavailable", true); return false; }
}
function removeStored(key) {
  try { localStorage.removeItem(key); } catch {}
}
function calendarDay(now = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
}
function normalizeName(value) {
  return typeof value === "string" ? value.normalize("NFKC").trim().replace(/\s+/gu, " ") : "";
}
function validName(value) {
  return value && Array.from(value).length <= 20 && !/[\p{Cc}\p{Cf}<>]/u.test(value);
}
function persistQueue() {
  if (store(QUEUE_KEY, serializableQueue(queue))) removeStored(LEGACY_KEY);
}
function failure(code, status = 0) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}
async function api(path, data) {
  let response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      ...(data === undefined ? {} : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch { throw failure("network"); }
  let result;
  try { result = await response.json(); } catch { throw failure("notFound", response.status); }
  if (!response.ok) throw failure(result.code || "requestFailed", response.status);
  return result;
}
function ensureIdentity() {
  if (!identityPromise) {
    identityPromise = api("/api/profile").catch(error => { identityPromise = null; throw error; });
  }
  return identityPromise;
}
async function synchronizeName() {
  if (profilePromise) return profilePromise;
  profilePromise = (async () => {
    const identity = await ensureIdentity();
    if (!dirtyName && playerName && (!identity.profileExists || identity.name !== playerName)) {
      dirtyName = playerName;
      store(NAME_SYNC_KEY, dirtyName);
    }
    while (dirtyName) {
      const name = dirtyName;
      const saved = await api("/api/profile", { name });
      identity.name = saved.name;
      identity.profileExists = true;
      if (dirtyName === name) { dirtyName = null; removeStored(NAME_SYNC_KEY); }
    }
  })().finally(() => { profilePromise = null; });
  return profilePromise;
}
async function acquireSession(target) {
  if (target.session && target.session.expiresAt > Date.now()) return target.session;
  if (!target.sessionPromise) {
    target.sessionPromise = (async () => {
      await ensureIdentity();
      target.session = await api("/api/session", {});
      persistQueue();
      return target.session;
    })().finally(() => { target.sessionPromise = null; });
  }
  return target.sessionPromise;
}
export function beginRankedRun() {
  run = { key: crypto.randomUUID(), events: [], session: null, eligible: true, finished: false };
  acquireSession(run).catch(() => { /* A finished game can acquire a session when the connection returns. */ });
}
export function recordHand(pieces) {
  if (!run || !run.eligible || run.finished) return;
  pieces.forEach((piece, slot) => { piece.rankingSlot = slot; });
  run.events.push(["deal", pieces.map(piece => piece.name)]);
  checkLength();
}
export function recordMove(piece, row, col) {
  if (!run || !run.eligible || run.finished) return;
  run.events.push(["move", piece.rankingSlot, row, col]);
  checkLength();
}
function checkLength() {
  if (run.events.length > MAX_EVENTS) { run.eligible = false; run.events = []; }
}
export function endRankedRun(score) {
  if (!run || run.finished || score <= 0) return;
  run.finished = true;
  if (!run.eligible) { setSync("syncTooLong", true); return; }
  const finishedAt = Date.now();
  queue = queueBest(queue, {
    key: run.key, ruleset: RULESET, events: run.events.slice(), score,
    session: run.session, finishedAt, day: calendarDay(finishedAt),
  });
  persistQueue();
  if (validName(playerName)) flushQueue();
  else {
    setSync("syncNeedName");
    setTimeout(() => { if (!validName(playerName)) openProfile(); }, 900);
  }
}
function setSync(key, error = false) {
  syncState = { key, error };
  renderStatus();
}
function setProfileStatus(key, error = false) {
  profileState = { key, error };
  renderStatus();
}
function renderStatus() {
  document.querySelectorAll("[data-sync-status]").forEach(element => {
    element.textContent = t(syncState.key);
    element.classList.toggle("is-error", syncState.error);
  });
  const status = document.getElementById("profile-status");
  if (status) { status.textContent = profileState.key ? t(profileState.key) : ""; status.classList.toggle("is-error", profileState.error); }
  const retry = document.getElementById("retry-sync");
  if (retry) retry.hidden = !queue.length && !dirtyName;
}
function scheduleRetry() {
  if (retryTimer || (!queue.length && !dirtyName) || !validName(playerName)) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    flushQueue();
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 60000);
}
function flushQueue() {
  if (flushPromise) return flushPromise;
  if (!validName(playerName)) { setSync("syncNeedName"); return Promise.resolve(); }
  flushPromise = (async () => {
    await synchronizeName();
    let uploaded = false;
    while (queue.length) {
      const target = queue[0];
      setSync("syncUploading");
      const session = await acquireSession(target);
      try {
        await api("/api/scores", {
          ruleset: RULESET, runId: session.runId, token: session.token,
          name: playerName, score: target.score, events: target.events,
        });
      } catch (error) {
        if (error.status === 401 || error.status === 410) { target.session = null; persistQueue(); }
        throw error;
      }
      queue = queue.filter(item => item.key !== target.key);
      persistQueue();
      uploaded = true;
    }
    retryDelay = 5000;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    setSync(uploaded ? "syncSaved" : "syncReady");
    if (document.getElementById("ranking-dialog")?.open) await loadRankings();
  })().catch(error => {
    setSync(`error.${error.code || "requestFailed"}`, true);
    scheduleRetry();
  }).finally(() => { flushPromise = null; });
  return flushPromise;
}
function openDialog(dialog) {
  if (dialog.open) return;
  document.querySelectorAll(".community-dialog[open]").forEach(other => other.close());
  focusOrigins.set(dialog, keyboardNavigation ? document.activeElement : null);
  document.getElementById("gameCanvas").inert = true;
  dialog.showModal();
  requestAnimationFrame(() => dialog.querySelector("h1").focus({ preventScroll: true }));
}
function openProfile() {
  const dialog = document.getElementById("profile-dialog");
  if (dialog.open) return;
  document.getElementById("player-name").value = playerName;
  setProfileStatus("");
  openDialog(dialog);
}
function openRankings() {
  openDialog(document.getElementById("ranking-dialog"));
  loadRankings();
}
function renderRankings() {
  const summary = document.getElementById("ranking-summary");
  const body = document.getElementById("ranking-entries");
  const mine = document.getElementById("my-ranking");
  if (!summary) return;
  summary.classList.toggle("is-error", Boolean(rankingError));
  summary.textContent = rankingLoading ? t("loading") : rankingError ? t(`error.${rankingError}`) :
    !lastRanking?.total ? t("empty") : lastRanking.total === 1 ? t("onePlayer") : t("playerCount", { count: number(lastRanking.total) });
  body.replaceChildren();
  mine.hidden = true;
  if (!rankingLoading && !rankingError && lastRanking) {
    for (const entry of lastRanking.entries) {
      const row = document.createElement("tr");
      row.classList.toggle("is-you", entry.mine);
      for (const value of [`#${number(entry.rank)}`, `${entry.name}${entry.mine ? t("you") : ""}`, number(entry.score)]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      body.append(row);
    }
    if (lastRanking.me) {
      mine.textContent = t("myRank", { rank: number(lastRanking.me.rank), score: number(lastRanking.me.score) });
      mine.hidden = false;
    }
  }
  const zone = lastRanking?.timezone || "Asia/Tokyo";
  document.getElementById("ranking-calendar").textContent = t("calendar", { zone: zone === "Asia/Tokyo" ? t("japanTime") : zone });
}
async function loadRankings() {
  const version = ++loadVersion;
  rankingLoading = true;
  rankingError = null;
  renderRankings();
  try {
    const result = await api(`/api/leaderboard?period=${period}`);
    if (version !== loadVersion) return;
    lastRanking = result;
  } catch (error) {
    if (version !== loadVersion) return;
    rankingError = error.code || "requestFailed";
  }
  if (version !== loadVersion) return;
  rankingLoading = false;
  renderRankings();
}
async function saveProfile(event) {
  event.preventDefault();
  const input = document.getElementById("player-name");
  const name = normalizeName(input.value);
  if (!validName(name)) { setProfileStatus("error.invalidName", true); return; }
  playerName = name;
  dirtyName = name;
  nameRevision += 1;
  input.value = name;
  store(NAME_KEY, name);
  store(NAME_SYNC_KEY, name);
  const button = document.getElementById("save-name");
  button.disabled = true;
  input.disabled = true;
  setProfileStatus("nameSaving");
  try {
    await synchronizeName();
    setProfileStatus("nameSaved");
    setSync("syncReady");
    await flushQueue();
    if (lastRanking) await loadRankings();
  } catch {
    setProfileStatus("namePending");
    setSync("syncNamePending");
    scheduleRetry();
  } finally { button.disabled = false; input.disabled = false; }
}
async function bootstrapProfile() {
  const revision = nameRevision;
  try {
    const identity = await ensureIdentity();
    if (revision === nameRevision && !dirtyName) {
      if ((identity.profileExists && identity.name) || (!playerName && identity.name)) {
        playerName = identity.name;
        store(NAME_KEY, playerName);
      }
      if (playerName && (!identity.profileExists || identity.name !== playerName)) {
        dirtyName = playerName;
        store(NAME_SYNC_KEY, dirtyName);
      }
    }
  } catch { /* A saved device name remains usable offline. */ }
  if (validName(playerName)) flushQueue();
  else { setSync("syncNeedName"); openProfile(); }
}
export function initRankingUI() {
  initLanguage(() => { renderStatus(); renderRankings(); });
  persistQueue();
  renderStatus();
  document.addEventListener("keydown", event => {
    if (event.key === "Tab" || event.key.startsWith("Arrow")) {
      keyboardNavigation = true;
      document.documentElement.dataset.keyboardNavigation = "true";
    }
  }, true);
  document.addEventListener("pointerdown", event => {
    keyboardNavigation = false;
    delete document.documentElement.dataset.keyboardNavigation;
    if (event.target.closest("button")) event.preventDefault();
  }, true);
  document.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (button && !keyboardNavigation) button.blur();
  });
  document.getElementById("ranking-language").addEventListener("change", event => {
    const select = event.currentTarget;
    if (!keyboardNavigation) {
      select.blur();
      // Native pickers can restore focus as they finish closing.
      requestAnimationFrame(() => {
        if (!keyboardNavigation && document.activeElement === select) select.blur();
      });
    }
  });
  document.getElementById("open-rankings").addEventListener("click", openRankings);
  document.getElementById("open-profile").addEventListener("click", openProfile);
  document.querySelectorAll("[data-close-dialog]").forEach(button => {
    button.addEventListener("click", () => button.closest("dialog").close());
  });
  document.querySelectorAll(".community-dialog").forEach(dialog => {
    dialog.addEventListener("close", () => {
      const activeDialog = document.querySelector(".community-dialog[open]");
      document.getElementById("gameCanvas").inert = Boolean(activeDialog);
      if (!activeDialog) {
        const origin = focusOrigins.get(dialog);
        if (keyboardNavigation && origin?.isConnected) origin.focus({ preventScroll: true });
        else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      }
    });
    dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
  });
  document.getElementById("profile-form").addEventListener("submit", saveProfile);
  document.getElementById("refresh-rankings").addEventListener("click", loadRankings);
  document.getElementById("retry-sync").addEventListener("click", flushQueue);
  document.querySelectorAll("[data-period]").forEach(button => button.addEventListener("click", () => {
    period = button.dataset.period;
    document.querySelectorAll("[data-period]").forEach(tab => tab.setAttribute("aria-pressed", String(tab === button)));
    loadRankings();
  }));
  window.addEventListener("online", () => { retryDelay = 5000; flushQueue(); });
  window.addEventListener("storage", event => {
    if (event.key === NAME_KEY || event.key === NAME_SYNC_KEY) {
      playerName = readStored(NAME_KEY) || "";
      dirtyName = readStored(NAME_SYNC_KEY) || null;
      nameRevision += 1;
      flushQueue();
    }
  });
  bootstrapProfile();
}
