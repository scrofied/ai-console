/* 把状态画成页面。所有内容都先转义；内容没变就不重绘，避免打字时被打断。 */

const ROLE_LABEL = { commander: "指挥官", worker: "干活", off: "未启用" };
const commanderKey = () => (Object.entries(S.workers).find(([, w]) => w.role === "commander") || ["codex"])[0];
const cmdName = () => (S.workers[commanderKey()] || {}).title || "指挥官";
const STATE_BADGE = {
  todo: ["idle", "排队中"], claimed: ["working", "干活中"], waiting: ["attention", "需手动触发"],
  done: ["working", "等待验收"], review: ["working", "验收中"], pass: ["done", "已完成"],
  fail: ["bad", "没通过"], human: ["attention", "需要你看看"],
};

const workerEntries = () => Object.entries(S.workers).filter(([, w]) => w.role === "worker" && w.canRun);
const workerTitles = () => workerEntries().map(([, w]) => w.title).join("、");

function badge(cls, text, spin) {
  return `<span class="badge ${cls}">${spin ? '<span class="spin"></span>' : ""}${esc(text)}</span>`;
}

function renderTeam() {
  const html = Object.entries(S.workers).map(([k, w]) => {
    const broken = !w.canRun;
    let cls = "ok", text = "待命";
    if (w.role === "off") { cls = "off"; text = "不用"; }
    else if (broken) { cls = "bad"; text = "没找到程序"; }
    else if (w.blockedSec > 0) { cls = "bad"; text = "暂停中（登录或额度问题）"; }
    else if (w.active) { cls = "work"; text = w.role === "commander" ? "指挥中" : "干活中"; }
    const reset = w.blockedSec > 0 ? ` <button data-act="reset-circuit">恢复</button>` : "";
    return `<span class="member ${cls}" title="${esc(w.blockedWhy || w.note || "")}"><span class="dot"></span><b>${esc(w.title)}</b><span class="role">${esc(ROLE_LABEL[w.role] || "")}${w.model ? " · " + esc(w.model) : ""}</span><span>${esc(text)}</span>${reset}</span>`;
  }).join("");
  if (html !== S.lastTeam) { $("team").innerHTML = html; S.lastTeam = html; }
  const workers = Object.values(S.workers).filter((w) => w.role === "worker" && w.canRun).map((w) => w.title);
  const sub = `你只管说需求，${cmdName()} 指挥${workers.length ? "，" + workers.join("、") + " 干活" : ""}`;
  if ($("brandSub").textContent !== sub) $("brandSub").textContent = sub;
  document.querySelectorAll(".cmd-name").forEach((el) => { el.textContent = cmdName(); });
}

function renderList() {
  const jobs = S.jobs.filter((j) => S.showArchived || !j.archived || j.id === S.cur);
  const html = !S.loaded ? '<div class="skel"></div><div class="skel"></div><div class="skel"></div>' : jobs.length ? jobs.map((j) => {
    const st = j.status || {};
    const cls = st.key === "working" ? "working" : st.key === "done" ? "done" : st.key === "attention" ? "attention" : "idle";
    const prog = j.total ? `${j.pass}/${j.total} 步` : "";
    const pct = j.total ? Math.round((j.pass / j.total) * 100) : 0;
    return `<div class="job ${j.id === S.cur ? "active" : ""}" data-act="open-job" data-job="${esc(j.id)}">
      <div class="job-title">${esc(j.title)}${j.archived ? "（已归档）" : ""}</div>
      <div class="job-meta">${st.label ? badge(cls, st.label, st.key === "working") : ""}<span>${esc(prog)}</span></div>
      ${j.total ? `<div class="bar ${cls}"><i style="width:${pct}%"></i></div>` : ""}
    </div>`;
  }).join("") : `<div class="job-empty">还没有任务<br>点上面的「新任务」开始</div>`;
  if (html !== S.lastList) { $("jobList").innerHTML = html; S.lastList = html; }
}

