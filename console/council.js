/* 参谋团圆桌 —— 可视化设置：
 *   谁坐在桌上（席位）、每席用哪个 AI、人格文件、开不开会、会议预算。
 * 数据走 /api/council（GET 读 / POST 存），人格内容走 /api/council/skill。
 * 依赖 core.js 里的 $ / esc / api / toast。
 */
const CO = {
  open: false,
  data: null,          // { councilDefault, councilBudgetPerDay, seats, skills, tools, usedToday }
  selected: null,      // 当前选中的席位 id
  draft: null,         // 可编辑副本 { councilDefault, councilBudgetPerDay, seats[] }
  skillDraft: null,    // 当前正在编辑的人格文件内容
  skillFile: null,     // 当前编辑的人格文件路径
};

const TOOL_EMOJI = {
  codex: "◈", workbuddy: "◉", workbuddyai: "◍", qoder: "◇", "qoder-intl": "◈",
  traework: "◆",
};

function coBlankSeat(id) {
  return { id, name: id, skill: `console/council/${id}.md`, tool: "auto", enabled: true };
}

async function openCouncil() {
  CO.open = true;
  $("council").classList.remove("hidden");
  $("councilBody").innerHTML = '<div class="rt-loading">正在读取席位…</div>';
  await loadCouncil();
}

function closeCouncil() {
  CO.open = false;
  $("council").classList.add("hidden");
  CO.skillDraft = null;
  CO.skillFile = null;
}

async function loadCouncil() {
  try {
    CO.data = await api("/api/council");
  } catch (e) {
    $("councilBody").innerHTML = `<div class="rt-loading bad">读取失败：${esc(e.message)}</div>`;
    return;
  }
  await detectScene();          // 先确认有没有 AI 生成的底图，决定人往哪摆
  const seats = CO.data.seats || [];
  CO.draft = {
    councilDefault: CO.data.councilDefault === true,
    councilBudgetPerDay: Number(CO.data.councilBudgetPerDay || 0),
    seats: seats.map((s) => ({ ...s })),
  };
  if (!CO.selected || !CO.draft.seats.some((s) => s.id === CO.selected)) {
    CO.selected = CO.draft.seats[0]?.id || null;
  }
  renderCouncil();
}

/* -------------------------------------------------------------- 渲染 ---- */

/* 底图模式：如果 console/assets/table-sci-fi.png 存在，就用它当舞台，
   人物按这张图里桌子的真实椭圆来摆（下文坐标都是量出来的，见 MERGE-NOTES）。 */
const SCENE_IMG = "/assets/table-sci-fi.png";
/* 这张底图里桌子发光环的实测椭圆（Qoder 生成后用像素扫描量出来的）：
   中心 (49.2%, 57.2%)，横向半径 38.1%，纵向半径 28.8%。
   人物摆在半径的 1.03 倍处 —— 正好站在桌沿的白色席卡外侧。 */
const SCENE_SHAPE = { cx: 49.2, cy: 57.2, rx: 38.1 * 1.03, ry: 28.8 * 1.03 };
let sceneMode = null;   // null=还没探测 / true=有底图 / false=用 CSS 画的桌子

function detectScene() {
  if (sceneMode !== null) return Promise.resolve(sceneMode);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { sceneMode = true; resolve(true); };
    img.onerror = () => { sceneMode = false; resolve(false); };
    img.src = SCENE_IMG;
  });
}

