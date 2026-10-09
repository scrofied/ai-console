/**
 * AI 指挥台 · 工作台服务端
 * 单进程 Bun，零 npm 依赖。真相源是文件总线（tasks/ 的后缀状态机），不建数据库。
 *
 * 启动：bun run console/server.ts   → http://127.0.0.1:8787
 */
import {
  existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync,
  renameSync, statSync, writeFileSync,
} from "node:fs";
import path from "node:path";

const HERE = import.meta.dir;                       // <ROOT>/console
const ROOT = path.dirname(HERE);
const PORT = Number(process.env.CONSOLE_PORT || 8787);

const CFG_PATH = path.join(ROOT, "config", "workers.json");
if (!existsSync(CFG_PATH)) {
  console.error(
    `\n找不到 ${CFG_PATH}\n\n` +
    `先复制模板再按本机实际情况改：\n` +
    `  cp config/workers.example.json config/workers.json\n\n` +
    `workers.json 里 <> 包起来的地方都要换成你本机真实的路径。\n`,
  );
  process.exit(1);
}
let CFG: any;
try {
  CFG = JSON.parse(readFileSync(CFG_PATH, "utf8"));
} catch (e: any) {
  console.error(`\n${CFG_PATH} 不是合法 JSON：${e?.message || e}\n`);
  process.exit(1);
}
const WORKERS: Record<string, any> = CFG.workers || {};
if (!Object.keys(WORKERS).length) {
  console.error(`\n${CFG_PATH} 里没有任何 worker，至少配一个工具才能开工。\n`);
  process.exit(1);
}
const GUARD = { maxConcurrency: 3, maxCardsPerBatch: 6, defaultTimeoutMin: 8, dailyAutoRunBudget: 24, ...CFG.guardrails };
const POLL = Math.max(2, Number(CFG.pollSeconds || 5)) * 1000;

const DIR_TASKS = path.join(ROOT, "tasks");
const DIR_REVIEWS = path.join(ROOT, "reviews");
const DIR_SHARED = path.join(ROOT, "shared");
const DIR_INTAKE = path.join(ROOT, "intake");
const DIR_PLANS = path.join(HERE, "plans");
const DIR_JOBS = path.join(HERE, "jobs");
const DIR_ARCHIVE = path.join(ROOT, "archive", "旧版任务");
const DIR_EVENTS = path.join(HERE, "events");
const DIR_TMP = path.join(HERE, "tmp");
for (const d of [DIR_TASKS, DIR_REVIEWS, DIR_SHARED, DIR_INTAKE, DIR_PLANS, DIR_JOBS, DIR_EVENTS, DIR_TMP]) mkdirSync(d, { recursive: true });

/* ---------------------------------------------------------------- utils */

const pad = (n: number) => String(n).padStart(2, "0");
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const day = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function safe(p: string) {
  const abs = path.resolve(p);
  const ok = abs === ROOT || abs.startsWith(ROOT + path.sep);
  if (!ok) throw new Error(`越界路径: ${p}`);
  return abs;
}

/** 唤起白名单：只允许 config/workers.json 里已经写死的那些路径，前端传什么都唤不起别的东西。 */
function resolveLaunch(p?: string | null) {
  if (!p) return null;
  const allowed = Object.values(WORKERS).map((w: any) => w.launch).filter(Boolean);
  return allowed.includes(p) ? p : null;
}

function resolveWorkerDir(p: string) {
  try { return safe(p); } catch { return ROOT; }
}

function readAgents(): string {
  try { return readFileSync(path.join(ROOT, "AGENTS.md"), "utf8"); }
  catch { return "(AGENTS.md 缺失：请按产出目录 + DONE 文件的方式交接)"; }
}

/* ------------------------------------------------------------ 事件与 SSE */

const TOOL_SAY: Record<string, string> = {
  Write: "正在写文件", Edit: "正在修改文件", MultiEdit: "正在修改文件", Read: "正在读文件", Glob: "正在查找文件", Grep: "正在查找内容",
  Bash: "正在执行命令", PowerShell: "正在执行命令", WebSearch: "正在搜索网页", WebFetch: "正在读取网页", Agent: "正在分派子任务",
};
/** 把 AI 工具吐出的原始事件说成人话；说不成人话的（心跳、空消息）返回 null，界面就不更新这一行。 */
function friendlyLive(text: string): string | null {
  const tool = text.match(/^([A-Z]\w+) \{/);
  if (tool) {
    const base = TOOL_SAY[tool[1]] || ("正在使用 " + tool[1]);
    const fp = text.match(/"(?:file_path|path)":"([^"]+)"/);
    const q = text.match(/"query":"([^"]+)"/);
    if (fp) return base + "：" + fp[1].split(/[\\/]+/).filter(Boolean).pop();
    if (q) return base + "：" + q[1].slice(0, 40);
    return base;
  }
  let j: any = null;
  try { j = JSON.parse(text); } catch {}
  if (j) {
    const t = j.type || j.item?.type;
    if (t === "agent_message") { const s = String(j.text ?? j.item?.text ?? "").replace(/\*\*/g, "").trim(); return s || null; }
    if (t === "command_execution") return "正在执行命令";
    return null;
  }
  const s = text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  return s || null;
}

const clients = new Set<any>();
const liveNow: Record<string, { text: string, at: number, kind: string }> = {};   // 每张卡"此刻在干嘛"
const cardJob: Record<string, string> = {};      // 卡号 -> 对话号，启动时从任务卡重建
const jobOf = (card: string | null) => !card ? null : (card.match(/^J\d+/)?.[0] || cardJob[card] || null);
function emit(type: string, card: string | null, data: any = {}) {
  const job = data.job ?? jobOf(card);
  const ev = { ts: Date.now(), at: stamp(), type, card, job, ...data };
  try {
    appendFileSync(path.join(DIR_EVENTS, `${day()}.jsonl`), JSON.stringify(ev) + "\n");
    if (job) appendFileSync(path.join(DIR_JOBS, `${job}.log.jsonl`), JSON.stringify(ev) + "\n");
  } catch {}
  if (card && type === "worker_event" && data.text) {
    const say = friendlyLive(String(data.text));
    if (say) liveNow[card] = { text: say, at: Date.now(), kind: String(data.kind || "") };
  }
  if (card && (type === "worker_exit" || type === "card_state")) delete liveNow[card];
  const payload = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) { try { c.enqueue(new TextEncoder().encode(payload)); } catch { clients.delete(c); } }
  return ev;
}

function usedToday(): number {
  const f = path.join(DIR_EVENTS, `${day()}.jsonl`);
  if (!existsSync(f)) return 0;
  let n = 0;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (/autostart/.test(line)) n++;
  }
  return n;
}

/* ------------------------------------------------------------- 任务卡解析 */

const STATES = ["todo", "claimed", "waiting", "done", "review", "pass", "fail", "human"] as const;
const STATE_LABEL: Record<string, string> = {
  todo: "排队中", claimed: "干活中", waiting: "需手动触发", done: "等待验收",
  review: "验收中", pass: "已完成", fail: "没通过", human: "需要你看看",
};

function sectionBody(md: string, name: string): string {
  const re = new RegExp(`^##\\s*${name}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "im");
  const m = md.match(re);
  return m ? m[1].trim() : "";
}

function parseCard(file: string, name: string) {
  const md = readFileSync(file, "utf8");
  const base = name.replace(/\.md$/, "");
  const parts = base.split(".");
  const id = parts[0];
  let state = parts[1] || "todo";
  let claimedBy: string | null = parts[2] || null;
  if (state === "claimed" && !claimedBy) claimedBy = null;
  const first = md.split("\n").find((l) => l.startsWith("# ")) || "";
  const title = first.replace(/^#\s*\S+\s*·\s*/, "").trim() || id;
  const meta: Record<string, string> = {};
  // 字段键名是中文（负责人/依赖），必须允许非 ASCII；只取每段第一次出现，且要求行首
  for (const m of md.matchAll(/^([-\p{L}\p{N}_]+):[ \t]*(.*)$/gmu)) {
    if (m[1].length <= 12 && !(m[1] in meta)) meta[m[1]] = m[2].trim();
  }
  const worker = meta["负责人"] || claimedBy || "";
  const job = meta["对话"] && /^J\d+$/.test(meta["对话"]) ? meta["对话"] : "";
  const deps = (meta["依赖"] || "").split(/[,，\s]+/).filter((x) => /^T\d+$/i.test(x)).map((x) => x.toUpperCase());
  const doneLines = sectionBody(md, "定义完成");
  const tl = sectionBody(md, "时间线");
  const st = statSync(file);
  return {
    id, state, claimedBy, title, worker, deps, job,
    file: path.relative(ROOT, file).replace(/\\/g, "/"),
    做什么: sectionBody(md, "做什么"), 参照物: sectionBody(md, "参照物"),
    不要什么: sectionBody(md, "不要什么"), 定义完成: doneLines,
    自述: sectionBody(md, "自述"), 产出: sectionBody(md, "产出"),
    timeline: tl.split("\n").filter((l) => l.trim().startsWith("-")).slice(-8).reverse(),
    mtime: st.mtimeMs,
  };
}

function renderCard(c: any, state: string, claimedBy: string | null) {
  const lines = [
    `# ${c.id} · ${c.title}`,
    `负责人: ${c.worker}`,
    `依赖: ${c.deps && c.deps.length ? c.deps.join(", ") : "-"}`,
    `对话: ${c.job || "-"}`,
    "",
    "## 做什么", c.做什么 || "(待补)", "",
    "## 参照物", c.参照物 || "-", "",
    "## 不要什么", c.不要什么 || "-", "",
    "## 定义完成", c.定义完成 || "- [ ] (必须写清什么叫做完，否则无法验收)", "",
    "## 时间线", (c.timelineText || `- ${stamp()} 创建（${STATE_LABEL[state] || state}${claimedBy ? " by " + claimedBy : ""}）`), "",
    "## 自述", "", "## 产出", "",
  ];
  return lines.join("\n") + "\n";
}

function cardName(id: string, state: string, worker?: string | null) {
  const suffix = state === "claimed" && worker ? `.claimed.${worker}` : `.${state}`;
  return `${id}${suffix}.md`;
}

function findCardFile(id: string) {
  for (const s of STATES) {
    if (s === "claimed") {
      for (const f of readdirSync(DIR_TASKS)) {
        if (new RegExp(`^${id}\\.claimed\\.[a-z]+\\.md$`, "i").test(f)) return { name: f, state: s, file: path.join(DIR_TASKS, f) };
      }
    } else {
      const f = `${id}.${s}.md`;
      if (existsSync(path.join(DIR_TASKS, f))) return { name: f, state: s, file: path.join(DIR_TASKS, f) };
    }
  }
  return null;
}

