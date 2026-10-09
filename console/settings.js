/* 设置面板：谁当指挥官、谁干活、每个工具用哪个模型。保存前先在本地改，点「保存」才生效。 */

const SET = { open: false, tools: [], draft: { roles: {}, models: {} }, models: {}, testing: {}, result: {} };

const ROLE_TEXT = { commander: "指挥官", worker: "干活", off: "不用" };

function cmdTitle() {
  const c = Object.entries(S.workers).find(([, w]) => w.role === "commander");
  return c ? c[1].title : "指挥官";
}

async function openSettings() {
  const s = await api("/api/settings");
  SET.tools = s.tools;
  SET.draft = { roles: {}, models: {} };
  for (const t of s.tools) { SET.draft.roles[t.name] = t.role; SET.draft.models[t.name] = t.model; }
  SET.result = {};
  SET.open = true;
  $("settings").classList.remove("hidden");
  renderSettings();
  for (const t of s.tools) loadModels(t.name);
}

function closeSettings() {
  SET.open = false;
  $("settings").classList.add("hidden");
}

async function loadModels(name) {
  SET.models[name] = { state: "loading", list: [] };
  renderSettings();
  try {
    const r = await api("/api/models/" + name);
    SET.models[name] = { state: "ok", list: r.models, info: r.info || {}, rec: r.recommended || "" };
  } catch (e) {
    SET.models[name] = { state: "fail", list: [], error: e.message };
  }
  if (SET.open) renderSettings();
}

function settingsProblems() {
  const roles = SET.draft.roles;
  const cmds = SET.tools.filter((t) => roles[t.name] === "commander");
  const workers = SET.tools.filter((t) => roles[t.name] === "worker" && t.canRun);
  const out = [];
  if (cmds.length === 0) out.push("还没选指挥官");
  if (cmds.length > 1) out.push("指挥官只能有一个");
  if (cmds.length === 1 && !cmds[0].canRun) out.push(cmds[0].title + " 在这台电脑上跑不起来，不能当指挥官");
  if (workers.length === 0) out.push("至少要有一个干活的 AI");
  return out;
}