function renderCouncil() {
  if (!CO.draft) return;
  const seats = CO.draft.seats;
  const n = seats.length;
  const useImg = sceneMode === true;

  const seatHtml = seats.map((s, i) => {
    /* 环形排布：-90° 起顺时针均分。
       有 AI 底图时用图里桌子的真实椭圆（SCENE_SHAPE），没有就用 CSS 桌子并防重叠。 */
    const angle = (-90 + (i * 360) / Math.max(n, 1)) * (Math.PI / 180);
    let cx, cy, rx, ry;
    if (useImg) {
      rx = SCENE_SHAPE.rx; ry = SCENE_SHAPE.ry;
      cx = SCENE_SHAPE.cx + rx * Math.cos(angle);
      cy = SCENE_SHAPE.cy + ry * Math.sin(angle);
    } else {
      const rad = Math.PI / Math.max(n, 1);
      const needR = (132 + 26) / (2 * Math.sin(rad));
      rx = Math.max(30, Math.min(43, (needR / 640) * 100));
      ry = rx * 0.70;
      cx = 50 + rx * Math.cos(angle);
      cy = 60 + ry * Math.sin(angle);
    }

    const depth = (Math.sin(angle) + 1) / 2;                 // 0=最远 1=最近
    const scale = (0.82 + depth * 0.24).toFixed(3);
    const dim = (0.72 + depth * 0.28).toFixed(3);            // 越远越暗（空气透视）
    // 有底图时桌子是图片的一部分，用 z 分层让近侧的人压在桌上、远侧的藏在桌后
    const z = depth >= 0.5 ? 9 : 3;

    const tool = s.tool === "auto" ? "自动" : s.tool;
    const meta = (CO.data.tools || []).find((t) => t.name === s.tool);
    const bad = s.tool !== "auto" && meta && !meta.ok;
    const missing = !s.skillExists && !(CO.skills || []).some((k) => k.file === s.skill);
    const isCmd = meta && meta.role === "commander";
    return `<button class="rt-seat ${s.id === CO.selected ? "sel" : ""} ${s.enabled ? "" : "off"} ${bad ? "bad" : ""} ${isCmd ? "cmd" : ""}"
        style="left:${cx.toFixed(2)}%;top:${cy.toFixed(2)}%;--sc:${scale};--dim:${dim};--z:${z}"
        data-seat="${esc(s.id)}" title="${esc(s.name)} · ${esc(tool)}">
        <span class="rt-portrait">
          ${avatarHtml(s, CO.data.tools)}
          ${isCmd ? '<span class="rt-crown" title="指挥官">主持</span>' : ""}
        </span>
        <span class="rt-plate">
          <b>${esc(s.name)}</b>
          <i>${esc(tool)}${s.enabled ? "" : " · 停用"}${missing ? " · 缺人格" : ""}</i>
        </span>
      </button>`;
  }).join("");

  $("councilBody").innerHTML = `
    <div class="rt-stage-wrap">
      <div class="rt-stage ${useImg ? "has-bg" : ""}" ${useImg ? `style="--bg:url('${SCENE_IMG}')"` : ""}>
        <div class="rt-floor"></div>
        <div class="rt-scene">
          <div class="rt-table"><span class="rt-table-sheen"></span></div>
        </div>
        ${useImg ? `<div class="rt-rim"><span class="rt-rim-pulse"></span></div>` : ""}
        <div class="rt-hud">
          <div class="rt-hud-title">参谋圆桌</div>
          <div class="rt-hud-sub">${n} 席在座 · 今日已议 ${CO.data.usedToday || 0} 次</div>
          <label class="rt-switch">
            <input type="checkbox" id="rtDefault" ${CO.draft.councilDefault ? "checked" : ""}>
            <span class="sw"></span>
            <span>开局默认开参谋会</span>
          </label>
          <label class="rt-budget">每日议事上限 <input type="number" id="rtBudget" min="0" max="200" value="${CO.draft.councilBudgetPerDay}"> 次</label>
        </div>
        ${seatHtml}
        ${seats.length ? "" : '<div class="rt-empty">桌上还没有人。点下面「加一席」开始。</div>'}
      </div>
      <div class="rt-side" id="rtSide">${renderSeatEditor()}</div>
    </div>
    <div class="rt-foot">
      <button class="btn small" id="rtAdd">＋ 加一席</button>
      <span class="spacer"></span>
      <span class="rt-hint" id="rtHint"></span>
      <button class="btn small" id="rtCancel">取消</button>
      <button class="btn primary small" id="rtSave">保存参谋团</button>
    </div>`;

  bindCouncilEvents();
  if (CO.selected) ensureSkillLoaded(CO.selected);
}