function allCards() {
  const out: any[] = [];
  for (const f of readdirSync(DIR_TASKS)) {
    if (!f.endsWith(".md") || f.startsWith("_") || f.startsWith(".")) continue;
    try { out.push(parseCard(path.join(DIR_TASKS, f), f)); } catch (e: any) { emit("parse_error", null, { file: f, error: String(e.message || e) }); }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 原子改名 = 租约。renameSync 成功才算抢到；
 * 被别人抢先会抛 ENOENT/EPERM，目标已存在也直接放弃。
 */
function transition(id: string, fromState: string, toState: string, opts: { worker?: string | null, note?: string, claimedBy?: string | null } = {}) {
  const from = findCardFile(id);
  if (!from) return null;
  const parsed = parseCard(from.file, from.name);
  if (from.state !== fromState) return null;
  const targetName = cardName(id, toState, opts.claimedBy ?? null);
  const target = safe(path.join(DIR_TASKS, targetName));
  if (existsSync(target)) return null;
  const tl = (parsed.timeline || []).slice().reverse().map((l: string) => l.replace(/^-\s*/, "- "));
  tl.push(`- ${stamp()} ${STATE_LABEL[toState] || toState}${opts.worker ? " → " + opts.worker : ""}${opts.note ? "：" + opts.note : ""}`);
  const md = renderCard({ ...parsed, timelineText: tl.join("\n") }, toState, opts.claimedBy ?? null);
  try {
    renameSync(from.file, target);           // 原子交接点
  } catch {
    return null;                              // 被抢了
  }
  writeFileSync(target, md);
  emit("card_state", id, { from: fromState, to: toState, worker: opts.worker || parsed.worker });
  return target;
}

function nextCardId() {
  let max = 0;
  const scan = (dir: string, re: RegExp) => {
    try { for (const f of readdirSync(dir)) { const m = f.match(re); if (m) max = Math.max(max, Number(m[1])); } } catch {}
  };
  scan(DIR_TASKS, /^T(\d+)\./i);
  scan(DIR_ARCHIVE, /^T(\d+)\./i);
  scan(DIR_REVIEWS, /^T(\d+)\./i);
  for (const w of Object.values(WORKERS) as any[]) scan(path.join(ROOT, w.dir || "."), /^T(\d+)$/i);
  return `T${pad(max + 1)}`;
}

/* ------------------------------------------------------------------ 口令 */

/** 拆单时还不知道卡号，Codex 常把路径写成 qoder\page\x.html。统一改写到卡专属目录 qoder\T08\page\x.html，工人和验收方才会看同一个地方。 */
function fixPaths(text: string, worker: string, cardId: string) {
  const dir = WORKERS[worker]?.dir || worker;
  const re = new RegExp("(" + dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")[\\\\/]+(?!T\\d+[\\\\/])", "gi");
  return String(text || "").replace(re, (_m, d) => `${d}\\${cardId}\\`);
}
function cleanDone(t: string) {
  const s = String(t || "");
  return /\]\s*[^\n]*[,，;；]\s*\[/.test(s) ? normalizeChecklist(s) : s;
}

function buildOrder(c: any, opts: { inlineProtocol?: boolean } = {}) {
  const w = WORKERS[c.worker] || {};
  c = { ...c, 做什么: fixPaths(c.做什么, c.worker, c.id), 不要什么: fixPaths(c.不要什么, c.worker, c.id), 定义完成: fixPaths(cleanDone(c.定义完成), c.worker, c.id) };
  const inline = opts.inlineProtocol ?? (w.tier !== "L1" || c.state === "waiting");
  const dir = `${w.dir || c.worker}\\${c.id}`;
  const absDir = path.join(ROOT, w.dir || c.worker, c.id);
  const body = [
    `【任务卡 ${c.id}】${c.title}`,
    `负责人：${c.worker}`,
    `依赖：${c.deps?.length ? c.deps.join(", ") + "（这些卡必须已是 pass 状态）" : "无"}`,
    "",
    `▍你的产出目录（绝对路径，只有这里允许写）`, `  ${absDir}`,
    "  卡正文里如果写了别的目录名（拆单时还不知道卡号），一律以这个绝对路径为准。",
    "",
    "▍做什么", c.做什么, "",
    "▍参照物", c.参照物 || "（无）", "",
    "▍不要什么", c.不要什么 || "（无特别禁止项，但不许改动别的 worker 的目录）", "",
    "▍定义完成（验收方只看这几条）", c.定义完成, "",
    "▍交接方式（重要，两种任选，优先第二种）",
    "  A. 把任务卡改名：tasks\\" + `${c.id}.todo.md → ${c.id}.claimed.${c.worker}.md，做完改成 ${c.id}.done.md`,
    "  B. 如果你不能稳定改别人目录里的文件：把所有产出写进上面那个绝对目录，写完在该目录里新建一个空文件，名字正好是 DONE。工作台会替你完成状态交接。",
    "  无论哪种，都不要把产出内容写回 tasks\\ 里的任务卡本身——那是派工单不是产出物。",
    `  另外在 ${absDir}\\note.md 里用 3 行说明：做了什么 / 卡在哪 / 你不确定的点。`,
    "",
    ...(c.deps?.length ? ["▍上游卡的产出（这些已通过验收，需要时直接读）", ...c.deps.map((d: string) => {
      const up = allCards().find((x: any) => x.id === d);
      return "  " + d + " " + (up?.title || "") + " → " + path.join(ROOT, WORKERS[up?.worker]?.dir || up?.worker || "", d);
    }), ""] : []),
    "▍开工前请先读：",
    `  1. ${DIR_SHARED.replace(ROOT + path.sep, "")}\\daily-log.md 最后一节（昨天卡在哪）`,
    "  2. assets\\ 里是否已有同类卡的模板资产 —— 有就复用，只做内容替换，不要从零重做（这是省额度的关键）",
    "",
    "▍三条铁律（违反会毁掉别的 worker 的工作）",
    "  1) 只写自己的目录：" + (w.dir || c.worker) + "\\ 和这张卡；",
    "  2) 共享读、绝不共享写：别人的目录只读；",
    "  3) 禁改区：AGENTS.md、config\\、console\\、D:\\qord\\ 下的任何东西。",
  ];
  if (inline) body.push("", "▍总线协议全文（照此执行）", "─".repeat(30), readAgents());
  return body.join("\n");
}

/* ------------------------------------------------------- Codex 执行体 (L1) */

const running = new Map<string, any>();   // cardId -> {kill, startedAt, timeoutMin}

/**
 * 凭证熔断：Codex 的 Key 被禁用/额度耗尽时，每一次自动开工和每一次自动验收都会
 * 白烧一遍重试（约 18 秒）。熔断 10 分钟内不再拉起，卡降级成"等人工触发"，
 * 让你复制口令手动喂给任意一家，而不是排队等一个不会来的自动执行。
 */
let codexBlockedUntil = 0;
function codexBlockedSec() { return Math.max(0, Math.ceil((codexBlockedUntil - Date.now()) / 1000)); }
const deferNoticeAt: Record<string, number> = {};   // 熔断提示去重，避免每 5 秒刷一条

function codexBin() {
  const b = WORKERS.codex?.bin;
  return b && existsSync(b) ? b : null;
}


/* ------------------------------------------- 设置：谁指挥、谁干活、用哪个模型 */

type Role = "commander" | "worker" | "off";
const SETTINGS_FILE = path.join(ROOT, "config", "settings.json");
let SETTINGS: { roles: Record<string, Role>, models: Record<string, string> } = { roles: {}, models: {} };
try {
  const s = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
  SETTINGS = { roles: s.roles || {}, models: s.models || {} };
} catch {}

const roleOf = (name: string): Role => (SETTINGS.roles[name] || WORKERS[name]?.role || "worker") as Role;
const modelOf = (name: string): string => (name in SETTINGS.models ? SETTINGS.models[name] : (WORKERS[name]?.model ?? WORKERS[name]?.runner?.model ?? ""));
const titleOf = (name: string) => WORKERS[name]?.title || name;
const MODEL_RE = /^[A-Za-z0-9][\w.\-:\/+() ]{0,79}$/;
const testing: Record<string, boolean> = {};

function commanderName(): string {
  const names = Object.keys(WORKERS);
  return names.find((n) => roleOf(n) === "commander" && WORKERS[n].enabled) || (WORKERS.codex ? "codex" : names[0]);
}

/** 这台电脑上能不能无人值守地跑起来（程序在不在），和登录/额度无关。 */
function canRun(name: string): boolean {
  const w = WORKERS[name];
  if (!w?.enabled) return false;
  if (w.runner) return existsSync(w.runner.node) && existsSync(w.runner.cli);
  return name === "codex" ? !!codexBin() : false;
}

/** 只取 config.toml 里 model 这一行的值，用来在设置页提示"留空时实际用的是什么"。 */
function codexConfigModel(): string {
  try {
    const t = readFileSync(path.join(process.env.USERPROFILE || "", ".codex", "config.toml"), "utf8");
    return /^\s*model\s*=\s*"([^"]+)"/m.exec(t)?.[1] || "";
  } catch { return ""; }
}

function saveSettings(b: any) {
  const names = Object.keys(WORKERS);
  const roles: Record<string, Role> = {};
  const models: Record<string, string> = {};
  for (const name of names) {
    const r = String(b?.roles?.[name] ?? roleOf(name));
    if (r !== "commander" && r !== "worker" && r !== "off") throw new Error(titleOf(name) + " 的角色不对：" + r);
    roles[name] = r;
    const m = String(b?.models?.[name] ?? modelOf(name)).trim();
    if (m && !MODEL_RE.test(m)) throw new Error(titleOf(name) + " 的模型名不合法：" + m);
    models[name] = m;
  }
  const cmds = names.filter((n) => roles[n] === "commander");
  if (cmds.length !== 1) throw new Error("必须有且只有一个指挥官");
  if (!canRun(cmds[0])) throw new Error(titleOf(cmds[0]) + " 在这台电脑上跑不起来，不能当指挥官");
  if (!names.some((n) => roles[n] === "worker" && canRun(n))) throw new Error("至少要有一个能自动干活的 AI");
  SETTINGS = { roles, models };
  writeFileSync(SETTINGS_FILE, JSON.stringify({ roles, models, savedAt: stamp() }, null, 2));
  probeCache = { at: 0, data: null };
  emit("settings_saved", null, { commander: cmds[0] });
}

async function capture(cmd: string[], ms = 60_000): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: process.env });
  const t = setTimeout(() => { try { p.kill(); } catch {} }, ms);
  const out = await new Response(p.stdout).text();
  clearTimeout(t);
  return out;
}

type ModelList = { list: string[], info: Record<string, string> };
const NOT_CHAT_MODEL = /completion|codewise|hunyuan-(3b|7b)|image|kling/i;

/**
 * WorkBuddy 的系统自带模型：读 App 自己缓存的产品配置（含倍率）。
 * `codebuddy --help` 里那行 "Currently supported" 是写死的旧文字，缺新模型，还混着用户自定义项（custom-local:），不能用。
 */
