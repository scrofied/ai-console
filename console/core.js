/* 状态、请求、实时刷新 */
const S = {
  jobs: [], workers: {}, guard: {},
  cur: null,            // 当前对话号
  detail: null,         // 当前对话详情
  open: new Set(),      // 展开的步骤卡
  more: new Set(),      // 展开了「完整检查记录」的步骤卡
  fb: {},               // 各卡的「补充意见」草稿
  showArchived: false,
  loaded: false,        // 第一次拿到数据前，任务列表显示骨架
  pulse: null,          // 刚被点开/收起的步骤卡，用来播一次展开动画
  quiet: false,         // 本次重绘不要重播入场动画
  lastHead: "", lastBody: "", lastList: "", lastTeam: "",
};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, body) {
  const opt = body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const r = await fetch(path, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ("请求失败 " + r.status));
  return j;
}

let toastTimer = 0;
function toast(msg, bad) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (bad ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), bad ? 5000 : 2500);
}

async function run(fn) {
  try { return await fn(); }
  catch (e) { toast(e.message || String(e), true); }
}

let busy = false, again = false;
async function refresh() {
  if (busy) { again = true; return; }
  busy = true;
  try {
    const st = await api("/api/state");
    S.jobs = st.jobs; S.workers = st.workers; S.guard = st.guard; S.loaded = true;
    if (S.cur) {
      try { S.detail = await api("/api/jobs/" + S.cur); }
      catch { S.cur = null; S.detail = null; }
    }
    renderAll();
  } catch (e) {
    $("team").innerHTML = '<span class="member bad"><span class="dot"></span>工作台服务连不上，请确认它在运行</span>';
  } finally {
    busy = false;
    if (again) { again = false; setTimeout(refresh, 200); }
  }
}

let evTimer = 0;
function connectEvents() {
  const es = new EventSource("/api/events");
  es.onmessage = (m) => {
    let ev; try { ev = JSON.parse(m.data); } catch { return; }
    if (ev.type === "hello") return;
    if (ev.type === "round_done") notifyDone(ev);
    clearTimeout(evTimer);
    evTimer = setTimeout(refresh, 250);
  };
}

function notifyDone(ev) {
  if (document.hidden && "Notification" in window && Notification.permission === "granted") {
    new Notification(ev.ok ? "任务完成了" : "任务需要你看一眼", { body: "回到指挥台查看结果" });
  }
}

function openModal(title, text) {
  $("modalTitle").textContent = title;
  $("modalBody").textContent = text;
  $("modal").classList.remove("hidden");
}

function fmtSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

function ago(at) { return at || ""; }
