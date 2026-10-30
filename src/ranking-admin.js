import { t, number } from "./ranking-i18n.js";

export function initAdminUI({ openDialog, onScoresChanged }) {
  const byId = id => document.getElementById(id);
  let status = { key: "", error: false };
  let page = 1, records = null, loadVersion = 0, pending = null, saving = false;
  let authenticated = false;
  let listFilters = null;
  let accountLabels = [];
  const expanded = new Set();
  const historyPages = new Map();
  function setStatus(key, error = false) { status = { key, error }; render(); }
  function render() {
    accountLabels.forEach(({ node, record }) => {
      node.textContent = t("adminAccountSummary", { score: number(record.score), count: number(record.recordCount) });
    });
    byId("admin-status").textContent = status.key ? t(status.key) : "";
    byId("admin-status").classList.toggle("is-error", status.error);
    byId("admin-summary").textContent = records ? t("adminCount", {
      count: number(records.total), page: number(records.page), pages: number(Math.max(1, Math.ceil(records.total / records.pageSize))),
    }) : "";
    if (pending) byId("admin-confirm-text").textContent = t(pending.score === 0 ? "adminRemoveReview" : "adminReview", {
      name: pending.name, day: pending.day, before: number(pending.expectedScore), after: number(pending.score),
    });
  }
  function showSession(value) {
    authenticated = value;
    byId("admin-login-form").hidden = value;
    byId("admin-editor").hidden = !value;
    if (!value) {
      records = null;
      accountLabels = [];
      expanded.clear(); historyPages.clear();
      loadVersion++;
      byId("admin-entries").replaceChildren();
      render();
    }
  }
  async function api(path, body) {
    let response;
    try {
      response = await fetch(`/api/admin/${path}`, { credentials: "same-origin", cache: "no-store",
        ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
      });
    } catch { throw Object.assign(new Error(), { code: "network" }); }
    const data = await response.json().catch(() => ({ code: "unavailable" }));
    if (!response.ok) {
      if (data.code === "adminUnauthorized") showSession(false);
      throw Object.assign(new Error(), { code: data.code || "requestFailed" });
    }
    return data;
  }
  function failure(error) { setStatus(`error.${error.code || "requestFailed"}`, true); }
  function element(tag, text) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function drawDailyRecord(record) {
      const form = element("form"); form.className = "admin-record";
      form.append(element("h3", record.day));
      const label = element("label", t("score")); label.dataset.i18n = "score";
      const input = element("input"); input.id = `admin-score-${record.playerId}-${record.day}`; input.className = "admin-score";
      input.type = "number"; input.inputMode = "numeric"; input.min = "0"; input.max = "2147483647";
      input.step = "1"; input.required = true; input.value = String(record.score);
      label.htmlFor = input.id;
      const row = element("div"); row.className = "submission-row";
      const button = element("button", t("adminEdit")); button.type = "submit"; button.dataset.i18n = "adminEdit";
      row.append(input, button); form.append(label, row);
      form.addEventListener("submit", event => {
        event.preventDefault();
        if (saving || !authenticated) return;
        const score = Number(input.value);
        if (!input.value.trim() || !Number.isSafeInteger(score) || score < 0 || score > 2147483647) {
          setStatus("error.adminInvalidScore", true); return;
        }
        pending = { ...record, expectedScore: record.score, score };
        render(); openDialog(byId("admin-confirm-dialog"), { stack: true });
      });
      return form;
  }
  async function loadHistory(account, list, version) {
    list.textContent = t("loading");
    const params = new URLSearchParams(listFilters);
    params.delete("view");
    params.set("playerId", account.playerId);
    params.set("page", String(historyPages.get(account.playerId) || 1));
    try {
      const data = await api(`scores?${params}`);
      if (!authenticated || version !== loadVersion || !list.isConnected) return;
      if (data.page > 1 && !data.entries.length) {
        historyPages.set(account.playerId, Math.max(1, Math.ceil(data.total / data.pageSize)));
        return loadHistory(account, list, version);
      }
      list.replaceChildren();
      data.entries.forEach(record => list.append(drawDailyRecord(record)));
      if (!data.total) list.textContent = t("adminEmpty");
      if (data.total > data.pageSize) {
        const nav = element("div"); nav.className = "admin-actions";
        for (const [offset, key] of [[-1, "adminPrev"], [1, "adminNext"]]) {
          const button = element("button", t(key)); button.type = "button"; button.dataset.i18n = key;
          button.disabled = offset < 0 ? data.page <= 1 : data.page * data.pageSize >= data.total;
          button.addEventListener("click", () => {
            historyPages.set(account.playerId, data.page + offset);
            loadHistory(account, list, version);
          });
          nav.append(button);
        }
        list.append(nav);
      }
    } catch (error) {
      if (error.code === "adminUnauthorized") { failure(error); return; }
      if (version === loadVersion && list.isConnected) {
        list.replaceChildren(element("p", t(`error.${error.code || "requestFailed"}`)));
        const retry = element("button", t("refresh")); retry.type = "button"; retry.dataset.i18n = "refresh";
        retry.addEventListener("click", () => loadHistory(account, list, version));
        list.append(retry);
      }
    }
  }
  async function drawRecords(version) {
    const list = byId("admin-entries");
    list.replaceChildren(); accountLabels = [];
    const loads = [];
    records.entries.forEach(record => {
      const account = element("details"); account.className = "admin-player";
      account.dataset.playerId = record.playerId;
      const summary = element("summary");
      const name = element("span", record.name); name.className = "admin-player-name";
      const identity = element("small", record.playerId.slice(-8));
      const meta = element("span"); meta.className = "admin-account-meta";
      accountLabels.push({ node: meta, record });
      summary.append(name, identity, meta);
      const history = element("div"); history.className = "admin-history";
      account.append(summary, history); list.append(account);
      let loaded = false;
      account.addEventListener("toggle", () => {
        if (account.open) {
          expanded.add(record.playerId);
          if (!loaded) { loaded = true; loadHistory(record, history, version); }
        } else expanded.delete(record.playerId);
      });
      if (expanded.has(record.playerId)) {
        loaded = true; account.open = true;
        loads.push(loadHistory(record, history, version));
      }
    });
    byId("admin-prev").disabled = records.page <= 1;
    byId("admin-next").disabled = records.page * records.pageSize >= records.total;
    render();
    await Promise.all(loads);
  }
  async function load() {
    const version = ++loadVersion;
    setStatus("loading");
    const params = new URLSearchParams({ view: "players", period: byId("admin-period").value,
      search: byId("admin-search").value, day: byId("admin-day").value, page: String(page) });
    try {
      const data = await api(`scores?${params}`);
      if (version !== loadVersion || !authenticated) return;
      if (page > 1 && !data.entries.length) { page = Math.max(1, Math.ceil(data.total / data.pageSize)); return load(); }
      records = data; listFilters = params;
      await drawRecords(version);
      if (version === loadVersion && authenticated) setStatus(data.total ? "" : "adminEmpty");
    } catch (error) { if (version === loadVersion || error.code === "adminUnauthorized") failure(error); }
  }
  byId("open-admin").addEventListener("click", async () => {
    openDialog(byId("admin-dialog"), { stack: true }); setStatus("loading");
    try {
      const session = await api("session"); showSession(session.authenticated);
      if (!session.configured) setStatus("error.adminNotConfigured", true);
      else if (session.authenticated) await load();
      else setStatus("adminLoginNote");
    } catch (error) { failure(error); }
  });
  byId("admin-login-form").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button"); button.disabled = true;
    setStatus("adminSigningIn");
    try {
      await api("login", { password: byId("admin-password").value });
      byId("admin-password").value = ""; showSession(true); page = 1; await load();
    } catch (error) { failure(error); }
    finally { button.disabled = false; }
  });
  byId("admin-logout").addEventListener("click", async () => {
    try { await api("logout", {}); showSession(false); setStatus("adminSignedOut"); }
    catch (error) { failure(error); }
  });
  byId("admin-filter").addEventListener("submit", event => { event.preventDefault(); page = 1; load(); });
  byId("admin-prev").addEventListener("click", () => { page = Math.max(1, page - 1); load(); });
  byId("admin-next").addEventListener("click", () => { page++; load(); });
  byId("admin-confirm-dialog").addEventListener("close", () => { pending = null; });
  byId("admin-dialog").addEventListener("close", () => { byId("admin-password").value = ""; });
  byId("admin-confirm-save").addEventListener("click", async () => {
    if (!pending || saving) return;
    saving = true;
    const edit = pending;
    byId("admin-confirm-save").disabled = true;
    try {
      await api("scores", edit);
      byId("admin-confirm-dialog").close();
      await load();
      if (authenticated) setStatus(edit.score === 0 ? "adminRemoved" : "adminSaved");
      onScoresChanged();
    } catch (error) {
      byId("admin-confirm-dialog").close();
      if (error.code === "adminConflict") await load();
      failure(error);
    } finally { saving = false; byId("admin-confirm-save").disabled = false; }
  });
  return { render };
}