/** 头像：优先用你上传的真人照片；没有照片就用程序化生成的"大头贴"（不是剪影、不是字母） */
function avatarHtml(s, tools) {
  const cls = "rt-ava " + esc(s.tool);
  const url = s.avatarUrl || (s.avatar ? "/api/attachment?path=" + encodeURIComponent(s.avatar) : "");
  if (url) {
    return `<span class="${cls} has-photo"><img src="${esc(url)}" alt="${esc(s.name)}"></span>`;
  }
  // 根据席位 id 稳定生成同一张脸：改名字不换脸，换 id 才换人
  const seed = s.id || s.name || "seat";
  let src = "";
  try { src = portraitDataUri(seed, { size: 160 }); } catch { src = ""; }
  return src
    ? `<span class="${cls} has-face"><img src="${esc(src)}" alt="${esc(s.name)}"></span>`
    : `<span class="${cls}"></span>`;
}

function renderSeatEditor() {
  const s = CO.draft?.seats.find((x) => x.id === CO.selected);
  if (!s) return '<div class="rt-editor-empty">点圆桌上的一席来编辑，或者点「加一席」。</div>';
  const tools = CO.data.tools || [];
  const skills = CO.data.skills || [];
  const inList = skills.some((k) => k.file === s.skill);
  return `
    <div class="rt-editor">
      <div class="rt-editor-head">
        ${avatarHtml(s, CO.data.tools)}
        <b>${esc(s.name)}</b>
        <span class="spacer"></span>
        <button class="btn small danger" id="rtDel">移除这一席</button>
      </div>

      <div class="rt-photo-row">
        <div class="rt-photo-tip">头像：上传一张真人照片，圆桌上就是这张脸；不上传就用人物剪影。</div>
        <span class="spacer"></span>
        <button class="btn small" id="rtPhotoPick">${s.avatar ? "换照片" : "上传照片"}</button>
        ${s.avatar ? '<button class="btn small" id="rtPhotoClear">清除</button>' : ""}
      </div>

      <label class="rt-field">席位名
        <input id="rtName" value="${esc(s.name)}" maxlength="24" placeholder="如：芒格参谋">
      </label>

      <label class="rt-field">这一席用哪个 AI
        <select id="rtTool">
          <option value="auto" ${s.tool === "auto" ? "selected" : ""}>自动（按当前负载挑最闲的）</option>
          ${tools.map((t) => `<option value="${esc(t.name)}" ${s.tool === t.name ? "selected" : ""}>
            ${esc(t.title)}${t.role === "commander" ? "（指挥官）" : ""}${t.ok ? "" : " · 不可用"}${t.blockedSec ? " · 熔断中" : ""}
          </option>`).join("")}
        </select>
      </label>

      <label class="rt-field">人格文件（决定它的思维方式）
        <select id="rtSkill">
          ${skills.map((k) => `<option value="${esc(k.file)}" ${s.skill === k.file ? "selected" : ""}>${esc(k.file)}</option>`).join("")}
          ${inList ? "" : `<option value="${esc(s.skill)}" selected>${esc(s.skill)}（新建）</option>`}
        </select>
      </label>

      <label class="rt-check"><input type="checkbox" id="rtEnabled" ${s.enabled ? "checked" : ""}> 这一席启用（关掉就不参会）</label>

      <div class="rt-skill-box">
        <div class="rt-skill-head">
          <b>人格内容</b>
          <span class="spacer"></span>
          <span class="rt-skill-file">${esc(CO.skillFile === s.skill ? s.skill : s.skill)}</span>
        </div>
        <textarea id="rtSkillText" class="rt-skill-text" rows="14"
          placeholder="把这个人物的思维方式、判断标准、输出契约写在这里。参会时这一段会原样作为它的提示词。">${esc(CO.skillFile === s.skill ? (CO.skillDraft ?? "") : "")}</textarea>
        <div class="rt-skill-foot">
          <span class="rt-hint" id="rtSkillHint">${CO.skillFile === s.skill ? "" : "正在读取…"}</span>
          <button class="btn small" id="rtSkillSave">保存人格</button>
        </div>
      </div>
    </div>`;
}

