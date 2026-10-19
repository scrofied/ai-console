/* 流程模板 —— 把已经跑通的人工分工固定下来：每步给哪个 AI、做什么、什么算完成。
 * 数据走 /api/flows（读/存）、/api/flows/run（按模板直接开工，不经过拆单）。
 * 依赖 core.js 的 $ / esc / api / toast。
 */
const FL = {
  open: false,
  flows: [],          // 服务端返回的流程（含 workerTitle/workerOk）
  tools: [],
  selected: null,     // 当前流程 id
  draft: null,        // 可编辑副本数组
  expanded: null,     // 展开编辑的步骤 key
  dirty: false,
};

async function openFlows() {
  FL.open = true;
  $("flows").classList.remove("hidden");
  $("flowsBody").innerHTML = '<div class="fl-loading">正在读取流程…</div>';
  await loadFlows();
}

function closeFlows() {
  FL.open = false;
  $("flows").classList.add("hidden");
  FL.dirty = false;
}

async function loadFlows() {
  try {
    const d = await api("/api/flows");
    FL.flows = d.flows || [];
    FL.tools = d.tools || [];
  } catch (e) {
    $("flowsBody").innerHTML = `<div class="fl-loading bad">读取失败：${esc(e.message)}</div>`;
    return;
  }
  FL.draft = JSON.parse(JSON.stringify(FL.flows));
  if (!FL.selected || !FL.draft.some((f) => f.id === FL.selected)) FL.selected = FL.draft[0]?.id || null;
  renderFlows();
}

function currentFlow() { return FL.draft?.find((f) => f.id === FL.selected) || null; }

function renderFlows() {
  if (!FL.draft) return;
  const flow = currentFlow();
  const listHtml = FL.draft.map((f) => `
    <button class="fl-item ${f.id === FL.selected ? "on" : ""}" data-flow="${esc(f.id)}">
      <b>${esc(f.name || f.id)}</b>
      <span>${f.steps.length} 步 · ${esc((f.steps.map((s) => s.worker).join(" → ")))}</span>
    </button>`).join("") || '<div class="fl-empty">还没有流程</div>';

  $("flowsBody").innerHTML = `
    <div class="fl-wrap">
      <aside class="fl-side">
        <div class="fl-side-head">我的流程</div>
        ${listHtml}
        <button class="btn small" id="flNew">＋ 新建流程</button>
      </aside>
      <section class="fl-main">
        ${flow ? renderFlow(flow) : '<div class="fl-empty">左边新建一个流程开始</div>'}
      </section>
    </div>
    <div class="fl-foot">
      <span class="fl-hint" id="flHint">${FL.dirty ? "有改动未保存" : ""}</span>
      <span class="spacer"></span>
      <button class="btn small" id="flCancel">关闭</button>
      <button class="btn small" id="flSave">保存流程</button>
      <button class="btn primary small" id="flRun" ${flow ? "" : "disabled"}>用这个流程开工</button>
    </div>`;

  bindFlows();
}

