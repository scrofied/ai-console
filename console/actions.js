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
  const cc = $("composerCouncil");
  if (cc) cc.checked = !!(S.detail?.job?.councilOn ?? S.guard.councilDefault ?? true);
  const box = $("threadBody");
  box.scrollTop = box.scrollHeight;
  $("composerText").focus();
}

/* 多模态输入：两条入口（新任务 / 追问）各一条附件带。
 * 新任务的 job 还没建，先传到 tmp，服务端建对话时会挪进 Jxx 目录。 */
let newTray = null;
let followTray = null;
let newTrayFor = null;      // 记住绑在哪个 textarea 上：欢迎页重绘后要重绑
let followTrayFor = null;

function ensureTrays() {
  const nt = $("newText");
  if (nt && $("newAttachTray") && newTrayFor !== nt) {
    // 欢迎页每次重绘都是新元素，旧的监听器已经跟着旧节点一起没了
    newTray = createAttachTray({ input: nt, tray: "newAttachTray", pick: "newAttachBtn", job: () => "tmp" });
    newTrayFor = nt;
  }
  const ct = $("composerText");
  if (ct && $("composerAttachTray") && followTrayFor !== ct) {
    followTray = createAttachTray({ input: ct, tray: "composerAttachTray", pick: "composerAttachBtn", job: () => S.cur || "tmp" });
    followTrayFor = ct;
  }
}
ensureTrays();

const handlers = {
  "open-job": (el) => openJob(el.dataset.job),

  "fill-example": (el) => { const t = $("newText"); t.value = el.dataset.text; t.focus(); },

  "start-job": () => run(async () => {
    ensureTrays();
    const text = $("newText").value.trim();
    const files = newTray ? newTray.files() : [];
    if (text.length < 2 && !files.length) { toast("先写一句想让 AI 做什么，或者拖个文件进来", true); return; }
    if ("Notification" in window && Notification.requestPermission) {
      if (Notification.permission === "default") Notification.requestPermission();
    }
    const r = await api("/api/jobs", {
      text, files,
      auto: $("newAuto").checked,
      council: $("newCouncil") ? $("newCouncil").checked : undefined,
    });
    if (newTray) newTray.clear();
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
  "answer-round": (el) => run(async () => {
    const rid = el.dataset.round;
    const ta = document.querySelector('.q-text[data-q-round="' + rid + '"]');
    const text = (ta?.value || "").trim();
    if (text.length < 2) { toast("先把答案写一句", true); return; }
    await api(`/api/jobs/${S.cur}/round/${rid}/answer`, { text });
    await refresh();
  }),

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
  ensureTrays();
  const files = followTray ? followTray.files() : [];
  if ((text.length < 2 && !files.length) || !S.cur) return;
  await run(async () => {
    await api(`/api/jobs/${S.cur}/say`, {
      text, files,
      auto: $("composerAuto").checked,
      council: $("composerCouncil") ? $("composerCouncil").checked : undefined,
    });
    box.value = ""; growComposer();
    if (followTray) followTray.clear();
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