function systemModels(configDir: string): { id: string, name: string, credits: string }[] {
  const dir = path.join(configDir, "cache", "conversation-product-spill");
  const seen = new Map<string, { id: string, name: string, credits: string }>();
  try {
    const files = readdirSync(dir).map((f) => ({ f, t: statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t).slice(0, 6);
    for (const { f } of files) {
      const j = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
      for (const m of j.models || []) {
        const id = String(m?.id || "");
        if (!id || seen.has(id) || id.startsWith("custom-local:") || m.supportsToolCall !== true || NOT_CHAT_MODEL.test(id) || /^default(-|$)/.test(id)) continue;
        seen.set(id, { id, name: String(m.name || id), credits: String(m.credits || "").replace(/\s*credits$/i, "") });
      }
    }
  } catch {}
  return [...seen.values()];
}

/** 向工具本身问"你支持哪些模型"，不是我们写死的清单。 */
async function fetchModels(name: string): Promise<ModelList> {
  const w = WORKERS[name];
  if (!w) throw new Error("未知工具");
  let list: string[] = [];
  const info: Record<string, string> = {};
  if (w.runner) {
    if (!canRun(name)) throw new Error("没找到这个工具的命令行");
    if (w.runner.kind === "qoder") {
      const out = await capture([w.runner.node, w.runner.cli, "--list-models"]);
      list = out.split(/\r?\n/).map((x) => x.trim()).filter((x) => x && x !== "MODEL");
      if (!list.length) throw new Error("读不到模型清单（可能没登录），也可以直接手填模型名");
    } else {
      const sys = w.runner.configDir ? systemModels(w.runner.configDir) : [];
      if (sys.length) {
        for (const m of sys) { list.push(m.id); info[m.id] = m.credits ? `${m.name} · ${m.credits}` : m.name; }
      } else {
        const out = await capture([w.runner.node, w.runner.cli, "--help"]);
        const m = /Currently supported:\s*\(([^)]*)\)/.exec(out);
        if (!m) throw new Error("读不到这个工具的模型清单，也可以直接手填模型名");
        list = m[1].split(",").map((x) => x.trim()).filter((x) => x && !x.startsWith("custom-local:"));
      }
    }
  } else {
    if (!codexBin()) throw new Error("没找到 Codex 程序");
    const j = JSON.parse(await capture([codexBin()!, "debug", "models"]));
    list = (j.models || j).map((x: any) => x.slug || x.id || x.name).filter(Boolean);
    if (!list.length) throw new Error("读不到模型清单，也可以直接手填模型名");
  }
  const rec = w.recommendedModel;
  if (rec && list.includes(rec)) {
    list = [rec, ...list.filter((x) => x !== rec)];
  }
  return { list, info };
}

const modelCache: Record<string, { at: number, data: ModelList }> = {};
const modelInflight: Record<string, Promise<ModelList>> = {};
async function listModels(name: string): Promise<ModelList> {
  const c = modelCache[name];
  if (c && Date.now() - c.at < 10 * 60_000) return c.data;
  if (!modelInflight[name]) {
    modelInflight[name] = fetchModels(name)
      .then((data) => { modelCache[name] = { at: Date.now(), data }; return data; })
      .finally(() => { delete modelInflight[name]; });
  }
  return modelInflight[name];
}

/** 能不能被工作台自动调用：程序在、没被你关掉（角色=off）。登录/额度问题由熔断单独处理。 */
function isAutoWorker(name: string) {
  return canRun(name) && roleOf(name) !== "off";
}
const CLI_KINDS = new Set(["codebuddy", "qoder"]);
const isCliRunner = (name: string) => CLI_KINDS.has(WORKERS[name]?.runner?.kind);
const workerBlockedUntil: Record<string, number> = {};   // 命令行系 worker 的登录/额度熔断
const workerBlockedWhy: Record<string, string> = {};
/** 一个正在跑的进程属于谁：exec 属于卡的负责人，review/plan 属于验收方/指挥官（这样顶栏不会把"Codex 在验收"显示成"Qoder 在干活"）。 */
const runOwner = new Map<string, string>();
const ownerOfRun = (key: string) => runOwner.get(key) || allCards().find((c: any) => c.id === key.split(":")[0])?.worker;
function blockedSecFor(name: string) {
  if (!isCliRunner(name)) return codexBlockedSec();
  return Math.max(0, Math.ceil(((workerBlockedUntil[name] || 0) - Date.now()) / 1000));
}

/** 用户自己 config.toml 里的废弃项警告：每次都打印，会淹没真正的失败原因，直接丢弃 */
function isNoise(line: string) {
  return /unrecognized configuration setting|is ignored\.?$/i.test(line) ||
    /ignoring \d+ unrecognized/i.test(line);
}

async function runCodex(args: {
  cardId: string, prompt: string, workdir: string, timeoutMin?: number,
  sandbox?: string, schemaFile?: string, purpose: string, model?: string,
}) {
  const bin = codexBin();
  if (!bin) { emit("probe_fail", args.cardId, { worker: "codex", error: "找不到 codex 可执行文件，见 config/workers.json 的 bin 字段" }); return { ok: false, error: "no-codex-bin", output: "" }; }
  mkdirSync(args.workdir, { recursive: true });
  const lastFile = path.join(DIR_TMP, `${args.cardId}.last.md`);
  try { if (existsSync(lastFile)) writeFileSync(lastFile, ""); } catch {}
  // 这个 alpha 版里 --sandbox 与 --approve-for-me 互斥；非交互靠 config 覆盖关审批
  const cmd = [bin, "exec", "--json", "--skip-git-repo-check", "-s", args.sandbox || "workspace-write",
    "-c", "approval_policy=\"never\"", "-C", args.workdir];
  const cmodel = args.model ?? modelOf("codex");
  if (cmodel) cmd.push("-m", cmodel);
  if (args.schemaFile) cmd.push("--output-schema", args.schemaFile);
  cmd.push("--output-last-message", lastFile, args.prompt);

  const timeoutMin = args.timeoutMin ?? GUARD.defaultTimeoutMin;
  emit("autostart", args.cardId, { worker: "codex", purpose: args.purpose, workdir: path.relative(ROOT, args.workdir).replace(/\\/g, "/") });

  let proc: any;
  try {
    proc = Bun.spawn(cmd, { cwd: args.workdir, stdout: "pipe", stderr: "pipe", env: process.env });
  } catch (e: any) {
    return { ok: false, error: "spawn-failed: " + (e.message || e), output: "" };
  }
  const rec = { proc, startedAt: Date.now(), timeoutMin, killed: false };
  running.set(args.cardId + ":" + args.purpose, rec);
  runOwner.set(args.cardId + ":" + args.purpose, "codex");
  const killer = setTimeout(() => { rec.killed = true; try { proc.kill(); } catch {} emit("card_timeout", args.cardId, { timeoutMin }); }, timeoutMin * 60_000);

  let output = "";
  const errTail: string[] = [];
  const consume = async (stream: any, isErr: boolean) => {
    const dec = new TextDecoder();
    const reader = stream.getReader();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        if (isNoise(line)) continue;          // 用户 config.toml 里的废弃项警告不是本次失败原因
        if (isErr) { if (/(error|warn|panic|denied|forbidden|40|50)/i.test(line)) { errTail.push(line.slice(0, 300)); if (errTail.length > 8) errTail.shift(); emit("worker_stderr", args.cardId, { worker: "codex", text: line.slice(0, 400) }); } continue; }
        output += (line.length > 900 ? line.slice(0, 900) + "…" : line) + "\n";
        let text = line, kind = "log";
        try {
          const j = JSON.parse(line);
          kind = j.type || j.item_type || j.kind || "event";
          const cand = j.item?.text ?? j.text ?? j.message ?? j.delta ?? j.title ?? (j.thread_id ? "thread " + j.thread_id : null);
          if (typeof cand === "string" && cand.trim()) text = cand;
          else if (j.type === "item.completed" || j.type === "response.output_item.done") text = JSON.stringify(j.item || j).slice(0, 300);
        } catch {}
        if (text) {
          emit("worker_event", args.cardId, { worker: "codex", kind: String(kind).slice(0, 40), text: String(text).slice(0, 600) });
          if (/error|failed|forbidden|denied/i.test(String(kind) + " " + text)) { errTail.push(String(text).slice(0, 220)); if (errTail.length > 8) errTail.shift(); }
        }
      }
    }
  };
  await Promise.all([consume(proc.stdout, false), consume(proc.stderr, true)]);
  const code = await proc.exited;
  clearTimeout(killer);
  running.delete(args.cardId + ":" + args.purpose);
  runOwner.delete(args.cardId + ":" + args.purpose);
  const last = existsSync(lastFile) ? readFileSync(lastFile, "utf8").trim() : "";
  const ok = code === 0 && !rec.killed;
  emit("worker_exit", args.cardId, { worker: "codex", purpose: args.purpose, code, ok, killed: rec.killed });
  const rawErr = errTail.join(" ｜ ") || output.slice(-400);
  let why = "";
  if (!ok) {
    if (/Key 已被禁用|API key|403 Forbidden/i.test(rawErr)) why = "模型网关拒绝了凭证（Key 被禁用/无权限）—— 去对应控制台启用有效 Key，或换 config/workers.json 里的 provider";
    else if (/Insufficient|balance|余额|quota|额度/i.test(rawErr)) why = "额度/余额不足 —— 这家的免费额度用完了";
    else if (rec.killed) why = `超过 ${timeoutMin} 分钟被中止`;
    else if (code === 2) why = "命令行参数不被这个版本接受（exit=2），看 stderr 原文";
    else why = `Codex 退出码 ${code}`;
    if (/Key 已被禁用|API key|403 Forbidden|Insufficient|balance|余额|quota|额度|Unauthorized|invalid api key/i.test(rawErr)) {
      codexBlockedUntil = Date.now() + 10 * 60_000;
      emit("worker_circuit", args.cardId, { worker: "codex", reason: why, cooldownSec: 600 });
    }
  }
  return { ok, code, output: last || output, error: ok ? "" : `${why}（exit=${code}）`, detail: rawErr.slice(0, 900) };
}

/**
 * CodeBuddy 系（workbuddy / workbuddyai）无头执行体。
 * 两个 App 各带一份 codebuddy CLI，用 -p + stream-json 非交互跑；
 * 凭证走 CODEBUDDY_API_KEY 等环境变量（只透传，不读取、不打印）。
 */
