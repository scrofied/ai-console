/* 点击与输入。全部事件委托，页面重绘后依然有效。 */

function goWelcome() {
  S.cur = null; S.detail = null; S.lastBody = ""; S.lastHead = "";
  $("welcome").innerHTML = "";
  renderAll();
  $("newText")?.focus();
}

async function openJob(id) {
  S.cur = id; S.lastBody = ""; S.lastHead = ""; S.open = new Set();
  await refresh();
  const box = $("threadBody");
  box.scrollTop = box.scrollHeight;
  $("composerText").focus();
}

const handlers = {
  "open-job": (el) => openJob(el.dataset.job),

  "fill-example": (el) => { const t = $("newText"); t.value = el.dataset.text; t.focus(); },

  "start-job": () => run(async () => {
    const text = $("newText").value.trim();
    if (text.length < 2) { toast("先写一句想让 AI 做什么", true); return; }
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
    const r = await api("/api/jobs", { text, auto: $("newAuto").checked });
    await openJob(r.id);
  }),

  "toggle-card": (el) => {
    const id = el.dataset.card;
    if (S.open.has(id)) S.open.delete(id); else S.open.add(id);
    S.lastBody = ""; S.quiet = true; S.pulse = id;
    renderThread();
    S.quiet = false; S.pulse = null;
  },

  "dispatch": (el) => run(async () => {
    const d = S.detail, rid = el.dataset.round;
    const r = d.job.rounds.find((x) => x.id === rid);
    const cards = r.cards.map((c, i) => ({ ...c, worker: S.draftWorker?.[rid + ":" + i] || c.worker }));
    await api(`/api/jobs/${S.cur}/round/${rid}/dispatch`, { cards });
    await refresh();
  }),
  "replan": (el) => run(async () => { await api(`/api/jobs/${S.cur}/round/${el.dataset.round}/replan`, {}); await refresh(); }),
  "direct": (el) => run(async () => { await api(`/api/jobs/${S.cur}/round/${el.dataset.round}/direct`, { worker: el.dataset.worker }); await refresh(); }),
  "cancel-round": (el) => run(async () => { await api(`/api/jobs/${S.cur}/round/${el.dataset.round}/cancel`, {}); await refresh(); }),

  "retry": (el) => run(async () => {
    const id = el.dataset.card;
    const feedback = (S.fb[id] || "").trim();
    await api(`/api/card/${id}/retry`, { feedback });
    delete S.fb[id];
    toast("已重新派给它");
    await refresh();
  }),
  "approve": (el) => run(async () => {
    if (!confirm("确认你已经看过结果，直接算通过？")) return;
    await api(`/api/card/${el.dataset.card}/approve`, {});
    await refresh();
  }),
  "abort": (el) => run(async () => {
    if (!confirm("中止这一步？已经写出的文件会保留。")) return;
    await api(`/api/card/${el.dataset.card}/abort`, {});
    await refresh();
  }),
  "triggered": (el) => run(async () => { await api(`/api/card/${el.dataset.card}/triggered`, {}); await refresh(); }),
  "copy-order": (el) => run(async () => {
    const r = await api(`/api/card/${el.dataset.card}/order`);
    try { await navigator.clipboard.writeText(r.order); toast("口令已复制，粘贴给对应的 AI 工具"); }
    catch { openModal("手动复制下面的口令", r.order); }
  }),
  "launch": (el) => run(async () => {
    const r = await api("/api/launch", { worker: el.dataset.worker });
    toast(r.opened ? "已尝试打开" : (r.reason || "没打开"), !r.opened);
  }),

  "view-file": (el) => run(async () => {
    const r = await api("/api/file?path=" + encodeURIComponent(el.dataset.path));
    if (r.binary) { toast("这个文件不能直接预览，点「打开位置」", true); return; }
    openModal(r.name + (r.truncated ? "（只显示前 200KB）" : ""), r.text);
  }),
  "open-path": (el) => run(async () => { await api("/api/open", { path: el.dataset.path }); }),

  "rename": () => run(async () => {
    const t = prompt("给这个任务改个名字", S.detail.job.title);
    if (!t) return;
    await api(`/api/jobs/${S.cur}/rename`, { title: t });
    S.lastHead = ""; await refresh();
  }),
  "archive": () => run(async () => {
    const now = !S.detail.job.archived;
    await api(`/api/jobs/${S.cur}/archive`, { archived: now });
    if (now && !S.showArchived) goWelcome();
    await refresh();
  }),

  "open-settings": () => run(openSettings),
  "test-model": (el) => testModel(el.dataset.name),
  "use-rec": (el) => { SET.draft.models[el.dataset.name] = el.dataset.model; delete SET.result[el.dataset.name]; SET.lastHtml = ""; renderSettings(); },
  "reload-models": (el) => { delete SET.models[el.dataset.name]; fetch("/api/models/" + el.dataset.name).finally(() => loadModels(el.dataset.name)); },

  "reset-circuit": () => run(async () => { await api("/api/circuit/reset", {}); toast("已恢复，会重新尝试"); await refresh(); }),
};

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  if (el.dataset.act === "toggle-card" && e.target.closest("button,select,textarea")) return;
  const h = handlers[el.dataset.act];
  if (h) { e.stopPropagation(); h(el); }
});

document.addEventListener("toggle", (e) => {
  const d = e.target;
  if (d.matches && d.matches("details[data-more]")) { if (d.open) S.more.add(d.dataset.more); else S.more.delete(d.dataset.more); }
}, true);

document.addEventListener("change", (e) => {
  const el = e.target.closest("[data-act-change]");
  if (el && el.dataset.actChange === "draft-worker") {
    S.draftWorker = S.draftWorker || {};
    S.draftWorker[el.dataset.round + ":" + el.dataset.idx] = el.value;
  }
});

document.addEventListener("input", (e) => {
  const t = e.target;
  if (t.matches && t.matches("[data-fb]")) S.fb[t.dataset.fb] = t.value;
});

$("btnNew").onclick = goWelcome;
$("modalClose").onclick = () => $("modal").classList.add("hidden");
$("modal").onclick = (e) => { if (e.target.id === "modal") $("modal").classList.add("hidden"); };
$("showArchived").onchange = (e) => { S.showArchived = e.target.checked; S.lastList = ""; renderList(); };

async function sendFollowUp() {
  const box = $("composerText");
  const text = box.value.trim();
  if (text.length < 2 || !S.cur) return;
  await run(async () => {
    await api(`/api/jobs/${S.cur}/say`, { text, auto: $("composerAuto").checked });
    box.value = ""; growComposer();
    await refresh();
    const b = $("threadBody"); b.scrollTop = b.scrollHeight;
  });
}
$("composerSend").onclick = sendFollowUp;

function growComposer() {
  const t = $("composerText");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight + 2, 170) + "px";
}
$("composerText").addEventListener("input", growComposer);

const toBottom = $("toBottom");
$("threadBody").addEventListener("scroll", () => {
  const b = $("threadBody");
  toBottom.classList.toggle("show", b.scrollHeight - b.scrollTop - b.clientHeight > 260);
}, { passive: true });
toBottom.onclick = () => { const b = $("threadBody"); b.scrollTo({ top: b.scrollHeight, behavior: "smooth" }); };
$("composerText").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendFollowUp(); } });
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.target.id === "newText") { e.preventDefault(); handlers["start-job"](); }
  if (e.key === "Escape") { $("modal").classList.add("hidden"); closeSettings(); }
});

renderWelcome();
connectEvents();
refresh();
setInterval(refresh, 4000);