function renderWelcome() {
  const ex = ["做一个个人作品集网页", "调研三个竞品并写成一页对比表", "把 D 盘某个文件夹里的资料整理成目录", "写一个批量重命名图片的脚本"];
  $("welcome").innerHTML = `<div class="welcome-inner">
    <h1>你想让 AI 帮你做什么？</h1>
    <p class="lead">像聊天一样说一句话就行。${esc(cmdName())} 会把它拆成步骤，分给 ${esc(workerTitles() || "干活的 AI")} 去做，做完替你检查，结果都在这里。</p>
    <textarea id="newText" class="big-input" placeholder="比如：帮我做一个介绍公司的单页网页，要有首页大图、三个产品卡片和联系方式"></textarea>
    <div class="start-row">
      <button class="btn primary" data-act="start-job" style="font-size:18px;padding:12px 28px">开始</button>
      <span class="kbd-hint"><kbd>Ctrl</kbd> + <kbd>Enter</kbd> 也可以开始</span>
      <label class="auto-opt"><input type="checkbox" id="newAuto" checked> ${esc(cmdName())} 拆完后直接开工（不勾则先给你看方案）</label>
    </div>
    <div class="examples"><span>试试：</span>${ex.map((e) => `<button class="chip" data-act="fill-example" data-text="${esc(e)}">${esc(e)}</button>`).join("")}</div>
    <div class="steps">
      <div class="step"><div class="n">1</div><b>你说需求</b><span>一句话，想到什么说什么</span></div>
      <div class="step"><div class="n">2</div><b>${esc(cmdName())} 拆成步骤</b><span>分给合适的 AI 去做，你能看到每一步</span></div>
      <div class="step"><div class="n">3</div><b>做完自动检查</b><span>结果和文件直接出现在对话里</span></div>
    </div>
  </div>`;
}

function stepCard(c) {
  const [cls, label] = STATE_BADGE[c.state] || ["idle", c.label];
  const needOpen = ["human", "fail", "waiting"].includes(c.state);
  const open = S.open.has(c.id) || needOpen;
  const spin = cls === "working";
  let body = "";
  if (open) {
    const parts = [];
    if (c.running && c.live) parts.push(`<div class="live">${esc(c.live.text)}</div>`);
    if (c.state === "human" || c.state === "fail") {
      const tl = (c.timeline || [])[0] || "";
      parts.push(`<div class="err-box">${esc(tl.replace(/^-\s*/, "") || "这一步没能自动完成")}</div>`);
    }
    parts.push(`<h4>要做什么</h4><div class="txt">${esc(c.做什么)}</div>`);
    if (c.定义完成) parts.push(`<h4>做到什么算完成</h4><div class="txt">${esc(c.定义完成)}</div>`);
    if (c.artifacts.length) {
      parts.push(`<h4>产出文件</h4><div class="files">${c.artifacts.filter((f) => f.name !== "note.md").map((f) =>
        `<div class="file"><span class="nm">${esc(f.name)}</span><span class="sz">${f.dir ? "文件夹" : fmtSize(f.size)}</span>
        ${f.dir ? "" : `<button class="btn small" data-act="view-file" data-path="${esc(f.rel)}">查看</button>`}
        <button class="btn small" data-act="open-path" data-path="${esc(f.rel)}">打开位置</button></div>`).join("")}</div>`);
    }
    const noteFile = c.artifacts.find((f) => f.name === "note.md");
    if (noteFile) parts.push(`<div class="actions" style="margin-top:6px"><button class="btn small" data-act="view-file" data-path="${esc(noteFile.rel)}">看 ${esc(c.workerTitle)} 的说明（note.md）</button></div>`);
    if (c.review) {
      const v = (c.review.verdict || "").toLowerCase();
      const vt = v === "pass" ? "检查通过" : v === "fail" ? "检查没通过" : "检查后认为需要你确认";
      const lines = c.review.text.split("\n").map((x) => x.trim()).filter((x) => x && !/^VERDICT:/i.test(x));
      const bad = lines.filter((x) => /不通过/.test(x));
      const shown = v === "pass" ? [] : (bad.length ? bad : lines).slice(0, 4);
      const detail = lines.join("\n");
      parts.push(`<h4>${esc(c.review.by || "验收方")} 检查：${vt}（共 ${lines.length} 条）</h4>` +
        (shown.length ? `<div class="verdict ${esc(v)}">${esc(shown.join("\n"))}</div>` : "") +
        `<details class="more" data-more="${esc(c.id)}" ${S.more.has(c.id) ? "open" : ""}><summary>${v === "pass" ? "看每一条的检查依据" : "看完整检查记录"}</summary><div class="verdict">${esc(detail)}</div></details>`);
    }
    // 操作
    const acts = [];
    if (c.state === "waiting") {
      acts.push(`<button class="btn primary" data-act="copy-order" data-card="${esc(c.id)}">复制任务口令</button>`);
      acts.push(`<button class="btn" data-act="launch" data-worker="${esc(c.worker)}" data-card="${esc(c.id)}">打开 ${esc(c.workerTitle)}</button>`);
      acts.push(`<button class="btn" data-act="triggered" data-card="${esc(c.id)}">我已经粘贴过去了</button>`);
      acts.push(`<button class="btn" data-act="retry" data-card="${esc(c.id)}">让工作台自动重试</button>`);
    }
    if (c.state === "human" || c.state === "fail" || c.state === "pass") {
      const draft = S.fb[c.id] || "";
      parts.push(`<h4>${c.state === "pass" ? "不满意？写下哪里要改，让它重做" : "想给它补充说明再重试？（可不写）"}</h4><textarea class="fb" data-fb="${esc(c.id)}" rows="2" placeholder="比如：标题再短一点，不要用蓝色">${esc(draft)}</textarea>`);
      acts.push(`<button class="btn primary" data-act="retry" data-card="${esc(c.id)}">${c.state === "pass" ? "按意见重做" : "重试"}</button>`);
      if (c.state !== "pass") acts.push(`<button class="btn" data-act="approve" data-card="${esc(c.id)}">我看过了，算通过</button>`);
    }
    if (c.running) acts.push(`<button class="btn danger" data-act="abort" data-card="${esc(c.id)}">中止这一步</button>`);
    if (acts.length) parts.push(`<div class="actions">${acts.join("")}</div>`);
    body = `<div class="card-body${S.pulse === c.id ? " enter" : ""}">${parts.join("")}</div>`;
  }
  const flip = S.pulse === c.id ? (open ? " flip-open" : " flip-close") : "";
  const liveLine = !open && c.running && c.live ? `<div class="live" style="margin:0 16px 12px">${esc(c.live.text)}</div>` : "";
  return `<div class="card ${cls}">
    <div class="card-top" data-act="toggle-card" data-card="${esc(c.id)}">
      <span class="avatar ${esc(c.worker)}">${esc((c.workerTitle || "?")[0])}</span>
      <div class="ttl">${esc(c.title)} <span class="who">· ${esc(c.workerTitle)}</span></div>
      ${badge(cls, label, spin)}<span class="chev${flip}" style="${open ? "transform:rotate(180deg)" : ""}">▼</span>
    </div>${liveLine}${body}</div>`;
}