function renderFlow(flow) {
  const steps = flow.steps || [];
  const rows = steps.map((s, i) => {
    const w = resolveFlowWorker(s.worker);
    const open = FL.expanded === s.key;
    const depChips = (s.deps || []).map((d) => `<span class="fl-dep">${esc(d)}</span>`).join("") || '<span class="fl-dep none">无依赖</span>';
    const depsOptions = steps.slice(0, i).map((p) => `
      <label class="fl-depchk"><input type="checkbox" data-dep-of="${esc(s.key)}" value="${esc(p.key)}"
        ${(s.deps || []).includes(p.key) ? "checked" : ""}> ${esc(p.title || p.key)}</label>`).join("") || '<span class="fl-hint">这是第一步</span>';
    return `
      <div class="fl-step ${open ? "open" : ""}">
        <div class="fl-rail">
          <span class="fl-idx ${esc(w)}">${i + 1}</span>
          ${i < steps.length - 1 ? '<span class="fl-line"></span>' : ""}
        </div>
        <div class="fl-card">
          <div class="fl-card-head" data-step-toggle="${esc(s.key)}">
            <b class="fl-title">${esc(s.title || s.key)}</b>
            <span class="fl-ai ${esc(w)}">${esc(FL.tools.find((t) => t.name === w)?.title || w)}</span>
            ${FL.tools.find((t) => t.name === w)?.ok === false ? '<span class="fl-warn">工具不可用</span>' : ""}
            <span class="spacer"></span>
            <span class="fl-deps">${depChips}</span>
            <span class="fl-chev">${open ? "▾" : "▸"}</span>
          </div>
          ${open ? `
          <div class="fl-card-body">
            <label class="fl-field">这一步叫什么
              <input data-fld="title" data-step="${esc(s.key)}" value="${esc(s.title || "")}" maxlength="40">
            </label>
            <label class="fl-field">由哪个 AI 干
              <select data-fld="worker" data-step="${esc(s.key)}">
                ${FL.tools.map((t) => `<option value="${esc(t.name)}" ${w === t.name ? "selected" : ""}>${esc(t.title)}${t.role === "commander" ? "（指挥官）" : ""}${t.ok ? "" : " · 不可用"}</option>`).join("")}
              </select>
            </label>
            <div class="fl-field">这一步要等谁先完成
              <div class="fl-depbox">${depsOptions}</div>
            </div>
            <label class="fl-field">做什么（越具体越好）
              <textarea data-fld="do" data-step="${esc(s.key)}" rows="5">${esc(s.do || "")}</textarea>
            </label>
            <label class="fl-field">参照物（可空）
              <input data-fld="reference" data-step="${esc(s.key)}" value="${esc(s.reference || "")}">
            </label>
            <label class="fl-field">不要什么（禁止方向）
              <textarea data-fld="avoid" data-step="${esc(s.key)}" rows="3">${esc(s.avoid || "")}</textarea>
            </label>
            <label class="fl-field">什么算完成（一条一行，验收方只按这几条判）
              <textarea data-fld="done_when" data-step="${esc(s.key)}" rows="4">${esc(s.done_when || "")}</textarea>
            </label>
            <div class="fl-row">
              <button class="btn small danger" data-step-del="${esc(s.key)}">删除这一步</button>
            </div>
          </div>` : ""}
        </div>
      </div>`;
  }).join("");

  return `
    <div class="fl-head">
      <label class="fl-field inline">流程名
        <input data-flow-fld="name" value="${esc(flow.name || "")}" maxlength="24" id="flNameInput">
      </label>
      <span class="spacer"></span>
      <button class="btn small danger" id="flDelFlow">删除这个流程</button>
    </div>
    <label class="fl-field">一句话说明（会自动作为开工时的默认目标）
      <input data-flow-fld="desc" value="${esc(flow.desc || "")}" maxlength="120">
    </label>
    <div class="fl-pipe">${rows || '<div class="fl-empty">还没有步骤，点下面加一步</div>'}</div>
    <button class="btn small" id="flAddStep">＋ 加一步</button>`;
}

function resolveFlowWorker(w) {
  const n = String(w || "");
  if (n === "self" || /指挥官/.test(n)) {
    const cmd = FL.tools.find((t) => t.role === "commander");
    return cmd ? cmd.name : n;
  }
  return n;
}

function bindFlows() {
  document.querySelectorAll("[data-flow]").forEach((b) => {
    b.onclick = () => { FL.selected = b.dataset.flow; FL.expanded = null; renderFlows(); };
  });
  document.querySelectorAll("[data-step-toggle]").forEach((b) => {
    b.onclick = (e) => {
      // 点复选框/输入框时不要收起
      if (e.target.closest("input,select,textarea,button")) return;
      const k = b.dataset.stepToggle;
      FL.expanded = FL.expanded === k ? null : k;
      renderFlows();
    };
  });

  const flow = currentFlow();
  if (flow) {
    document.querySelectorAll("[data-flow-fld]").forEach((el) => {
      el.oninput = () => { flow[el.dataset.flowFld] = el.value; FL.dirty = true; markDirty(); };
    });
    document.querySelectorAll("[data-fld]").forEach((el) => {
      const s = flow.steps.find((x) => x.key === el.dataset.step);
      if (!s) return;
      el.oninput = el.onchange = () => { s[el.dataset.fld] = el.value; FL.dirty = true; markDirty(); };
    });
    document.querySelectorAll("[data-dep-of]").forEach((el) => {
      const s = flow.steps.find((x) => x.key === el.dataset.depOf);
      if (!s) return;
      el.onchange = () => {
        s.deps = s.deps || [];
        if (el.checked) { if (!s.deps.includes(el.value)) s.deps.push(el.value); }
        else s.deps = s.deps.filter((d) => d !== el.value);
        FL.dirty = true; markDirty(); renderFlows();
      };
    });
    document.querySelectorAll("[data-step-del]").forEach((b) => {
      b.onclick = () => {
        const k = b.dataset.stepDel;
        flow.steps = flow.steps.filter((x) => x.key !== k);
        // 顺手清掉别处对它的依赖
        flow.steps.forEach((x) => { x.deps = (x.deps || []).filter((d) => d !== k); });
        FL.expanded = null; FL.dirty = true; renderFlows();
      };
    });
    const addStep = $("flAddStep");
    if (addStep) addStep.onclick = () => addStepTo(flow);
    const del = $("flDelFlow");
    if (del) del.onclick = () => {
      FL.draft = FL.draft.filter((f) => f.id !== flow.id);
      FL.selected = FL.draft[0]?.id || null; FL.dirty = true; renderFlows();
    };
  }

  const nw = $("flNew");
  if (nw) nw.onclick = () => newFlow();
  const cancel = $("flCancel");
  if (cancel) cancel.onclick = () => closeFlows();
  const save = $("flSave");
  if (save) save.onclick = () => saveFlows2();
  const runBtn = $("flRun");
  if (runBtn) runBtn.onclick = () => runFlow();
}