async function runCodebuddy(args: { cardId: string, worker: string, prompt: string, workdir: string, addDir: string, timeoutMin?: number, purpose: string, noTools?: boolean, model?: string }) {
  const w = WORKERS[args.worker];
  const r = w?.runner;
  if (!r?.node || !r?.cli || !existsSync(r.node) || !existsSync(r.cli)) {
    return { ok: false, code: -1, output: "", error: "找不到 codebuddy CLI，见 config/workers.json 的 runner 字段", detail: "" };
  }
  mkdirSync(args.workdir, { recursive: true });
  const isQoder = r.kind === "qoder";
  const model = args.model ?? modelOf(args.worker);
  const noTools = args.noTools ? ["--tools", ""] : [];
  const cmd = isQoder
    ? [r.node, r.cli, "-p", "-o", "stream-json", ...noTools, "--permission-mode", r.permissionMode || "bypass_permissions",
        ...(model ? ["-m", model] : []), "--add-dir", args.addDir, "--no-session-persistence", args.prompt]
    : [r.node, r.cli, "-p", "--output-format", "stream-json", "--verbose", ...noTools, ...(model ? ["--model", model] : []),
        "--permission-mode", r.permissionMode || "acceptEdits", "--add-dir", args.addDir, "--max-turns", String(r.maxTurns || 40), args.prompt];
  const env: Record<string, any> = { ...process.env };
  if (r.configDir && !isQoder) { env.CODEBUDDY_CONFIG_DIR = r.configDir; env.WORKBUDDY_CONFIG_DIR = r.configDir; }
  // Key 只放用户环境变量里，配置文件只记变量名；服务不是从带变量的终端启动时，现读注册表兜底
  if (r.apiKeyEnv && !env[r.apiKeyEnv]) {
    try {
      const out = Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command", `[Environment]::GetEnvironmentVariable('${r.apiKeyEnv}','User')`]).stdout.toString().trim();
      if (out) env[r.apiKeyEnv] = out;
    } catch {}
  }
  const timeoutMin = args.timeoutMin ?? GUARD.defaultTimeoutMin;
  emit("autostart", args.cardId, { worker: args.worker, purpose: args.purpose, workdir: path.relative(ROOT, args.workdir).replace(/\\/g, "/") });

  let proc: any;
  try { proc = Bun.spawn(cmd, { cwd: args.workdir, stdout: "pipe", stderr: "pipe", stdin: "ignore", env }); }
  catch (e: any) { return { ok: false, code: -1, output: "", error: "spawn-failed: " + (e.message || e), detail: "" }; }
  const rec = { proc, startedAt: Date.now(), timeoutMin, killed: false };
  running.set(args.cardId + ":" + args.purpose, rec);
  runOwner.set(args.cardId + ":" + args.purpose, args.worker);
  const killer = setTimeout(() => { rec.killed = true; try { proc.kill(); } catch {} emit("card_timeout", args.cardId, { timeoutMin }); }, timeoutMin * 60_000);

  let lastText = "", resultText = "", usage: any = null, fallback = "";
  const errTail: string[] = [];
  // 指定的模型不可用时，这类命令行不报错，只打印一行就悄悄换成默认模型继续跑
  const spotFallback = (l: string) => {
    const m = /Model "([^"]+)" is not available[^"]*using "([^"]+)"/i.exec(l);
    if (m && !fallback) fallback = m[1] + " → " + m[2];
  };
  const consume = async (stream: any, isErr: boolean) => {
    const dec = new TextDecoder(); const reader = stream.getReader(); let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split(/\r?\n/); buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        if (isErr) { spotFallback(line); errTail.push(line.slice(0, 300)); if (errTail.length > 8) errTail.shift(); continue; }
        try {
          const j = JSON.parse(line);
          if (j.type === "assistant" && Array.isArray(j.message?.content)) {
            for (const b of j.message.content) {
              if (b.type === "text" && b.text) { lastText = b.text; emit("worker_event", args.cardId, { worker: args.worker, kind: "text", text: String(b.text).slice(0, 600) }); }
              else if (b.type === "tool_use") emit("worker_event", args.cardId, { worker: args.worker, kind: "tool_use", text: `${b.name} ${JSON.stringify(b.input || {}).slice(0, 200)}` });
            }
          } else if (j.type === "result") {
            resultText = String(j.result ?? j.text ?? "");
            usage = j.usage || null;
            if (j.is_error || /^error/.test(j.subtype || "")) errTail.push(String(j.result || (j.errors || []).join("；") || j.error || "result error").slice(0, 300));
          }
        } catch { spotFallback(line); errTail.push(line.slice(0, 300)); if (errTail.length > 8) errTail.shift(); }
      }
    }
  };
  await Promise.all([consume(proc.stdout, false), consume(proc.stderr, true)]);
  const code = await proc.exited;
  clearTimeout(killer);
  running.delete(args.cardId + ":" + args.purpose);
  runOwner.delete(args.cardId + ":" + args.purpose);
  if (fallback) emit("model_fallback", args.cardId, { worker: args.worker, purpose: args.purpose, detail: fallback });
  // 未登录时 CLI 退出码仍是 0，只把提示当成一条普通回复打印，必须按内容识别
  const authFail = /Authentication required|Please use \/login/i.test(resultText || lastText);
  if (authFail) errTail.push((resultText || lastText).slice(0, 300));
  const ok = code === 0 && !rec.killed && !authFail;
  emit("worker_exit", args.cardId, { worker: args.worker, purpose: args.purpose, code, ok, killed: rec.killed, usage });
  const rawErr = errTail.join(" ｜ ");
  let why = "";
  if (!ok) {
    if (/Authentication required|Not logged in|\/login|Unauthorized|401|403/i.test(rawErr)) {
      why = isQoder ? "qoder 命令行未登录，终端执行 qodercli login" : "codebuddy 命令行未登录（桌面端登录态不共享），检查环境变量 CODEBUDDY_API_KEY";
      workerBlockedUntil[args.worker] = Date.now() + 10 * 60_000;
      workerBlockedWhy[args.worker] = why;
      emit("worker_circuit", args.cardId, { worker: args.worker, reason: why, cooldownSec: 600 });
    } else if (/quota|额度|balance|余额|Insufficient|credit usage limit/i.test(rawErr)) {
      why = "额度/余额不足（账号用量已满，充值或换号后恢复）";
      workerBlockedUntil[args.worker] = Date.now() + 10 * 60_000;
      workerBlockedWhy[args.worker] = why;
    } else if (rec.killed) why = `超过 ${timeoutMin} 分钟被中止`;
    else why = `${args.worker} 退出码 ${code}`;
  }
  return { ok, code, output: resultText || lastText, error: ok ? "" : `${why}（exit=${code}）`, detail: rawErr.slice(0, 900), fallback };
}

/* ------------------------------------------------- 对话（任务）与拆单（指挥官） */
/** 让任意一个工具跑一次：Codex 走自己的执行体，其余走命令行执行体。拆单、验收、测试都从这里过。 */
async function runAgent(name: string, a: {
  cardId: string, prompt: string, workdir: string, timeoutMin: number, purpose: string,
  schemaFile?: string, sandbox?: string, noTools?: boolean, model?: string,
}) {
  if (isCliRunner(name)) {
    return runCodebuddy({ cardId: a.cardId, worker: name, prompt: a.prompt, workdir: a.workdir, addDir: ROOT, timeoutMin: a.timeoutMin, purpose: a.purpose, noTools: a.noTools, model: a.model });
  }
  return runCodex({ cardId: a.cardId, prompt: a.prompt, workdir: a.workdir, timeoutMin: a.timeoutMin, sandbox: a.sandbox, schemaFile: a.schemaFile, purpose: a.purpose, model: a.model });
}


const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    cards: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string" },
          title: { type: "string" },
          worker: { type: "string" },
          deps: { type: "array", items: { type: "string" } },
          do: { type: "string" },
          reference: { type: "string" },
          avoid: { type: "string" },
          done_when: { type: "string" },
        },
        required: ["key", "title", "worker", "deps", "do", "reference", "avoid", "done_when"],
      },
    },
  },
  required: ["summary", "cards"],
};

const workerNames = () => Object.keys(WORKERS).filter((k) => roleOf(k) === "worker" && canRun(k));

function workerRosterText() {
  return workerNames().map((k) => `- ${k}（${titleOf(k)}｜擅长：${(WORKERS[k].strengths || []).join("、")}）`).join("\n");
}

/* 对话文件：console/jobs/J01.json。一个对话 = 一个任务，里面按轮次（round）记录你说过的每一句话。 */

const jobFile = (id: string) => path.join(DIR_JOBS, `${id}.json`);
function readJob(id: string): any | null {
  if (!/^J\d+$/.test(id)) return null;
  try { return JSON.parse(readFileSync(jobFile(id), "utf8")); } catch { return null; }
}
function writeJob(j: any) { writeFileSync(jobFile(j.id), JSON.stringify(j, null, 2)); }
function listJobs(): any[] {
  return readdirSync(DIR_JOBS).filter((f) => /^J\d+\.json$/.test(f)).map((f) => readJob(f.slice(0, -5))).filter(Boolean)
    .sort((a: any, b: any) => Number(b.id.slice(1)) - Number(a.id.slice(1)));
}
function nextJobId() {
  let max = 0;
  for (const f of readdirSync(DIR_JOBS)) { const m = f.match(/^J(\d+)\./); if (m) max = Math.max(max, Number(m[1])); }
  return `J${pad(max + 1)}`;
}
function patchRound(jobId: string, roundId: string, patch: any) {
  const j = readJob(jobId);
  const r = j?.rounds.find((x: any) => x.id === roundId);
  if (!j || !r) return;
  Object.assign(r, patch);
  writeJob(j);
}

function jobContext(job: any, uptoRound: string) {
  const lines: string[] = [];
  for (const r of job.rounds) {
    if (r.id === uptoRound) break;
    lines.push(`- 用户之前说过：${String(r.text).replace(/\s+/g, " ").slice(0, 300)}`);
  }
  const cards = allCards().filter((c: any) => c.job === job.id);
  if (cards.length) {
    lines.push("已经派出去的任务卡（不要重复做）：");
    for (const c of cards) lines.push(`  ${c.id} ${c.title}｜${c.worker}｜${STATE_LABEL[c.state] || c.state}｜产出在 ${WORKERS[c.worker]?.dir || c.worker}\\${c.id}\\`);
  }
  return lines.join("\n");
}

function planPrompt(goal: string, context: string) {
  const names = workerNames();
  return [
    "你是这次多 AI 协作的总指挥。只负责把用户的目标拆成任务卡，不要自己执行。",
    "",
    "用户的目标：", goal, "",
    ...(context ? ["这个对话里已有的背景：", context, ""] : []),
    `可用的干活 AI（worker 字段只能填这些名字：${names.join(" / ")}）：`, workerRosterText(), "",
    "拆单规则：",
    `1. 1 到 ${GUARD.maxCardsPerBatch} 张卡。简单的事一张卡就够，不要为了凑数硬拆。每张卡只有一个负责人，颗粒度到"一次能交付一个可验收的东西"。`,
    "2. 按上面每个 AI 的「擅长」来分配，谁最合适就派给谁；拿不准就派给列表里的第一个。",
    "3. title 用大白话，用户一眼能看懂这一步在干嘛，不超过 20 个字。",
    "4. summary 用一两句中文，告诉用户你打算怎么做、一共几步。",
    "5. deps 填其他卡的 key（小写英文），没有就空数组。有依赖的卡，在 do 里写明要读哪一张上游卡的产出（派单时会给出绝对路径）。",
    "6. 每张卡必须有：do（做什么，具体到能直接动手）、reference（参照物，可空）、avoid（不要什么，写清禁止方向）、done_when（定义完成，可勾选的硬条件，验收方只看这几条，写得可以逐条检查）。",
    "7. key 用小写短横线英文，如 topics / rewrite / page。",
    "8. 每张卡的 8 个字段（key/title/worker/deps/do/reference/avoid/done_when）都必须出现，没有内容就填空字符串或空数组。",
    "9. 产出位置：派单时会给每个 worker 一个专属产出目录。do 和 done_when 里不要写具体目录路径，只写文件名（如 hello.html），统一说「放在你的产出目录里」。",
    "9b. done_when 每一条独占一行，格式 `- [ ] 条款`，用换行分隔，不要用逗号连成一行。",
    "10. 下面「可复用资产」列出了 assets\\ 里已有的东西；本任务能复用就在卡里写明路径，没有就忽略。",
    "11. 你不需要也不允许执行任何命令或读取文件，需要的背景都已经在这条消息里。直接输出结果。",
    "", "可复用资产（assets\\）：", assetsListing(),
    "", "昨天的工作日志（末尾节选）：", dailyLogTail(),
  ].join("\n");
}

function assetsListing() {
  try {
    const items = readdirSync(path.join(ROOT, "assets")).slice(0, 40);
    return items.length ? items.map((x) => "- " + x).join("\n") : "（空）";
  } catch { return "（空）"; }
}