function draftCards(r) {
  const names = workerEntries();
  return `<div class="cards">${(r.cards || []).map((c, i) => {
    const cur = S.draftWorker?.[r.id + ":" + i] || c.worker;
    return `<div class="card"><div class="card-top" style="cursor:default">
      <div class="ttl">${i + 1}. ${esc(c.title)}</div>
      <select class="sel" data-act-change="draft-worker" data-round="${esc(r.id)}" data-idx="${i}">${names.map(([k, w]) => `<option value="${esc(k)}" ${k === cur ? "selected" : ""}>由 ${esc(w.title)} 做</option>`).join("")}</select>
    </div><div class="card-body"><div class="txt">${esc(c.做什么)}</div></div></div>`;
  }).join("")}</div>`;
}

function resultBlock(r, cards) {
  const mine = cards.filter((c) => (r.dispatched || []).includes(c.id));
  const files = [];
  for (const c of mine) for (const f of c.artifacts) if (f.name !== "note.md") files.push({ ...f, card: c });
  const head = r.ok ? "全部完成了" : "做完了，但有步骤没通过自动检查";
  return `<div class="result ${r.ok ? "" : "warn"}"><h3>${r.ok ? "✓ " : "! "}${head}</h3>
    ${files.length ? `<div class="files">${files.map((f) => `<div class="file"><span class="nm">${esc(f.card.workerTitle)} / ${esc(f.name)}</span><span class="sz">${f.dir ? "文件夹" : fmtSize(f.size)}</span>
      ${f.dir ? "" : `<button class="btn small" data-act="view-file" data-path="${esc(f.rel)}">查看</button>`}
      <button class="btn small" data-act="open-path" data-path="${esc(f.rel)}">打开位置</button></div>`).join("")}</div>` : "<div>没有生成文件，具体情况点开上面的步骤看。</div>"}
    <div class="actions"><span style="color:var(--tx2);font-size:15px">不满意？直接在下面输入框接着说，或者点开某一步写意见让它重做。</span></div></div>`;
}