function markDirty() {
  const h = $("flHint");
  if (h) h.textContent = "有改动未保存";
}

function addStepTo(flow) {
  if (flow.steps.length >= 12) return toast("一个流程最多 12 步", true);
  let i = flow.steps.length + 1;
  let key = `s${i}`;
  while (flow.steps.some((s) => s.key === key)) { i++; key = `s${i}`; }
  const prev = flow.steps[flow.steps.length - 1];
  const w = FL.tools.find((t) => t.ok)?.name || "codex";
  flow.steps.push({
    key, title: `第 ${flow.steps.length + 1} 步`, worker: w,
    mode: "serial", deps: prev ? [prev.key] : [],
    do: "", reference: "", avoid: "", done_when: "- [ ] 产出放在你的产出目录里\n- [ ] note.md 用 3 行说明做了什么 / 卡在哪 / 不确定的点",
  });
  FL.expanded = key; FL.dirty = true; renderFlows();
}

function newFlow() {
  if (FL.draft.length >= 20) return toast("流程最多 20 个", true);
  let i = 1;
  while (FL.draft.some((f) => f.id === `flow${i}`)) i++;
  const id = `flow${i}`;
  const f = { id, name: `新流程 ${i}`, desc: "", steps: [] };
  FL.draft.push(f);
  FL.selected = id; FL.expanded = null; FL.dirty = true;
  renderFlows();
  toast("新建了流程，给它起名、加步骤");
}

async function saveFlows2() {
  const payload = {
    flows: FL.draft.map((f) => ({
      id: f.id,
      name: String(f.name || f.id).trim(),
      desc: String(f.desc || "").trim(),
      steps: (f.steps || []).map((s) => ({
        key: String(s.key || "").trim(),
        title: String(s.title || s.key).trim(),
        worker: resolveFlowWorker(s.worker),
        mode: ["self", "parallel", "serial"].includes(String(s.mode)) ? String(s.mode) : "serial",
        deps: Array.isArray(s.deps) ? s.deps : [],
        do: String(s.do || ""),
        reference: String(s.reference || ""),
        avoid: String(s.avoid || ""),
        done_when: String(s.done_when || ""),
      })),
    })),
  };
  const hint = $("flHint");
  if (hint) hint.textContent = "保存中…";
  try {
    const r = await api("/api/flows", payload);
    FL.dirty = false;
    if (hint) hint.textContent = `已保存 ${r.flows} 个流程`;
    toast("流程已保存");
    await loadFlows();
  } catch (e) {
    if (hint) hint.textContent = "";
    toast("保存失败：" + e.message, true);
  }
}

function runFlow() {
  const flow = currentFlow();
  if (!flow) return;
  if (FL.dirty) return toast("先把流程保存了再开工", true);
  const box = $("flRunBox");
  if (box) { box.classList.add("show"); $("flRunText").value = flow.desc || ""; $("flRunText").focus(); }
}

async function doRunFlow() {
  const flow = currentFlow();
  if (!flow) return;
  const text = String($("flRunText")?.value || "").trim();
  if (text.length < 2) return toast("写一句这次要做什么", true);
  const btn = $("flRunGo");
  if (btn) { btn.disabled = true; btn.textContent = "派单中…"; }
  try {
    const r = await api("/api/flows/run", { flowId: flow.id, text });
    toast(`已按「${flow.name}」开工：${r.cards.length} 步`);
    closeFlows();
    if (typeof S !== "undefined") { S.cur = r.id; }
    if (typeof refresh === "function") await refresh();
  } catch (e) {
    toast("开工失败：" + e.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "确认开工"; }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const btn = $("btnFlows");
  if (btn) btn.onclick = () => openFlows();
  const close = $("flowsClose");
  if (close) close.onclick = () => closeFlows();
  const go = $("flRunGo");
  if (go) go.onclick = () => doRunFlow();
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && FL.open) closeFlows();
  });
});