function dailyLogTail() {
  try { return readFileSync(path.join(DIR_SHARED, "daily-log.md"), "utf8").slice(-1200) || "（空）"; }
  catch { return "（空）"; }
}

/** 把「[ ] a,[ ] b」或多行混排统一成每行一条 `- [ ] ...` */
function normalizeChecklist(t: string) {
  const parts = t.split(/\r?\n|[,，;；]\s*(?=-?\s*\[[ xX]?\])/).map((x) => x.trim()).filter(Boolean);
  return parts.map((x) => "- " + x.replace(/^-\s*/, "").replace(/^(\[[ xX]?\])?\s*/, "[ ] ")).join("\n");
}

function parsePlanOutput(text: string): any {
  try { return JSON.parse(text); } catch {}
  const m = String(text).match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

/** 一轮对话的拆单：指挥官只出方案，不动手。 */
async function runPlan(jobId: string, roundId: string) {
  const job = readJob(jobId);
  const round = job?.rounds.find((r: any) => r.id === roundId);
  if (!job || !round) return;
  const runKey = `${jobId}-${roundId}`;
  const schemaFile = path.join(DIR_TMP, `${runKey}.schema.json`);
  writeFileSync(schemaFile, JSON.stringify(PLAN_SCHEMA));
  const prompt = planPrompt(round.text, jobContext(job, roundId));
  // cwd 必须是总线根目录，否则读不到 assets\ / shared\，"先查可复用资产"就是空话
  const cmd = commanderName();
  let res: any = await runAgent(cmd, { cardId: runKey, prompt, workdir: ROOT, timeoutMin: Math.min(GUARD.defaultTimeoutMin, 6), sandbox: "workspace-write", schemaFile, purpose: "plan", noTools: true });
  let parsed = res.ok ? parsePlanOutput(res.output) : null;
  if (!parsed && res.ok) {
    res = await runAgent(cmd, { cardId: runKey, prompt: prompt + "\n\n13. 再强调一次：只输出一个 JSON 对象，不要任何多余文字。", workdir: ROOT, sandbox: "read-only", timeoutMin: 6, purpose: "plan-retry", noTools: true });
    parsed = parsePlanOutput(res.output);
  }
  if (!parsed || !Array.isArray(parsed.cards) || !parsed.cards.length) {
    const why = res.error || (titleOf(cmd) + " 没有按要求回方案");
    patchRound(jobId, roundId, { status: "plan_failed", error: why, detail: (res as any).detail || "" });
    emit("plan_failed", runKey, { error: why });
    return;
  }
  const keys = parsed.cards.map((c: any) => c.key);
  const names = workerNames();
  const draft = parsed.cards.slice(0, GUARD.maxCardsPerBatch).map((c: any) => ({
    key: c.key || "card",
    title: String(c.title || c.key || "未命名步骤").slice(0, 60),
    worker: names.includes(c.worker) ? c.worker : names[0],
    deps: (Array.isArray(c.deps) ? c.deps : []).filter((d: any) => keys.includes(d)),
    做什么: String(c.do || ""), 参照物: String(c.reference || ""),
    不要什么: String(c.avoid || ""), 定义完成: normalizeChecklist(String(c.done_when || "")),
  }));
  patchRound(jobId, roundId, { status: "draft", summary: String(parsed.summary || ""), cards: draft, error: "", detail: "" });
  emit("plan_ready", runKey, { cards: draft.length });
  const fresh = readJob(jobId)?.rounds.find((r: any) => r.id === roundId);
  if (fresh?.auto) await dispatchRound(jobId, roundId);
}

async function dispatchRound(jobId: string, roundId: string, override?: any[]) {
  const job = readJob(jobId);
  const round = job?.rounds.find((r: any) => r.id === roundId);
  if (!job || !round) throw new Error("找不到这一轮");
  if (round.status === "running" || round.status === "finished") throw new Error("这一轮已经派出去了");
  const cards = (override || round.cards || []).slice(0, GUARD.maxCardsPerBatch);
  if (!cards.length) throw new Error("没有可派发的步骤");
  const names = workerNames();
  if (!names.length) {
    throw new Error(
      "没有任何可用的干活 AI。多半是 config/workers.json 里的路径还是模板里 <> 包着的占位符，" +
      "或者对应工具的 CLI 没装。去页面右上角「设置」看看每个工具的状态。",
    );
  }
  for (const c of cards) { if (!names.includes(c.worker)) c.worker = names[0]; }
  const created = await dispatchCards(cards, jobId);
  patchRound(jobId, roundId, { status: "running", dispatched: created.map((c: any) => c.id), dispatchedAt: stamp() });
  return created;
}

function startRound(jobId: string, text: string, auto: boolean) {
  const job = readJob(jobId)!;
  const roundId = `R${job.rounds.length + 1}`;
  job.rounds.push({ id: roundId, text, at: stamp(), status: "planning", auto, cards: [], dispatched: [] });
  job.updatedAt = stamp();
  writeJob(job);
  emit("round_started", `${jobId}-${roundId}`, { text: text.slice(0, 200) });
  if (!canRun(commanderName())) {
    patchRound(jobId, roundId, { status: "plan_failed", error: "找不到指挥官 " + titleOf(commanderName()) + " 的程序，去「设置」换一个指挥官" });
    return roundId;
  }
  runPlan(jobId, roundId);
  return roundId;
}

function newJob(text: string, auto: boolean) {
  const id = nextJobId();
  const title = text.replace(/\s+/g, " ").trim().slice(0, 28) + (text.trim().length > 28 ? "…" : "");
  writeJob({ id, title, createdAt: stamp(), updatedAt: stamp(), archived: false, rounds: [] });
  writeFileSync(path.join(DIR_INTAKE, `${id}.md`), `# ${id}\n\n${text}\n\n发布时间：${stamp()}\n`);
  const roundId = startRound(id, text, auto);
  return { id, roundId };
}

/** Codex 拆单失败时的兜底：不拆了，整句话原样交给一个干活的 AI。 */
async function dispatchDirect(jobId: string, roundId: string, worker: string) {
  const job = readJob(jobId);
  const round = job?.rounds.find((r: any) => r.id === roundId);
  if (!round) throw new Error("找不到这一轮");
  const card = {
    key: "direct", title: round.text.replace(/\s+/g, " ").slice(0, 24), worker, deps: [],
    做什么: round.text, 参照物: "", 不要什么: "不要改动自己产出目录以外的文件",
    定义完成: "- [ ] 按用户的要求完成\n- [ ] 所有产出都放在你的产出目录里\n- [ ] note.md 里用 3 行说明做了什么 / 卡在哪 / 不确定的点",
  };
  patchRound(jobId, roundId, { status: "draft", summary: "没有经过拆单，直接交给 " + (WORKERS[worker]?.title || worker), cards: [card] });
  return dispatchRound(jobId, roundId);
}

/** 一轮的所有卡都到终点（通过 / 需人工）时，把这一轮标成"完成"，并推给前端。 */
/** 某张卡被重试/重做时，它所在的那一轮要回到"干活中"，否则对话里会同时显示"已完成"和"干活中"。 */
function reopenRoundOf(cardId: string) {
  for (const job of listJobs()) {
    for (const r of job.rounds) {
      if ((r.dispatched || []).includes(cardId) && r.status === "finished") {
        patchRound(job.id, r.id, { status: "running", ok: undefined, finishedAt: undefined });
      }
    }
  }
}

function checkRounds() {
  const cards = allCards();
  for (const job of listJobs()) {
    for (const r of job.rounds) {
      if (r.status !== "running" && r.status !== "finished") continue;
      const mine = cards.filter((c: any) => (r.dispatched || []).includes(c.id));
      if (mine.length !== (r.dispatched || []).length || !mine.length) continue;
      const settled = mine.every((c: any) => c.state === "pass" || c.state === "human");
      const ok = mine.every((c: any) => c.state === "pass");
      if (r.status === "finished") {
        // 已结束的轮次也要跟着卡的真实状态走：人工点了「算通过」、或重试后通过，结论要随之更新
        if (settled && r.ok !== ok) patchRound(job.id, r.id, { ok });
        else if (!settled) patchRound(job.id, r.id, { status: "running", ok: undefined, finishedAt: undefined });
        continue;
      }
      if (!settled) continue;
      patchRound(job.id, r.id, { status: "finished", ok, finishedAt: stamp() });
      emit("round_done", `${job.id}-${r.id}`, { ok, passed: mine.filter((c: any) => c.state === "pass").length, total: mine.length });
    }
  }
}

/** 服务重启时，上一次还在"干活中"的卡其实已经没有进程了，标成需要人看，免得永远转圈。 */
function recoverOrphans() {
  for (const c of allCards()) {
    if (c.job) cardJob[c.id] = c.job;
  }
  for (const c of allCards()) {
    if (c.state === "claimed" && !running.has(c.id + ":exec")) {
      transition(c.id, "claimed", "human", { worker: c.worker, note: "工作台重启，这一步被打断了，点「重试」继续" });
    }
    if (c.state === "review") {
      transition(c.id, "review", "done", { worker: c.worker, note: "工作台重启，验收被打断，重新验收" });
    }
  }
  for (const job of listJobs()) {
    for (const r of job.rounds) {
      if (r.status === "planning") patchRound(job.id, r.id, { status: "plan_failed", error: "工作台重启，拆单被打断了" });
    }
  }
}

/* ------------------------------------------------------ 派单 / 自动开工 */

async function dispatchCards(cards: any[], jobId: string = "") {
  // 第一遍只分配卡号：拆单里的 deps 用的是 key（topics/scripts），必须先换成真实卡号再落盘
  const keyToId: Record<string, string> = {};
  const first = Number(nextCardId().slice(1));    // nextCardId 看的是磁盘，卡还没落盘，不能连调多次
  const ids = cards.map((c, i) => {
    const id = `T${pad(first + i)}`;
    if (c.key) keyToId[String(c.key).toLowerCase()] = id;
    if (c.title) keyToId[String(c.title)] = id;
    return id;
  });
  const created: any[] = [];
  cards.forEach((c, i) => {
    const id = ids[i];
    const raw = (c.deps || []).map((d: any) => String(d));
    const deps: string[] = [];
    for (const d of raw) {
      const m = keyToId[d.toLowerCase()] || (/^T\d+$/i.test(d) ? d.toUpperCase() : null);
      if (m) deps.push(m);
      else emit("dep_dropped", id, { dropped: d, note: "依赖写了个对不上的 key，已忽略（会立刻开工而不是永远等）" });
    }
    const card = { ...c, id, deps, job: jobId };
    if (jobId) cardJob[id] = jobId;
    writeFileSync(path.join(DIR_TASKS, cardName(id, "todo")), renderCard(card, "todo", null));
    created.push(card);
    emit("card_created", id, { worker: card.worker, title: card.title, deps });
  });
  for (const card of created) {
    const w = WORKERS[card.worker];
    if (isAutoWorker(card.worker)) queueAuto(card);
    else {
      transition(card.id, "todo", "waiting", { worker: card.worker, note: "待人工触发（工作台里复制口令）" });
      emit("needs_trigger", card.id, { worker: card.worker, tier: w?.tier || "?" });
    }
  }
  return created;
}

const autoQueue: any[] = [];
let autoActive = 0;

function depsPass(card: any) {
  if (!card.deps?.length) return true;
  return card.deps.every((d: string) => {
    const f = findCardFile(d);
    return f && f.state === "pass";
  });
}

function queueAuto(card: any) {
  autoQueue.push(card);
  pumpAuto();
}

async function pumpAuto() {
  while (autoActive < GUARD.maxConcurrency) {
    const idx = autoQueue.findIndex((c: any) => {
      const t = findCardFile(c.id);
      if (!t || t.state !== "todo") return false;
      if (!depsPass(c)) return false;
      if (usedToday() >= GUARD.dailyAutoRunBudget) return false;
      return true;
    });
    if (idx === -1) return;
    const card = autoQueue.splice(idx, 1)[0];
    autoActive++;
    startAuto(card).finally(() => { autoActive--; setTimeout(pumpAuto, 500); });
  }
}

async function startAuto(card: any) {
  if (blockedSecFor(card.worker) > 0) {
    if (transition(card.id, "todo", "waiting", { worker: card.worker, note: `${card.worker} 凭证熔断中（剩 ${blockedSecFor(card.worker)}s），降级为人工触发：复制口令粘给对应 App 即可` })) {
      emit("needs_trigger", card.id, { worker: card.worker, reason: "circuit_open" });
    }
    return;
  }
  const t = transition(card.id, "todo", "claimed", { worker: card.worker, claimedBy: card.worker, note: "工作台自动拉起" });
  if (!t) return;
  const w = WORKERS[card.worker];
  const artDir = path.join(ROOT, w.dir, card.id);
  mkdirSync(artDir, { recursive: true });
  const prompt = buildOrder({ ...card, id: card.id }, { inlineProtocol: false });
  // cwd 用总线根目录：这台机器的 Codex alpha 在 Windows 下 workspace-write 实测等于只读，
  // 只有 danger-full-access 能写文件（用户 2026-10-05 明确批准，暂不加越界写入看门狗）；
  // cwd 若设成卡目录，它连 AGENTS.md / shared / assets 都读不到，会直接交回"工作区只读"。
  // 写到哪由口令里的绝对产出目录约束。
  const res: any = await runAgent(card.worker, {
    cardId: card.id, prompt, workdir: isCliRunner(card.worker) ? artDir : ROOT,
    timeoutMin: w.timeoutMin || GUARD.defaultTimeoutMin, purpose: "exec", sandbox: w.sandbox || "danger-full-access",
  });
  if (res.ok) {
    const done = findCardFile(card.id);
    if (done?.state === "claimed") transition(card.id, "claimed", "done", { worker: card.worker, note: "exec 完成" });
    if (res.output) { try { appendFileSync(path.join(artDir, "note.md"), `\n\n（工作台记录的最后一条 ${card.worker} 输出）\n` + res.output.slice(0, 4000)); } catch {} }
    emit("auto_done", card.id, { worker: card.worker });
  } else {
    transition(card.id, "claimed", "human", { worker: card.worker, note: "自动执行失败 " + res.error });
  }
}

/* ------------------------------------------------------------- 交叉验收 */

/**
 * 选验收方。首选"另一家 L1"（真交叉）。
 * 只有一家 L1 时降级成同源独立会话：新 thread、read-only、看不到产出过程，
 * 结论里如实标注"非跨家"，比直接放弃验收有用。
 */
function pickReviewer(card: any): { name: string, crossTool: boolean } | null {
  // 验收顺序：先指挥官，再其他干活的 AI；永远不让产出方自己验自己
  const order = [commanderName(), ...Object.keys(WORKERS).filter((n) => roleOf(n) === "worker")];
  for (const r of order) {
    if (r !== card.worker && canRun(r) && blockedSecFor(r) === 0) return { name: r, crossTool: true };
  }
  if (CFG.reviewPolicy?.allowSameFamilyFallback !== false && canRun(card.worker) && roleOf(card.worker) !== "off" && blockedSecFor(card.worker) === 0) {
    return { name: card.worker, crossTool: false };
  }
  return null;
}

function reviewPrompt(card: any, artifacts: string, crossTool: boolean) {
  card = { ...card, 定义完成: fixPaths(cleanDone(card.定义完成), card.worker, card.id), 不要什么: fixPaths(card.不要什么, card.worker, card.id) };
  return [
    `你是独立验收方，不是产出方。只检查是否满足"定义完成"，不要重写内容、不要改进文案。`,
    "",
    crossTool ? "验收方式：跨家独立检查（另一家工具审它的产出）。"
      : "验收方式：同源独立会话（本机只有这一家能无人值守执行）。你看不到产出过程，只能读文件，请比跨家验收更严格：宁可转 human 也不要放过含糊的产出。",
    "",
    `卡号：${card.id}　标题：${card.title}`,
    `定义完成：`, card.定义完成, "",
    `不要什么（越界也算不通过）：`, card.不要什么 || "-", "",
    `产出目录（绝对路径）：${artifacts}`,
    `任务卡内容在 tasks\\ 下，产出是别人的目录里的文件。请实际读取文件再判定，禁止只看文件名。`,
    `产出目录里的 DONE（空文件）和 note.md（自述）是总线协议要求工人额外留下的交接文件，不算越界，也不算多余产出，判定时直接忽略它们。`,
    `你拥有磁盘访问权限只是为了读；禁止修改、新建、删除任何文件，结论只作为你最后一条消息返回。`,
    "",
    "输出格式（严格遵守）：",
    "第一行必须是 VERDICT: pass 或 VERDICT: fail 或 VERDICT: human",
    "随后每条：条款名 → 通过/不通过 → 证据（文件相对路径:行号 或 引原文片段）",
    "不通过必须写清缺什么，能让人照着补。",
  ].join("\n");
}

const REVIEW_MIN = 10;

/** 验收方的输出里取出人话：优先 VERDICT 之后的正文；拿不到就说明原因，绝不把原始 JSON 事件流塞给用户。 */
function reviewText(raw: string, res: any) {
  const m = /VERDICT:\s*(pass|fail|human)[\s\S]*/i.exec(raw);
  if (m) return m[0].trim();
  if (res.error) return "验收没有完成：" + res.error;
  return "验收方没有给出明确结论。";
}

async function runReview(cardId: string) {
  const found = findCardFile(cardId);
  if (!found || found.state !== "done") return;
  const parsed = parseCard(found.file, found.name);
  const reviewer = pickReviewer(parsed);
  if (reviewer && blockedSecFor(reviewer.name) > 0) {
    if (Date.now() - (deferNoticeAt[cardId] || 0) > 120_000) {
      deferNoticeAt[cardId] = Date.now();
      emit("review_deferred", cardId, { reviewer: reviewer.name, cooldownSec: blockedSecFor(reviewer.name), hint: "卡在\"待验收\"不动，不烧重试。可在卡详情里人工判定，或修好 Key 后自动继续" });
    }
    return;   // 熔断期间留在 done 队列里等，不白跑一遍 18 秒重试
  }
  const artDir = path.join(ROOT, WORKERS[parsed.worker]?.dir || parsed.worker, cardId);
  if (!reviewer) {
    transition(cardId, "done", "human", { worker: parsed.worker, note: "没有可用的 L1 验收方，需人工验收" });
    return;
  }
  transition(cardId, "done", "review", { worker: parsed.worker, note: `验收方 ${reviewer.name}${reviewer.crossTool ? "（跨家）" : "（同源独立会话，非跨家）"}` });
  const reviewPromptText = reviewPrompt(parsed, artDir, reviewer.crossTool);
  const res: any = await runAgent(reviewer.name, {
    cardId, prompt: reviewPromptText, workdir: ROOT, timeoutMin: REVIEW_MIN, purpose: "review",
    // 实测：read-only 和 workspace-write 下 Windows 版 Codex 起不了 shell，验收方读不到文件，只会回"需人工"。
    // 所以和干活时用同一档沙箱，靠提示词禁止验收方改产出。
    sandbox: WORKERS[reviewer.name]?.sandbox || "danger-full-access",
  });
  const text = reviewText(String(res.output || ""), res);
  // 没跑完（超时、被杀、进程出错）不是产出的错：转人工，不自动重派，也不写成"没通过"
  const hasVerdict = /VERDICT:\s*(pass|fail|human)/i.test(text);
  const verdict = hasVerdict ? /VERDICT:\s*(pass|fail|human)/i.exec(text)![1].toLowerCase() : "human";
  const reviewFile = path.join(DIR_REVIEWS, `${cardId}.${reviewer.name}.md`);
  try { writeFileSync(reviewFile, `# ${cardId} 验收结论\n\n验收方: ${reviewer.name}\n验收方式: ${reviewer.crossTool ? "跨家独立检查" : "同源独立会话（非跨家，结论偏保守，可人工推翻）"}\n判定: ${verdict}\n时间: ${stamp()}\n产出目录: ${path.relative(ROOT, artDir).replace(/\\/g, "/")}\n\n---\n\n${text}\n`); } catch {}
  if (verdict === "pass") transition(cardId, "review", "pass", { worker: parsed.worker, note: "验收通过" });
  else if (verdict === "fail") {
    const already = (parsed.timeline || []).join(" ").includes("自动重派");
    if (!already && CFG.reviewPolicy?.autoRedispatchOnce) {
      transition(cardId, "review", "fail", { worker: parsed.worker, note: "不通过，带意见自动重派一次，详见 reviews/" + cardId });
      const again = { ...parsed, id: cardId, 做什么: parsed.做什么 + "\n\n【上一轮验收不通过，请照下面意见补齐】\n" + text.slice(0, 1500) };
      if (isAutoWorker(parsed.worker)) { transition(cardId, "fail", "todo", { worker: parsed.worker, note: "自动重派" }); queueAuto(again); }
      else { transition(cardId, "fail", "waiting", { worker: parsed.worker, note: "验收不通过，需人工重派（意见在 reviews/）" }); emit("needs_trigger", cardId, { worker: parsed.worker, reason: "redispatch" }); }
    } else {
      transition(cardId, "review", "human", { worker: parsed.worker, note: "不通过且自动重派已用尽" });
    }
  } else transition(cardId, "review", "human", { worker: parsed.worker, note: hasVerdict ? "验收方认为需要你确认" : "验收没跑完（" + (res.error || "无结论") + "），产出本身没问题的话点「我看过了，算通过」" });
}

/* ------------------------------------------------ 监测 L2 产出（自动跟踪） */

async function scanWaiting() {
  for (const f of readdirSync(DIR_TASKS)) {
    if (!/\.waiting\.md$/i.test(f)) continue;
    const parsed = parseCard(path.join(DIR_TASKS, f), f);
    const w = WORKERS[parsed.worker];
    if (!w) continue;
    const artDir = path.join(ROOT, w.dir, parsed.id);
    if (!existsSync(artDir)) continue;
    const files = readdirSync(artDir);
    const hasDone = files.includes("DONE");
    const fresh = files.some((x) => { try { return statSync(path.join(artDir, x)).mtimeMs > parsed.mtime - 5000 && x !== "DONE"; } catch { return false; } });
    if (hasDone || (fresh && files.length >= 1)) {
      const note = hasDone ? "检测到 DONE 交接标记" : "检测到产出文件（无 DONE 标记，按产出推进）";
      if (transition(parsed.id, "waiting", "done", { worker: parsed.worker, note })) emit("artifact_found", parsed.id, { worker: parsed.worker, files: files.length });
    }
  }
}

async function scanReviewQueue() {
  for (const f of readdirSync(DIR_TASKS)) {
    if (!/\.done\.md$/i.test(f)) continue;
    const id = f.split(".")[0];
    if (running.has(id + ":review")) continue;
    await runReview(id);
  }
}

async function pumpWaitingAuto() {
  // 依赖变 pass 后，把还在 todo 的 L1 卡拉起来
  for (const c of allCards()) {
    if (c.state !== "todo") continue;
    if (!isAutoWorker(c.worker)) continue;
    if (autoQueue.some((q: any) => q.id === c.id) || running.has(c.id + ":exec")) continue;
    if (!depsPass(c)) continue;
    if (usedToday() >= GUARD.dailyAutoRunBudget) { emit("budget_block", c.id, { used: usedToday(), cap: GUARD.dailyAutoRunBudget }); continue; }
    queueAuto(c);
  }
}

/* --------------------------------------------------------------- 探测 */

let probeCache: any = { at: 0, data: null };
const PROC_HINTS: Record<string, string> = { codex: "codex", workbuddy: "WorkBuddy.exe", qoder: "Qoder" };

async function probe() {
  if (probeCache.data && Date.now() - probeCache.at < 20_000) return probeCache.data;
  let tasklist = "";
  try {
    const p = Bun.spawn(["tasklist", "/fo", "csv", "/nh"], { stdout: "pipe", stderr: "pipe" });
    tasklist = await new Response(p.stdout).text();
  } catch {}
  const data: any = {};
  for (const [k, w] of Object.entries(WORKERS) as any) {
    const binOk = w.bin ? existsSync(w.bin) : null;
    const launchOk = w.launch ? existsSync(w.launch) : null;
    const hint = PROC_HINTS[k];
    data[k] = {
      tier: w.tier, enabled: !!w.enabled, dir: w.dir, title: w.title, strengths: w.strengths, note: w.note,
      bin: w.runner
        ? (existsSync(w.runner.node) && existsSync(w.runner.cli) ? "就绪（" + w.runner.kind + "）" : "缺失（检查 runner.node / runner.cli）")
        : binOk === false ? "缺失（改 config/workers.json 的 bin）" : binOk === true ? "就绪" : "无",
      launch: launchOk === true ? "可唤起" : launchOk === false ? "路径不存在" : "未配置",
      running: hint ? new RegExp(hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(tasklist) : false,
      tasksDone: allCards().filter((c: any) => c.worker === k && c.state === "pass").length,
      active: [...running.keys()].some((key) => ownerOfRun(key) === k),
      role: roleOf(k), model: modelOf(k), canRun: canRun(k),
      runner: w.runner ? { kind: w.runner.kind } : null,
      auto: isAutoWorker(k),
      mode: roleOf(k) === "off" ? "off" : canRun(k) ? "auto" : "manual",
      blockedSec: blockedSecFor(k),
      blockedWhy: workerBlockedWhy[k] || "",
    };
  }
  probeCache = { at: Date.now(), data };
  return data;
}

/* ------------------------------------------------------------ 日报/索引 */

async function refreshIndex() {
  const cards = allCards();
  const lines = [`# 结果索引`, ``, `更新于 ${stamp()}`, ``, `| 卡 | 标题 | 负责人 | 状态 | 产出 |`, `|---|---|---|---|---|`];
  for (const c of cards) lines.push(`| ${c.id} | ${c.title} | ${c.worker} | ${STATE_LABEL[c.state] || c.state} | ${WORKERS[c.worker]?.dir || ""}/${c.id}/ |`);
  writeFileSync(path.join(DIR_SHARED, "index.md"), lines.join("\n") + "\n");
  const done = cards.filter((c: any) => c.state === "pass");
  const stuck = cards.filter((c: any) => ["fail", "human", "waiting"].includes(c.state));
  const daily = path.join(DIR_SHARED, "daily-log.md");
  const prev = existsSync(daily) ? readFileSync(daily, "utf8") : "";
  const body = `- 完成（pass）：${done.map((c: any) => c.id).join(", ") || "无"}\n- 卡住（fail/human/等触发）：${stuck.map((c: any) => `${c.id}(${c.state})`).join(", ") || "无"}\n- 今日自动开工次数：${usedToday()} / 预算 ${GUARD.dailyAutoRunBudget}\n- 下一步：${stuck.length ? "先处理上面卡住的卡，再发新目标" : "可以发新目标"}\n`;
  // 只在汇总内容变化时追加：此前每次刷新都写一节，日志被同一段话撑到 11MB
  if (prev.endsWith(body)) return;
  const sec = `\n## ${day()} ${pad(new Date().getHours())}:${pad(new Date().getMinutes())} 工作台自动汇总\n\n${body}`;
  writeFileSync(daily, prev + sec);
}

/* ------------------------------------------------------------- HTTP 层 */

const JSON_H = { headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" } };
const ok = (data: any = { ok: true }) => new Response(JSON.stringify(data), JSON_H);
const err = (msg: string, code = 400) => new Response(JSON.stringify({ error: msg }), { status: code, ...JSON_H });

const TEXT_EXT = /\.(md|txt|json|html?|css|js|ts|tsx|jsx|py|csv|yml|yaml|xml|log|sh|ps1|bat|cmd|ini|toml|svg)$/i;

function cardView(c: any) {
  const w = WORKERS[c.worker] || {};
  const artDir = path.join(ROOT, w.dir || c.worker || ".", c.id);
  let files: any[] = [];
  try {
    files = readdirSync(artDir).filter((f) => f !== "DONE").map((f) => {
      const st = statSync(path.join(artDir, f));
      return { name: f, size: st.size, rel: path.relative(ROOT, path.join(artDir, f)).replace(/\\/g, "/"), dir: st.isDirectory() };
    });
  } catch {}
  let review: any = null;
  try {
    const rf = readdirSync(DIR_REVIEWS).find((f) => f.startsWith(c.id + "."));
    if (rf) {
      const t = readFileSync(path.join(DIR_REVIEWS, rf), "utf8");
      review = { by: /验收方:\s*(.+)/.exec(t)?.[1]?.trim() || "", verdict: /判定:\s*(\w+)/.exec(t)?.[1] || "", text: t.split("---").slice(1).join("---").trim().slice(0, 4000) };
    }
  } catch {}
  const run = [...running.keys()].some((k) => k.startsWith(c.id + ":"));
  return {
    id: c.id, title: c.title, worker: c.worker, workerTitle: w.title || c.worker, state: c.state, label: STATE_LABEL[c.state] || c.state,
    deps: c.deps, job: c.job, 做什么: c.做什么, 不要什么: c.不要什么, 定义完成: c.定义完成, 自述: c.自述,
    timeline: c.timeline, artifacts: files, artDir: path.relative(ROOT, artDir).replace(/\\/g, "/"), review,
    running: run, live: run ? (liveNow[c.id] || null) : null, mtime: c.mtime,
  };
}

function jobStatus(job: any, cards: any[]) {
  const last = job.rounds[job.rounds.length - 1];
  if (!last) return { key: "empty", label: "空对话", needsYou: false };
  const bad = cards.filter((c: any) => c.state === "human" || c.state === "fail");
  const manual = cards.filter((c: any) => c.state === "waiting");
  if (last.status === "plan_failed") return { key: "attention", label: "拆单失败", needsYou: true };
  if (last.status === "planning") return { key: "working", label: titleOf(commanderName()) + " 在拆任务", needsYou: false };
  if (last.status === "draft") return { key: "attention", label: "等你确认方案", needsYou: true };
  if (bad.length) return { key: "attention", label: "有步骤要你看看", needsYou: true };
  if (manual.length) return { key: "attention", label: "有步骤要手动触发", needsYou: true };
  if (last.status === "running") return { key: "working", label: "干活中", needsYou: false };
  if (last.status === "finished") return { key: "done", label: "已完成", needsYou: false };
  return { key: "idle", label: "", needsYou: false };
}

function summarizeJob(job: any, all: any[]) {
  const mine = all.filter((c: any) => c.job === job.id);
  const st = jobStatus(job, mine);
  const total = mine.length, pass = mine.filter((c: any) => c.state === "pass").length;
  return { id: job.id, title: job.title, updatedAt: job.updatedAt, createdAt: job.createdAt, archived: !!job.archived, status: st, total, pass, rounds: job.rounds.length };
}

const IGNORE_EV = new Set(["hello", "card_state_noise", "worker_stderr", "parse_error", "watcher_error", "probe_fail"]);
function jobEvents(jobId: string) {
  const f = path.join(DIR_JOBS, `${jobId}.log.jsonl`);
  if (!existsSync(f)) return [];
  const rows = readFileSync(f, "utf8").split("\n").filter(Boolean).slice(-400).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return rows.filter((e: any) => !IGNORE_EV.has(e.type)).slice(-120);
}

async function api(req: any, url: URL) {
  const seg = url.pathname.split("/").filter(Boolean);      // ["api", ...]
  const m = req.method;
  if (m === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS" } });

  if (url.pathname === "/api/state") {
    const all = allCards();
    const workers = await probe();
    return ok({
      root: ROOT,
      jobs: listJobs().map((j: any) => summarizeJob(j, all)),
      workers,
      guard: { ...GUARD, runningNow: running.size, usedToday: usedToday(), budgetLeft: Math.max(0, GUARD.dailyAutoRunBudget - usedToday()) },
    });
  }

  if (url.pathname === "/api/jobs" && m === "POST") {
    const b = await req.json();
    const text = String(b.text || "").trim();
    if (text.length < 2) return err("先写一句你想让 AI 帮你做什么");
    return ok(newJob(text, b.auto !== false));
  }

  if (seg[1] === "jobs" && seg[2]) {
    const jobId = seg[2];
    const job = readJob(jobId);
    if (!job) return err("没有这个对话", 404);

    if (m === "GET" && !seg[3]) {
      const cards = allCards().filter((c: any) => c.job === jobId).map(cardView);
      const all = allCards();
      const planLive: Record<string, any> = {};
      for (const r of job.rounds) if (r.status === "planning" && liveNow[jobId + "-" + r.id]) planLive[r.id] = liveNow[jobId + "-" + r.id];
      return ok({ job, status: jobStatus(job, all.filter((c: any) => c.job === jobId)), cards, events: jobEvents(jobId), planLive, workers: await probe() });
    }
    if (m === "POST" && seg[3] === "say") {
      const b = await req.json();
      const text = String(b.text || "").trim();
      if (text.length < 2) return err("说点什么吧");
      const last = job.rounds[job.rounds.length - 1];
      if (last && (last.status === "planning")) return err(titleOf(commanderName()) + " 还在拆上一句话，稍等一下");
      return ok({ roundId: startRound(jobId, text, b.auto !== false) });
    }
    if (m === "POST" && seg[3] === "round" && seg[4]) {
      const roundId = seg[4];
      const act = seg[5];
      try {
        if (act === "dispatch") { const b = await req.json().catch(() => ({})); return ok({ created: (await dispatchRound(jobId, roundId, b.cards)).map((c: any) => c.id) }); }
        if (act === "replan") {
          const r = job.rounds.find((x: any) => x.id === roundId);
          if (!r) return err("找不到这一轮", 404);
          if (r.status === "running") return err("这一轮正在干活，不能重新拆", 409);
          patchRound(jobId, roundId, { status: "planning", error: "", cards: [], dispatched: [], summary: "", ok: undefined, finishedAt: undefined });
          runPlan(jobId, roundId);
          return ok();
        }
        if (act === "direct") { const b = await req.json(); return ok({ created: (await dispatchDirect(jobId, roundId, String(b.worker || workerNames()[0]))).map((c: any) => c.id) }); }
        if (act === "cancel") { patchRound(jobId, roundId, { status: "cancelled" }); return ok(); }
      } catch (e: any) { return err(e.message || String(e), 409); }
    }
    if (m === "POST" && seg[3] === "archive") {
      const b = await req.json().catch(() => ({}));
      job.archived = b.archived !== false; writeJob(job);
      return ok();
    }
    if (m === "POST" && seg[3] === "rename") {
      const b = await req.json();
      const t = String(b.title || "").trim().slice(0, 40);
      if (!t) return err("名字不能空");
      job.title = t; writeJob(job);
      return ok();
    }
  }

  if (seg[1] === "card" && seg[2]) {
    const id = seg[2].toUpperCase();
    const found = findCardFile(id);
    if (!found) return err("卡不存在", 404);
    const parsed = parseCard(found.file, found.name);

    if (m === "GET" && seg[3] === "order") {
      const w = WORKERS[parsed.worker] || {};
      return ok({ order: buildOrder(parsed), worker: parsed.worker, launch: w.launch || null, dir: `${w.dir}/${parsed.id}` });
    }
    if (m === "POST" && seg[3] === "triggered") {
      const t = transition(id, "waiting", "claimed", { worker: parsed.worker, claimedBy: parsed.worker, note: "口令已粘贴，人工开工" });
      return t ? ok() : err("状态没在等手动触发", 409);
    }
    if (m === "POST" && seg[3] === "retry") {
      const b = await req.json().catch(() => ({}));
      if (running.has(id + ":exec")) return err("这一步正在跑", 409);
      if (!["human", "fail", "waiting", "pass"].includes(found.state)) return err("这个状态不能重试：" + found.state, 409);
      if (!isAutoWorker(parsed.worker)) return err(parsed.worker + " 不能自动执行");
      const t = transition(id, found.state, "todo", { worker: parsed.worker, note: "人工重试" + (b.feedback ? "（带了你的补充意见）" : "") });
      if (!t) return err("转移失败", 409);
      if (b.feedback) {
        const fb = String(b.feedback).trim().slice(0, 1500);
        const md = readFileSync(t, "utf8").replace(/\r\n/g, "\n").replace(/^## 参照物/m, `【用户补充意见，必须照办】\n${fb}\n\n## 参照物`);
        writeFileSync(t, md);
      }
      blockedCooldownClear(parsed.worker);
      reopenRoundOf(id);
      queueAuto(parseCard(t, path.basename(t)));
      return ok();
    }
    if (m === "POST" && seg[3] === "approve") {
      const t = transition(id, found.state, "pass", { worker: parsed.worker, note: "你亲自确认通过" });
      return t ? ok() : err("转移失败", 409);
    }
    if (m === "POST" && seg[3] === "abort") {
      let n = 0;
      for (const [k, rec] of running) if (k.startsWith(id + ":")) { try { rec.proc.kill(); rec.killed = true; n++; } catch {} }
      return n ? ok({ killed: n }) : err("这一步没有在跑", 404);
    }
  }

  if (url.pathname === "/api/file" && m === "GET") {
    let abs: string;
    try { abs = safe(path.join(ROOT, url.searchParams.get("path") || "")); } catch { return err("路径不允许", 403); }
    if (!existsSync(abs) || statSync(abs).isDirectory()) return err("文件不存在", 404);
    const size = statSync(abs).size;
    if (!TEXT_EXT.test(abs)) return ok({ binary: true, size, name: path.basename(abs) });
    return ok({ binary: false, size, name: path.basename(abs), truncated: size > 200_000, text: readFileSync(abs, "utf8").slice(0, 200_000) });
  }

  if (url.pathname === "/api/open" && m === "POST") {
    const b = await req.json();
    let abs: string;
    try { abs = safe(path.join(ROOT, String(b.path || ""))); } catch { return err("路径不允许", 403); }
    if (!existsSync(abs)) return err("路径不存在", 404);
    const isDir = statSync(abs).isDirectory();
    try {
      const p = Bun.spawn(isDir ? ["explorer.exe", abs] : ["explorer.exe", "/select,", abs], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      p.unref?.();
      return ok();
    } catch (e: any) { return err("打开失败：" + (e?.message || e), 500); }
  }

  if (url.pathname === "/api/launch" && m === "POST") {
    const b = await req.json();
    const w = WORKERS[b.worker];
    if (!w) return err("未知 worker", 404);
    const target = resolveLaunch(w.launch);
    if (!target) return err("这个程序没有在 config/workers.json 里配置，拒绝执行", 403);
    if (!existsSync(target)) return ok({ opened: false, reason: "路径不存在：" + target });
    const isScript = /\.(cmd|bat)$/i.test(target);
    const dir = b.dir ? resolveWorkerDir(b.dir) : ROOT;
    const cmd = isScript ? ["cmd", "/c", target, dir] : ["cmd", "/c", "start", "", target];
    try {
      const p = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      p.unref?.();
      emit("launch", null, { worker: b.worker });
      return ok({ opened: true });
    } catch (e: any) { return err("唤起失败：" + (e?.message || e), 500); }
  }

  if (url.pathname === "/api/settings" && m === "GET") {
    return ok({
      commander: commanderName(),
      tools: Object.entries(WORKERS).map(([name, w]: any) => ({
        name, title: w.title, role: roleOf(name), model: modelOf(name), modelHint: w.modelHint || "",
        canRun: canRun(name), strengths: w.strengths || [], defaultModel: name === "codex" ? codexConfigModel() : "",
      })),
    });
  }

  if (url.pathname === "/api/settings" && m === "POST") {
    try { saveSettings(await req.json()); } catch (e: any) { return err(e.message || String(e)); }
    return ok({ commander: commanderName() });
  }

  if (seg[1] === "models" && seg[2] && m === "GET") {
    if (!WORKERS[seg[2]]) return err("未知工具", 404);
    try { const d = await listModels(seg[2]); return ok({ models: d.list, info: d.info, recommended: WORKERS[seg[2]].recommendedModel || "" }); } catch (e: any) { return err(e.message || String(e), 502); }
  }

  if (url.pathname === "/api/settings/test" && m === "POST") {
    const b = await req.json();
    const name = String(b?.name || "");
    if (!WORKERS[name]) return err("未知工具", 404);
    if (!canRun(name)) return err("这个工具在本机跑不起来，先检查它的安装");
    const model = String(b?.model ?? modelOf(name)).trim();
    if (model && !MODEL_RE.test(model)) return err("模型名不合法");
    if (testing[name]) return err("正在测试中，稍等一下", 409);
    testing[name] = true;
    const t0 = Date.now();
    try {
      const res: any = await runAgent(name, { cardId: "TEST-" + name, prompt: "只回复两个字：收到", workdir: ROOT, timeoutMin: 2, purpose: "test", noTools: true, sandbox: "read-only", model });
      const text = String(res.output || "").replace(/\s+/g, " ").trim().slice(0, 120);
      const swapped = String(res.fallback || "");
      const good = !!res.ok && text.length > 0 && !swapped;
      if (good) blockedCooldownClear(name);
      const why = swapped ? `这个模型现在用不了，工具悄悄换成了默认模型（${swapped}）。真跑任务也会这样换，请换一个` : (res.error || "没有收到回复");
      return ok({ ok: good, ms: Date.now() - t0, text, error: good ? "" : why });
    } finally { testing[name] = false; }
  }
  if (url.pathname === "/api/circuit/reset" && m === "POST") {
    codexBlockedUntil = 0;
    for (const k of Object.keys(workerBlockedUntil)) { workerBlockedUntil[k] = 0; workerBlockedWhy[k] = ""; }
    for (const k of Object.keys(deferNoticeAt)) delete deferNoticeAt[k];
    probeCache = { at: 0, data: null };
    emit("circuit_reset", null, { by: "console" });
    pumpAuto();
    return ok();
  }

  return err("未知接口", 404);
}

function blockedCooldownClear(worker: string) {
  if (blockedSecFor(worker) > 0) {
    if (isCliRunner(worker)) { workerBlockedUntil[worker] = 0; workerBlockedWhy[worker] = ""; } else codexBlockedUntil = 0;
    probeCache = { at: 0, data: null };
  }
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 255,          // 默认 10s 会把 SSE 长连接掐了（浏览器报 ERR_INCOMPLETE_CHUNKED_ENCODING）
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith("/api/")) {
        if (url.pathname === "/api/events") {
          const enc = new TextEncoder();
          let ctrl: any = null;
          let hb: any = 0;
          const drop = () => { if (hb) clearInterval(hb); hb = 0; if (ctrl) clients.delete(ctrl); ctrl = null; };
          req.signal.addEventListener("abort", drop);
          const stream = new ReadableStream({
            start(c) {
              ctrl = c; clients.add(c);
              c.enqueue(enc.encode("retry: 1500\n\n"));
              c.enqueue(enc.encode('data: {"type":"hello"}\n\n'));
              hb = setInterval(() => { try { c.enqueue(enc.encode(": hb\n\n")); } catch { drop(); } }, 15000);
            },
            cancel() { drop(); },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no", "connection": "keep-alive", "access-control-allow-origin": "*" } });
        }
        return await api(req, url);
      }
      const file = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      // 只放行 console/ 根目录下的前端文件，不让 /../config/ 之类的路径读到别处
      if (!/^[\w.-]+\.(html|css|js)$/.test(file)) return new Response("404", { status: 404 });
      const target = path.join(HERE, file);
      if (!existsSync(target)) return new Response("404 工作台前端缺失：console/" + file, { status: 404 });
      const type = file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : "text/html";
      return new Response(Bun.file(target), { headers: { "content-type": type + "; charset=utf-8", "cache-control": "no-cache" } });
    } catch (e: any) {
      return err("服务端异常: " + (e?.message || String(e)), 500);
    }
  },
});

/* --------------------------------------------------------------- 心跳循环 */

let ticking = false;
setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try {
    await scanWaiting();
    checkRounds();
    await scanReviewQueue();
    await pumpWaitingAuto();
    await pumpAuto();          // 依赖刚变 pass 时，把在队列里等的那张卡拉起来
    await refreshIndex();
    for (const [k, rec] of running) {
      if (Date.now() - rec.startedAt > (rec.timeoutMin + 1) * 60_000) { try { rec.proc.kill(); } catch {} running.delete(k); runOwner.delete(k); }
    }
  } catch (e: any) {
    emit("watcher_error", null, { error: String(e?.message || e) });
  } finally { ticking = false; }
}, POLL);

console.log(`AI 指挥台 → http://127.0.0.1:${server.port}   根目录 ${ROOT}   轮询 ${POLL / 1000}s   指挥官=${titleOf(commanderName())}`);
refreshIndex();
recoverOrphans();
