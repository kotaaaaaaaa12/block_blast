const LANGUAGE_KEY = "blockBlastLanguage";
export const messages = {
  en: {
    admin: "Admin", adminPassword: "Admin password", adminLogin: "Sign in", adminLogout: "Sign out",
    adminLoginNote: "Enter the admin password configured for this website. Sessions expire after two hours.",
    adminSigningIn: "Signing in…", adminSignedOut: "Signed out.",
    adminNote: "Each browser appears once. Open a player to edit daily records. All time and This week use the highest daily record in that period. Enter 0 to remove a daily record. A later game can set a new record.",
    adminSearch: "Player name", adminDay: "Date (optional)", adminSearchButton: "Search",
    adminPages: "Player pages", adminPrev: "Previous", adminNext: "Next",
    adminCount: "{count} players · Page {page} of {pages}", adminEmpty: "No matching records.",
    adminAccountSummary: "Best: {score} · {count} daily records",
    adminEdit: "Review", adminConfirm: "Confirm score change", adminCancel: "Cancel", adminSave: "Save changes",
    adminReview: "{name}\nDate: {day}\nScore: {before} → {after}\nThis changes the daily record used by the rankings.",
    adminRemoveReview: "{name}\nDate: {day}\nCurrent score: {before}\nThis removes this day's record from the rankings.",
    adminSaved: "Score saved. Rankings have been updated.", adminRemoved: "Daily record removed. Rankings have been updated.",
    "error.adminNotConfigured": "Admin access is not configured. Set the ADMIN_PASSWORD secret in your Cloudflare Worker settings.",
    "error.adminWrongPassword": "The admin password is incorrect.",
    "error.adminUnauthorized": "Your admin session has expired. Sign in again.",
    "error.adminRateLimited": "Too many sign-in attempts. Wait 15 minutes before trying again.",
    "error.adminInvalidScore": "Enter a whole number from 0 to 2,147,483,647.",
    "error.adminConflict": "This record changed or was removed. The list has been refreshed; review the latest record before saving again.",
    rankings: "Rankings", playerName: "Player name", close: "Close", community: "Community",
    language: "Language", auto: "Auto", english: "English", japanese: "日本語",
    period: "Ranking period", all: "All time", today: "Today", week: "This week",
    refresh: "Refresh", rank: "Rank", player: "Player", score: "Score", game: "Block Blast game",
    nameTitle: "Player name", nameLabel: "Display name", namePlaceholder: "Enter your name", saveName: "Save name",
    nameNote: "Your name is saved on this device. Finished games are uploaded automatically, and only a higher score replaces your best. Your name and score are public.",
    nameSaved: "Name saved. Your ranking name is up to date.", nameSaving: "Saving your name…",
    namePending: "Name saved on this device. It will sync when a connection is available.",
    loading: "Loading rankings…", empty: "No scores yet. Finish a game to join!",
    playerCount: "{count} players · Top 50", onePlayer: "1 player · Top 50", you: " (you)",
    myRank: "Your rank: #{rank} · {score} points", calendar: "Calendar: {zone}. Each day starts at midnight; weeks start on Monday.",
    japanTime: "Japan time", autoNote: "Games are saved automatically. Each device appears once with its best score for this period.",
    syncReady: "Finished games are saved automatically.", syncNeedName: "Set your name to save your scores automatically.",
    syncUploading: "Saving your score…", syncSaved: "Score synced. Your highest score is kept.",
    syncPending: "Your score is saved on this device and will retry automatically.", syncNamePending: "Your new name will sync automatically.",
    retry: "Retry now", syncTooLong: "This game's replay is too long to upload. Your local record is still saved.",
    storageUnavailable: "Browser storage is unavailable. Your name and unsent scores can only be kept for this visit.",
    "error.invalidPeriod": "Choose a valid ranking period.",
    "error.invalidName": "Use 1–20 characters without control characters or angle brackets.",
    "error.invalidRequest": "The request could not be read. Reload the page and try again.",
    "error.replayTooLarge": "This game's replay is too large to upload. Your local record is still saved.",
    "error.wrongOrigin": "Open the game website to save your score.",
    "error.rateLimited": "Too many requests. Your score will retry automatically later.",
    "error.invalidSession": "The game session could not be verified. Your score will retry with a new session.",
    "error.expiredSession": "The game session expired. Your score will retry with a new session.",
    "error.alreadySubmitted": "This game was already submitted with a different replay.",
    "error.invalidReplay": "The recorded moves and score could not be verified.",
    "error.unfinishedGame": "Finish the game before saving its score.",
    "error.unavailable": "Rankings are temporarily unavailable. Unsent records will retry automatically.",
    "error.network": "A connection could not be made. Unsent records will retry automatically.",
    "error.notFound": "The ranking API is unavailable. Check that the latest Worker is deployed.",
    "error.requestFailed": "The request failed. Please try again.",
  },
  ja: {
    admin: "管理", adminPassword: "管理パスワード", adminLogin: "ログイン", adminLogout: "ログアウト",
    adminLoginNote: "このサイトに設定された管理パスワードを入力してください。ログインの有効期限は2時間です。",
    adminSigningIn: "ログインしています…", adminSignedOut: "ログアウトしました。",
    adminNote: "同じブラウザは1人にまとめて表示します。プレイヤーを開くと日別記録を編集できます。総合・今週には、期間内で最も高い日別記録が表示されます。0を入力すると、その日の記録を削除します。その後のプレイで新しい記録が登録されることがあります。",
    adminSearch: "プレイヤー名", adminDay: "日付（任意）", adminSearchButton: "検索",
    adminPages: "プレイヤー一覧のページ", adminPrev: "前へ", adminNext: "次へ",
    adminCount: "プレイヤー{count}人・{page} / {pages}ページ", adminEmpty: "条件に合う記録がありません。",
    adminAccountSummary: "最高スコア：{score}・日別記録{count}件",
    adminEdit: "変更を確認", adminConfirm: "スコア変更の確認", adminCancel: "キャンセル", adminSave: "変更を保存",
    adminReview: "{name}\n日付：{day}\nスコア：{before} → {after}\nランキングの集計に使う日別記録を変更します。",
    adminRemoveReview: "{name}\n日付：{day}\n現在のスコア：{before}\nランキングから、この日の日別記録を削除します。",
    adminSaved: "スコアを保存し、ランキングに反映しました。", adminRemoved: "日別記録を削除し、ランキングに反映しました。",
    "error.adminNotConfigured": "管理パスワードが未設定です。CloudflareのWorker設定でSecret「ADMIN_PASSWORD」を設定してください。",
    "error.adminWrongPassword": "管理パスワードが正しくありません。",
    "error.adminUnauthorized": "管理ログインの有効期限が切れました。もう一度ログインしてください。",
    "error.adminRateLimited": "ログインの試行回数が多すぎます。15分待ってから試してください。",
    "error.adminInvalidScore": "0〜2,147,483,647の整数を入力してください。",
    "error.adminConflict": "この記録は更新または削除されました。一覧を更新したので、最新の記録を確認してから変更してください。",
    rankings: "ランキング", playerName: "名前", close: "閉じる", community: "コミュニティ",
    language: "言語", auto: "自動", english: "English", japanese: "日本語",
    period: "ランキングの集計期間", all: "総合", today: "今日", week: "今週",
    refresh: "更新", rank: "順位", player: "プレイヤー", score: "スコア", game: "Block Blastのゲーム画面",
    nameTitle: "プレイヤー名", nameLabel: "表示名", namePlaceholder: "名前を入力", saveName: "名前を保存",
    nameNote: "名前はこの端末に保存され、ゲーム終了時にスコアを自動送信します。最高記録を更新したときだけ順位に反映されます。名前とスコアは公開されます。",
    nameSaved: "名前を保存し、ランキングの名前も更新しました。", nameSaving: "名前を保存しています…",
    namePending: "名前を端末に保存しました。接続でき次第、自動で同期します。",
    loading: "ランキングを読み込んでいます…", empty: "まだ記録がありません。ゲームを終えて参加しましょう！",
    playerCount: "{count}人が参加・上位50人", onePlayer: "1人が参加・上位50人", you: "（自分）",
    myRank: "自分の順位：{rank}位・{score}点", calendar: "集計：{zone}。毎日0時に日付が変わり、週は月曜日に始まります。",
    japanTime: "日本時間", autoNote: "ゲーム終了時に自動で記録します。同じ端末は、各期間の最高スコアで1枠だけ表示されます。",
    syncReady: "ゲーム終了時にスコアを自動保存します。", syncNeedName: "名前を登録するとスコアを自動保存できます。",
    syncUploading: "スコアを保存しています…", syncSaved: "スコアを同期しました。最高記録を保持しています。",
    syncPending: "記録を端末に保存しました。接続でき次第、自動で再送します。", syncNamePending: "変更した名前は自動で同期します。",
    retry: "今すぐ再送", syncTooLong: "今回の配置履歴は長すぎるため送信できません。端末内の記録は保存されます。",
    storageUnavailable: "ブラウザに保存できません。名前と未送信の記録は、このページを開いている間だけ保持されます。",
    "error.invalidPeriod": "有効な集計期間を選んでください。",
    "error.invalidName": "名前は1〜20文字で、制御文字や山かっこを含めずに入力してください。",
    "error.invalidRequest": "リクエストを読み取れませんでした。ページを再読み込みして試してください。",
    "error.replayTooLarge": "今回の配置履歴は大きすぎるため送信できません。端末内の記録は保存されます。",
    "error.wrongOrigin": "ゲームのサイトを開いてスコアを保存してください。",
    "error.rateLimited": "通信回数が多いため、時間をおいて自動で再送します。",
    "error.invalidSession": "ゲームの確認情報を取得し直して再送します。",
    "error.expiredSession": "ゲームの確認情報が期限切れです。取得し直して再送します。",
    "error.alreadySubmitted": "このゲームには異なる配置履歴が送信済みです。",
    "error.invalidReplay": "配置履歴とスコアの整合性を確認できませんでした。",
    "error.unfinishedGame": "ゲーム終了後にスコアを保存できます。",
    "error.unavailable": "ランキングを一時的に利用できません。未送信の記録は自動で再送します。",
    "error.network": "接続できませんでした。未送信の記録は自動で再送します。",
    "error.notFound": "ランキングAPIが見つかりません。最新版のWorkerが公開されているか確認してください。",
    "error.requestFailed": "処理に失敗しました。もう一度試してください。",
  },
};
export function resolveLanguage(preference = "auto", languages = globalThis.navigator?.languages || ["en"]) {
  if (preference === "en" || preference === "ja") return preference;
  for (const language of languages) {
    const code = language.toLowerCase().split("-")[0];
    if (code === "ja" || code === "en") return code;
  }
  return "en";
}
let preference = "auto";
try { preference = localStorage.getItem(LANGUAGE_KEY) || "auto"; } catch {}
export function language() { return resolveLanguage(preference); }
export function t(key, params = {}) {
  const text = messages[language()][key] ?? messages.en[key] ?? messages[language()]["error.requestFailed"];
  return text.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ""));
}
export function number(value) { return new Intl.NumberFormat(language()).format(value); }
export function applyLanguage() {
  document.documentElement.lang = language();
  document.querySelectorAll("[data-i18n]").forEach(element => { element.textContent = t(element.dataset.i18n); });
  document.querySelectorAll("[data-i18n-aria]").forEach(element => { element.setAttribute("aria-label", t(element.dataset.i18nAria)); });
  document.querySelectorAll("[data-i18n-placeholder]").forEach(element => { element.placeholder = t(element.dataset.i18nPlaceholder); });
}
export function initLanguage(onChange) {
  const select = document.getElementById("ranking-language");
  select.value = ["auto", "en", "ja"].includes(preference) ? preference : "auto";
  select.addEventListener("change", () => {
    preference = select.value;
    try { localStorage.setItem(LANGUAGE_KEY, preference); } catch {}
    applyLanguage();
    onChange();
  });
  globalThis.addEventListener("languagechange", () => { if (preference === "auto") { applyLanguage(); onChange(); } });
  applyLanguage();
}