async function ensureSkillLoaded(seatId) {
  const s = CO.draft?.seats.find((x) => x.id === seatId);
  if (!s || CO.skillFile === s.skill) return;
  CO.skillFile = s.skill;
  CO.skillDraft = "";
  try {
    const r = await api("/api/council/skill?file=" + encodeURIComponent(s.skill));
    CO.skillDraft = r.content || "";
  } catch (e) {
    CO.skillDraft = "";
    toast("人格文件读取失败：" + e.message, true);
  }
  const box = $("rtSkillText");
  if (box && CO.skillFile === s.skill) {
    box.value = CO.skillDraft || "";
    const hint = $("rtSkillHint");
    if (hint) hint.textContent = CO.skillDraft ? "" : "这个人格文件还是空的，写点内容再用";
  }
}

function bindCouncilEvents() {
  document.querySelectorAll("[data-seat]").forEach((b) => {
    b.onclick = () => { CO.selected = b.dataset.seat; renderCouncil(); };
  });
  const add = $("rtAdd");
  if (add) add.onclick = () => addSeat();
  const del = $("rtDel");
  if (del) del.onclick = () => removeSeat();
  const cancel = $("rtCancel");
  if (cancel) cancel.onclick = () => { closeCouncil(); };
  const save = $("rtSave");
  if (save) save.onclick = () => saveCouncil();

  const name = $("rtName");
  if (name) name.oninput = () => { const s = currentSeat(); if (s) s.name = name.value; refreshSeatsOnly(); };
  const tool = $("rtTool");
  if (tool) tool.onchange = () => { const s = currentSeat(); if (s) { s.tool = tool.value; renderCouncil(); } };
  const skill = $("rtSkill");
  if (skill) skill.onchange = () => {
    const s = currentSeat(); if (!s) return;
    s.skill = skill.value; CO.skillFile = null; renderCouncil();
  };
  const en = $("rtEnabled");
  if (en) en.onchange = () => { const s = currentSeat(); if (s) { s.enabled = en.checked; renderCouncil(); } };
  const dflt = $("rtDefault");
  if (dflt) dflt.onchange = () => { CO.draft.councilDefault = dflt.checked; };
  const budget = $("rtBudget");
  if (budget) budget.oninput = () => { CO.draft.councilBudgetPerDay = Number(budget.value) || 0; };

  const skillSave = $("rtSkillSave");
  if (skillSave) skillSave.onclick = () => saveSkill();
  const ta = $("rtSkillText");
  if (ta) ta.oninput = () => { CO.skillDraft = ta.value; };

  // 真人头像：上传到 intake/avatars，只改本地草稿，随「保存参谋团」落盘
  const photoPick = $("rtPhotoPick");
  if (photoPick) photoPick.onclick = () => pickAvatar();
  const photoClear = $("rtPhotoClear");
  if (photoClear) photoClear.onclick = () => {
    const s = currentSeat();
    if (!s) return;
    s.avatar = ""; s.avatarUrl = "";
    FLMarkDirty();
    renderCouncil();
    toast("已清除头像，保存后生效");
  };
}

function FLMarkDirty() {
  FL.dirty = true;
  const h = $("rtHint");
  if (h) h.textContent = "有改动未保存";
}