function renderSettings() {
  if (!SET.open) return;
  const typing = document.activeElement && document.activeElement.matches && document.activeElement.matches("#settingsBody input");
  if (typing) return;
  const roles = SET.draft.roles;
  const rows = SET.tools.map((t) => {
    const m = SET.models[t.name] || { state: "loading", list: [] };
    const cur = SET.draft.models[t.name] || "";
    const inList = !cur || m.list.includes(cur);
    const opts = [`<option value="">默认（不指定）</option>`]
      .concat(m.list.map((x) => `<option value="${esc(x)}" title="${esc(x)}" ${x === cur ? "selected" : ""}>${x === m.rec ? "★ " : ""}${esc(m.info?.[x] || x)}</option>`))
      .concat(!inList ? [`<option value="${esc(cur)}" selected>${esc(cur)}（手填）</option>`] : []).join("");
    const res = SET.result[t.name];
    const modelStatus = m.state === "loading" ? "正在读取这个工具支持的模型……"
      : m.state === "fail" ? `读不到模型清单：${m.error}。可以在右边手填模型名。` : `读到 ${m.list.length} 个模型`;
    const disabled = !t.canRun ? "disabled" : "";
    const useRec = m.rec && cur !== m.rec && m.list.includes(m.rec)
      ? `<button class="btn small" data-act="use-rec" data-name="${esc(t.name)}" data-model="${esc(m.rec)}">用推荐：${esc(m.rec)}</button>` : "";
    const seg = ["commander", "worker", "off"].map((r) =>
      `<label class="seg ${roles[t.name] === r ? "on" : ""} ${r === "commander" && !t.canRun ? "dis" : ""}">
        <input type="radio" name="role-${esc(t.name)}" value="${r}" data-role="${esc(t.name)}" ${roles[t.name] === r ? "checked" : ""} ${r === "commander" && !t.canRun ? "disabled" : ""}>${ROLE_TEXT[r]}</label>`).join("");
    return `<div class="tool ${t.canRun ? "" : "tool-bad"}">
      <div class="tool-head"><span class="avatar ${esc(t.name)}">${esc(t.title[0])}</span><b>${esc(t.title)}</b>
        <span class="tool-sub">${esc((t.strengths || []).slice(0, 4).join("、"))}</span>
        ${t.canRun ? "" : '<span class="badge bad">本机没找到程序</span>'}</div>
      <div class="tool-row"><span class="lbl">担任</span><div class="segs">${seg}</div></div>
      <div class="tool-row"><span class="lbl">模型</span>
        <select class="sel wide" data-model-pick="${esc(t.name)}" ${disabled}>${opts}</select>
        ${m.state === "fail" ? `<input class="model-in" data-model-type="${esc(t.name)}" placeholder="读不到清单，手填模型名" value="${esc(cur)}" ${disabled}>` : ""}
        <button class="btn small" data-act="test-model" data-name="${esc(t.name)}" ${disabled || SET.testing[t.name] ? "disabled" : ""}>${SET.testing[t.name] ? "测试中…" : "测试一下"}</button>
        <button class="btn small ghost" data-act="reload-models" data-name="${esc(t.name)}" ${disabled}>刷新清单</button>${useRec}</div>
      <div class="tool-note">${esc(modelStatus)}${t.modelHint ? "　" + esc(t.modelHint) : ""}${!cur && t.defaultModel ? `　当前默认实际用：${esc(t.defaultModel)}` : ""}</div>
      ${res ? `<div class="test-res ${res.ok ? "ok" : "bad"}">${res.ok ? `✓ 能用，${(res.ms / 1000).toFixed(1)} 秒回复：${esc(res.text)}` : `✗ 不能用：${esc(res.error)}`}</div>` : ""}
    </div>`;
  }).join("");
  const html = `<p class="settings-lead">每个 AI 工具选一个身份：<b>指挥官</b>负责把你的需求拆成步骤并检查结果（只能有一个）；<b>干活</b>的负责动手做；<b>不用</b>就是这次不叫它。选好模型后点「测试一下」确认真能用，再保存。</p>${rows}`;
  if (html !== SET.lastHtml) { $("settingsBody").innerHTML = html; SET.lastHtml = html; }
  const probs = settingsProblems();
  $("settingsHint").textContent = probs.join("；");
  $("settingsHint").className = "settings-hint " + (probs.length ? "bad" : "");
  $("settingsSave").disabled = probs.length > 0;
}

async function saveSettings() {
  await run(async () => {
    await api("/api/settings", SET.draft);
    toast("设置已保存，下一步开始就用新的");
    closeSettings();
    await refresh();
  });
}

async function testModel(name) {
  SET.testing[name] = true; delete SET.result[name]; renderSettings();
  try {
    SET.result[name] = await api("/api/settings/test", { name, model: SET.draft.models[name] || "" });
  } catch (e) {
    SET.result[name] = { ok: false, error: e.message };
  }
  SET.testing[name] = false;
  renderSettings();
}

document.addEventListener("change", (e) => {
  const t = e.target;
  if (!SET.open || !t.matches) return;
  if (t.matches("[data-role]")) {
    const name = t.dataset.role, v = t.value;
    // 把指挥官让给这个工具时，原来的指挥官自动变成「干活」，保证始终只有一个指挥官
    if (v === "commander") for (const x of SET.tools) if (x.name !== name && SET.draft.roles[x.name] === "commander") SET.draft.roles[x.name] = "worker";
    SET.draft.roles[name] = v;
    renderSettings();
  } else if (t.matches("[data-model-pick]")) {
    SET.draft.models[t.dataset.modelPick] = t.value;
    delete SET.result[t.dataset.modelPick];
    SET.lastHtml = ""; renderSettings();
  } else if (t.matches("[data-model-type]")) {
    SET.draft.models[t.dataset.modelType] = t.value.trim();
    delete SET.result[t.dataset.modelType];
    SET.lastHtml = ""; renderSettings();
  }
});

$("settingsClose").onclick = closeSettings;
$("settingsCancel").onclick = closeSettings;
$("settingsSave").onclick = saveSettings;
$("settings").onclick = (e) => { if (e.target.id === "settings") closeSettings(); };