function renderRound(r, d) {
  const live = d.planLive?.[r.id];
  const out = [`<div class="msg-user"><div class="bubble">${esc(r.text)}</div></div><div class="msg-time">${esc(r.at)}</div>`];
  let reply = "";
  const ck = commanderKey();
  const head = `<div class="reply-head"><span class="avatar ${esc(ck)}">${esc(cmdName()[0])}</span>${esc(cmdName())}</div>`;
  if (r.status === "planning") {
    reply = `<div class="reply">${head}${badge("working", "正在拆任务", true)}${live ? `<div class="live">${esc(live.text)}</div>` : ""}</div>`;
  } else if (r.status === "plan_failed") {
    const ws = workerEntries();
    reply = `<div class="reply">${head}<p>这次没拆成功。</p><div class="err-box">${esc(r.error || "未知原因")}</div>
      <div class="actions"><button class="btn primary" data-act="replan" data-round="${esc(r.id)}">让 ${esc(cmdName())} 再拆一次</button>
      ${ws.map(([k, w]) => `<button class="btn" data-act="direct" data-round="${esc(r.id)}" data-worker="${esc(k)}">不拆了，直接交给 ${esc(w.title)}</button>`).join("")}</div></div>`;
  } else if (r.status === "draft") {
    reply = `<div class="reply">${head}<p>${esc(r.summary || "我这样安排：")}</p>${draftCards(r)}
      <div class="actions"><button class="btn primary" data-act="dispatch" data-round="${esc(r.id)}">确认，开工</button>
      <button class="btn" data-act="replan" data-round="${esc(r.id)}">重新拆</button>
      <button class="btn danger" data-act="cancel-round" data-round="${esc(r.id)}">取消</button></div></div>`;
  } else if (r.status === "cancelled") {
    reply = `<div class="reply">${head}<p style="color:var(--tx3)">这一轮已取消。</p></div>`;
  } else {
    const mine = d.cards.filter((c) => (r.dispatched || []).includes(c.id));
    reply = `<div class="reply">${head}<p>${esc(r.summary || "已安排好，开始做：")}</p><div class="cards">${mine.map(stepCard).join("")}</div></div>`;
    if (r.status === "finished") reply += resultBlock(r, d.cards);
  }
  out.push(reply);
  return out.join("");
}

function renderThread() {
  const d = S.detail;
  if (!d) return;
  const st = d.status || {};
  const cls = st.key === "working" ? "working" : st.key === "done" ? "done" : st.key === "attention" ? "attention" : "idle";
  const head = `<h2>${esc(d.job.title)}</h2>${st.label ? badge(cls, st.label, st.key === "working") : ""}<span class="spacer"></span>
    <button class="btn small" data-act="rename">改名</button>
    <button class="btn small" data-act="archive">${d.job.archived ? "取消归档" : "归档"}</button>`;
  if (head !== S.lastHead) { $("threadHead").innerHTML = head; S.lastHead = head; }

  const body = d.job.rounds.map((r) => renderRound(r, d)).join("");
  const box = $("threadBody");
  const typing = document.activeElement && document.activeElement.matches && document.activeElement.matches(".fb,.sel");
  if (body !== S.lastBody && !typing) {
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    const prev = box.scrollTop;
    box.classList.toggle("settled", !(S.lastBody === "" && !S.quiet));
    box.innerHTML = body; S.lastBody = body;
    box.scrollTop = nearBottom ? box.scrollHeight : prev;
  }
  const last = d.job.rounds[d.job.rounds.length - 1];
  $("composerSend").disabled = !!last && last.status === "planning";
}

function renderAll() {
  renderTeam();
  renderList();
  const inJob = !!(S.cur && S.detail);
  $("welcome").classList.toggle("hidden", inJob);
  $("thread").classList.toggle("hidden", !inJob);
  $("composer").classList.toggle("hidden", !inJob);
  if (inJob) renderThread();
  else if (!$("welcome").innerHTML) renderWelcome();
}