/** 选一张本地图片当头像 */
function pickAvatar() {
  const seat = currentSeat();
  if (!seat) return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.style.display = "none";
  document.body.appendChild(input);
  input.onchange = async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) return toast("头像请小于 8MB", true);
    try {
      const fd = new FormData();
      fd.append("files", file, file.name || "avatar.png");
      const r = await fetch("/api/upload?kind=avatar", { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ("上传失败 " + r.status));
      const saved = j.files?.[0];
      if (!saved) throw new Error("服务端没有返回文件");
      seat.avatar = saved.path;
      seat.avatarUrl = "/api/attachment?path=" + encodeURIComponent(saved.path);
      FLMarkDirty();
      renderCouncil();
      toast("头像已设置，保存后生效");
    } catch (e) {
      toast("头像上传失败：" + e.message, true);
    }
  };
  input.click();
}

function currentSeat() { return CO.draft?.seats.find((x) => x.id === CO.selected) || null; }

/* 只刷新圆桌上的名字/状态，不重建编辑器（否则输入框会失焦） */
function refreshSeatsOnly() {
  const seats = CO.draft.seats;
  document.querySelectorAll("[data-seat]").forEach((b) => {
    const s = seats.find((x) => x.id === b.dataset.seat);
    if (!s) return;
    const nm = b.querySelector(".rt-name");
    if (nm) nm.textContent = s.name;
  });
}

function addSeat() {
  if (CO.draft.seats.length >= 8) return toast("最多 8 席", true);
  let i = 1;
  while (CO.draft.seats.some((s) => s.id === `seat${i}`)) i++;
  const id = `seat${i}`;
  const seat = coBlankSeat(id);
  seat.name = `第 ${i} 位参谋`;
  seat.skillExists = false;
  CO.draft.seats.push(seat);
  CO.selected = id;
  CO.skillFile = null;
  renderCouncil();
  toast("加了一席，先给它起名、选 AI、写人格");
}

function removeSeat() {
  const s = currentSeat();
  if (!s) return;
  CO.draft.seats = CO.draft.seats.filter((x) => x.id !== s.id);
  CO.selected = CO.draft.seats[0]?.id || null;
  CO.skillFile = null;
  renderCouncil();
}

async function saveSkill() {
  const s = currentSeat();
  if (!s) return;
  const file = String($("rtSkill")?.value || s.skill);
  const content = String($("rtSkillText")?.value ?? "");
  try {
    await api("/api/council/skill", { file, content });
    CO.skillFile = file; CO.skillDraft = content;
    s.skill = file;
    const hint = $("rtSkillHint");
    if (hint) hint.textContent = "已保存";
    toast("人格已保存：" + file);
  } catch (e) { toast("保存人格失败：" + e.message, true); }
}

async function saveCouncil() {
  const payload = {
    councilDefault: CO.draft.councilDefault,
    councilBudgetPerDay: CO.draft.councilBudgetPerDay,
    seats: CO.draft.seats.map((s, i) => ({
      id: s.id,
      name: String(s.name || s.id).trim(),
      skill: s.skill,
      tool: s.tool,
      enabled: s.enabled,
    })),
  };
  const hint = $("rtHint");
  if (hint) hint.textContent = "保存中…";
  try {
    const r = await api("/api/council", payload);
    if (hint) hint.textContent = `已保存 ${r.seats} 席`;
    toast("参谋团已保存，下一场会就按新席位开");
    await loadCouncil();
    if (typeof refresh === "function") refresh();
  } catch (e) {
    if (hint) hint.textContent = "";
    toast("保存失败：" + e.message, true);
  }
}

/* 顶栏按钮 + ESC 关闭 */
document.addEventListener("DOMContentLoaded", () => {
  const btn = $("btnCouncil");
  if (btn) btn.onclick = () => openCouncil();
  const close = $("councilClose");
  if (close) close.onclick = () => closeCouncil();
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && CO.open) closeCouncil();
  });
});
