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
import { runTrae, runAcpHttp, runAcpStdio, listGatewayModels } from "./runners-extra";

const HERE = import.meta.dir;                       // <ROOT>/console
const ROOT = path.dirname(HERE);
const PORT = Number(process.env.CONSOLE_PORT || 8787);

const CFG = JSON.parse(readFileSync(path.join(ROOT, "config", "workers.json"), "utf8"));
const WORKERS: Record<string, any> = CFG.workers;
const GUARD = { maxConcurrency: 3, maxCardsPerBatch: 6, defaultTimeoutMin: 8, dailyAutoRunBudget: 24, ...CFG.guardrails };
const POLL = Math.max(2, Number(CFG.pollSeconds || 5)) * 1000;
/* 参谋团：席位配置在 config/council.json，意见跑独立预算池，不挤卡片预算（缺文件=不开会）。 */
const COUNCIL_FILE = path.join(ROOT, "config", "council.json");
const COUNCIL_DEFAULT: any = { councilDefault: false, councilBudgetPerDay: 0, seats: [] };
/** 可重载：圆桌设置保存后立刻生效，不用重启 */
let COUNCIL: any = loadCouncil();
function loadCouncil(): any {
  try {
    const j = JSON.parse(readFileSync(COUNCIL_FILE, "utf8"));
    return {
      councilDefault: j.councilDefault === true,
      councilBudgetPerDay: Number(j.councilBudgetPerDay || 0),
      seats: Array.isArray(j.seats) ? j.seats : [],
    };
  } catch { return { ...COUNCIL_DEFAULT, seats: [] }; }
}
const councilSeats = (): any[] => (Array.isArray(COUNCIL.seats) ? COUNCIL.seats : []).filter((s: any) => s?.enabled !== false && s?.skill);

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

/* ------------------------------------------------------- 会话续接（上下文） */
/**
 * 每个"工具 + 作用域"固定一条对话，之后每次调用都 resume 它，避免每次从零开始。
 * 作用域：default / flow:<流程>/<步骤> / council:<席位> / review / plan / test
 * 新建时能指定 id 的直接占号；不能的（Codex/Trae）从 JSON 流的 thread_id 抓。
 */
const SESSIONS_FILE = path.join(ROOT, "config", "sessions.json");

function loadSessions(): Record<string, any> {
  try { return JSON.parse(readFileSync(SESSIONS_FILE, "utf8")); } catch { return {}; }
}
function saveSessions(all: Record<string, any>) {
  try {
    mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
    writeFileSync(SESSIONS_FILE, JSON.stringify(all, null, 2) + "\n");
  } catch (e: any) { emit("session_save_fail", null, { error: e?.message || String(e) }); }
}
const sessionKey = (worker: string, scope?: string) => `${worker}::${scope || "default"}`;
function getSession(worker: string, scope?: string): any | null {
  const rec = loadSessions()[sessionKey(worker, scope)];
  return rec && rec.id ? rec : null;
}
function setSession(worker: string, scope: string | undefined, id: string, extra: Record<string, any> = {}) {
  if (!id) return;
  const all = loadSessions();
  const k = sessionKey(worker, scope);
  const prev = all[k] || {};
  all[k] = { ...prev, ...extra, worker, scope: scope || "default", id, turns: (prev.turns || 0) + 1, updatedAt: stamp() };
  saveSessions(all);
}
function resetSession(worker: string, scope?: string) {
  const all = loadSessions();
  if (scope === undefined) {
    for (const k of Object.keys(all)) if (k.startsWith(worker + "::")) delete all[k];
  } else delete all[sessionKey(worker, scope)];
  saveSessions(all);
}
/** 从 CLI 的 JSON 流里抓会话 id（Codex/Trae 都是 thread.started 里的 thread_id） */
function sessionIdFromOutput(out: string): string {
  if (!out) return "";
  const m = out.match(/"thread_id"\s*:\s*"([0-9a-fA-F-]{8,})"/i)
    || out.match(/"(?:session_?id|conversation_?id)"\s*:\s*"([0-9a-fA-F-]{8,})"/i);
  return m ? m[1] : "";
}
const newSessionId = () => crypto.randomUUID();

/* --------------------------------------------------------- 用户环境变量兜底 */
/**
 * 读用户级环境变量（工作台的 Key 都只放这里，不进配置文件）。
 * 不用 spawnSync 抓 stdout：在受限沙箱下管道会失败（EPERM），改成"让 PowerShell 写文件再读"。
 */
function readUserEnv(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return "";
  const tmp = path.join(DIR_TMP, `env-${name}.txt`);
  try {
    Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command",
      `[Environment]::GetEnvironmentVariable('${name}','User') | Out-File -Encoding utf8 -NoNewline '${tmp.replace(/'/g, "''")}'`],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    if (!existsSync(tmp)) return "";
    const v = readFileSync(tmp, "utf8").replace(/^\uFEFF/, "").trim();
    try { Bun.spawnSync(["cmd.exe", "/c", "del", "/q", tmp], { stdout: "ignore", stderr: "ignore", stdin: "ignore" }); } catch {}
    return v;
  } catch { return ""; }
}
/** 启动时把所有工具需要的 Key 预取到 process.env，避免每次调用都去读注册表 */
function hydrateKeys() {
  for (const [name, w] of Object.entries(WORKERS)) {
    const envName = (w as any)?.runner?.apiKeyEnv;
    if (!envName || process.env[envName]) continue;
    const v = readUserEnv(envName);
    if (v) { process.env[envName] = v; console.log(`已从用户环境变量载入 ${envName}（${name}）`); }
    else console.log(`警告：${name} 需要 ${envName}，用户环境变量里没读到`);
  }
}

/* ------------------------------------------------- 附件（多模态输入） */
const DIR_ATTACH = path.join(DIR_INTAKE, "attachments");
const DIR_AVATAR = path.join(DIR_INTAKE, "avatars");
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
const ATTACH_LIMIT_BYTES = 25 * 1024 * 1024;

function attachDir(jobId: string) {
  const dir = path.join(DIR_ATTACH, /^J\d+$/.test(jobId) ? jobId : "tmp");
  mkdirSync(dir, { recursive: true });
  return dir;
}
/** 只留安全字符，避免 ../ 和空格问题 */
function safeFileName(raw: string): string {
  const base = path.basename(String(raw || "file"));
  const cleaned = base.replace(/[^\w.\-\u4e00-\u9fa5]/g, "_").replace(/_+/g, "_").slice(-80);
  return cleaned || `file_${Date.now()}`;
}
type Attachment = { name: string; path: string; kind: "image" | "file"; size: number };
/** 把附件清单拼进消息正文，执行体照着路径读 */
function withAttachments(text: string, files: Attachment[]): string {
  if (!files.length) return text;
  const lines = files.map((f, i) =>
    `${i + 1}. ${f.name}｜${f.kind === "image" ? "图片" : "文件"}｜${(f.size / 1024).toFixed(0)} KB\n   路径：${f.path}`);
  return `${text}\n\n【附件（${files.length} 个，都在本机磁盘上，需要时按路径读取）】\n${lines.join("\n")}`;
}
/** 从任意文本里挑出真实存在的图片路径，给 CLI 加图片参数用 */
function imagesInText(text: string, limit = 6): string[] {
  const out: string[] = [];
  const re = /([A-Za-z]:[\\/][^\s"'<>｜|]+?\.(?:png|jpe?g|webp|gif|bmp))/gi;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(text)) && out.length < limit) {
    const p = mm[1].replace(/[),。；;]+$/, "");
    try { if (existsSync(p) && !out.includes(p)) out.push(p); } catch { /* 路径非法跳过 */ }
  }
  return out;
}

/* ------------------------------------------------- 流程模板（固定分工） */
const FLOWS_FILE = path.join(ROOT, "config", "flows.json");
function loadFlows(): any[] {
  try {
    const j = JSON.parse(readFileSync(FLOWS_FILE, "utf8"));
    const list = Array.isArray(j.flows) ? j.flows : [];
    return list.filter((f: any) => f && typeof f.id === "string" && Array.isArray(f.steps) && f.steps.length);
  } catch { return []; }
}
function saveFlows(flows: any[]) {
  writeFileSync(FLOWS_FILE, JSON.stringify({ _note: "流程模板：固定步骤 + 固定执行者。steps 的 deps 填前面步骤的 key。", flows }, null, 2) + "\n");
}
function flowStepToCard(step: any, index: number, flowId?: string): any {
  return {
    key: String(step.key || `s${index + 1}`),
    title: String(step.title || step.key || `第 ${index + 1} 步`).slice(0, 60),
    worker: resolvePlanWorker(step.worker),
    mode: ["self", "parallel", "serial"].includes(String(step.mode)) ? String(step.mode) : "serial",
    deps: Array.isArray(step.deps) ? step.deps.map(String) : [],
    做什么: String(step.do || ""),
    参照物: String(step.reference || ""),
    不要什么: String(step.avoid || ""),
    定义完成: normalizeChecklist(String(step.done_when || "")),
    scope: flowId ? `flow:${flowId}/${step.key || index + 1}` : "default",
  };
}
function validateFlow(flow: any): string | null {
  if (!flow || typeof flow.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(flow.id)) return "流程 id 不合法（小写字母数字和 - _，最多 32 位）";
  if (!Array.isArray(flow.steps) || flow.steps.length === 0) return "流程至少要有一个步骤";
  if (flow.steps.length > 12) return "一个流程最多 12 步";
  const keys = new Set<string>();
  for (const s of flow.steps) {
    const k = String(s?.key || "");
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(k)) return `步骤 key 不合法：${k || "(空)"}`;
    if (keys.has(k)) return `步骤 key 重复：${k}`;
    keys.add(k);
    if (s?.worker && !/^(self|me|自己|commander|指挥官|总指挥)$/i.test(String(s.worker)) && !WORKERS[resolvePlanWorker(s.worker)]) {
      return `步骤 ${k} 指了不存在的工具：${s.worker}`;
    }
  }
  for (const s of flow.steps) {
    for (const d of Array.isArray(s?.deps) ? s.deps : []) {
      if (!keys.has(String(d))) return `步骤 ${s.key} 依赖了不存在的 key：${d}`;
      if (String(d) === String(s.key)) return `步骤 ${s.key} 依赖了自己`;
    }
  }
  return null;
}

/* ------------------------------------------------- 指挥官也干活（self / 并行 / 串行） */
/** 拆单时可以被派活的人：指挥官排第一 + 所有能自动跑且没被关掉的工具 */
function plannableWorkers(): string[] {
  const cmd = commanderName();
  const rest = Object.keys(WORKERS).filter((n) => n !== cmd && isAutoWorker(n));
  return [cmd, ...rest];
}
/** 方案里的 self / 自己 / 指挥官 都归一成真实执行者名 */
function resolvePlanWorker(raw: any): string {
  const s = String(raw || "").trim();
  if (/^(self|me|自己|本人|commander|指挥官|总指挥)$/i.test(s)) return commanderName();
  if (WORKERS[s]) return s;
  return plannableWorkers()[0] || commanderName();
}
/** 这张卡是不是指挥官自己干的 */
function isCommanderCard(worker: string) {
  return String(worker || "") === commanderName();
}

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

/** 今日自动开工分账：逐行解 JSON、只认 type=autostart（旧实现是子串匹配，任何含该词的载荷都会虚增）。
 *  卡片池 = exec/review/plan 等；参谋池 = purpose=council 的席位。 */
function autoRunsToday(): { cards: number, council: number } {
  const f = path.join(DIR_EVENTS, `${day()}.jsonl`);
  if (!existsSync(f)) return { cards: 0, council: 0 };
  let cards = 0, council = 0;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.includes("autostart")) continue;   // 预筛：省掉绝大多数行的 JSON.parse
    let ev: any = null;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev?.type !== "autostart") continue;
    if (ev.purpose === "council") council++; else cards++;
  }
  return { cards, council };
}
function usedToday(): number { return autoRunsToday().cards; }
function councilUsedToday(): number { return autoRunsToday().council; }

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
  // 执行方式：self / parallel / serial（方案里声明，落在卡上）
  const modeRaw = String(meta["模式"] || "").trim();
  const mode = ["self", "parallel", "serial"].includes(modeRaw) ? modeRaw
    : (/指挥官自己干/.test(String(meta["执行方式"] || "")) ? "self" : "");
  const doneLines = sectionBody(md, "定义完成");
  const tl = sectionBody(md, "时间线");
  const st = statSync(file);
  return {
    id, state, claimedBy, title, worker, deps, job, mode,
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
    `模式: ${c.mode || "-"}`,
    ...(isCommanderCard(c.worker) ? ["执行方式: 指挥官自己干"] : []),
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
const modelOf = (name: string): string => {
  if (name in (SETTINGS.models || {})) return SETTINGS.models[name];
  if (AUTO_PICK[name]) return AUTO_PICK[name];
  return WORKERS[name]?.model ?? WORKERS[name]?.runner?.model ?? "";
};
const titleOf = (name: string) => WORKERS[name]?.title || name;
const MODEL_RE = /^[A-Za-z0-9][\w.\-:\/+() ]{0,79}$/;

/** 自动挑出来的模型（按 modelPolicy.priority 走），/api/models 探到时写入 */
const AUTO_PICK: Record<string, string> = {};
/** 倍率空着、或 0 / free / 免费，就是不要钱 */
function creditsAreFree(credits: string): boolean {
  const c = String(credits ?? "").trim();
  if (!c) return true;
  return /^(0+(\.0+)?|free|免费)$/i.test(c);
}
/** 这个工具当前用的是「手选 / 自动挑 / 配置写死 / 工具默认」 */
function modelSourceOf(name: string): "manual" | "auto" | "config" | "tool-default" {
  if (name in (SETTINGS.models || {})) return "manual";
  if (AUTO_PICK[name]) return "auto";
  const w = WORKERS[name];
  if (w?.model ?? w?.runner?.model) return "config";
  return "tool-default";
}
/** 按 modelPolicy.priority 和「优先免费」挑一个模型 */
function pickModel(name: string, list: string[], info: Record<string, string>): string {
  const w = WORKERS[name] || {};
  const policy = w.modelPolicy || {};
  const prio: string[] = Array.isArray(policy.priority) ? policy.priority : [];
  const usable = (m: string) => list.includes(m) && !/^custom-local:/i.test(m);
  for (const m of prio) if (usable(m)) return m;
  if (w.recommendedModel && usable(w.recommendedModel)) return w.recommendedModel;
  if (policy.preferFree !== false) {
    const free = list.find((m) => usable(m) && creditsAreFree(info[m]));
    if (free) return free;
  }
  return list.find(usable) || "";
}
/** 启动/刷新时把各工具的模型清单探一遍，填好 AUTO_PICK */
async function warmModelCatalogs() {
  for (const name of Object.keys(WORKERS)) {
    if (!WORKERS[name]?.enabled || !canRun(name)) continue;
    try {
      const d = await listModels(name);
      const picked = pickModel(name, d.list || [], d.info || {});
      if (picked) AUTO_PICK[name] = picked;
    } catch { /* 登录/网关没起来就先跳过 */ }
  }
}
const testing: Record<string, boolean> = {};

function commanderName(): string {
  const names = Object.keys(WORKERS);
  return names.find((n) => roleOf(n) === "commander" && WORKERS[n].enabled) || (WORKERS.codex ? "codex" : names[0]);
}

/** 这台电脑上能不能无人值守地跑起来（程序在不在），和登录/额度无关。 */
function canRun(name: string): boolean {
  const w = WORKERS[name];
  if (!w?.enabled) return false;
  // 额外执行体（trae / acp）：按自己的 runner 配置判断
  if (isExtraRunner(name)) return runnerStatus(name).ok;
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

async function capture(cmd: string[], ms = 60_000, env: Record<string, any> = process.env): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore", env });
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
      const out = await capture([w.runner.node, w.runner.cli, "--list-models"], 60_000, qoderCleanEnv());
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
/** 额外执行体：Trae CLI / ACP 网关（桌面 App）/ ACP stdio（IDE 内置 worker） */
const EXTRA_KINDS = new Set(["trae", "acp-http", "acp-stdio"]);
const isExtraRunner = (name: string) => EXTRA_KINDS.has(WORKERS[name]?.runner?.kind);
/** 这个工具是不是"自带执行体"（不走 Codex 那条路） */
const hasOwnRunner = (name: string) => isCliRunner(name) || isExtraRunner(name);
/** 给设置页显示：这个工具的执行体配置齐不齐 */
function runnerStatus(name: string) {
  const w = WORKERS[name];
  const r = w?.runner;
  if (!r) return { kind: "codex", ok: !!codexBin(), detail: "走 Codex 执行体" };
  if (r.kind === "codebuddy" || r.kind === "qoder") {
    const ok = !!(r.node && r.cli && existsSync(r.node) && existsSync(r.cli));
    return { kind: r.kind, ok, detail: ok ? "" : "runner.node / runner.cli 不存在" };
  }
  if (r.kind === "trae") {
    const ok = !!(r.bin && existsSync(r.bin));
    return { kind: "trae", ok, detail: ok ? "" : "runner.bin 不存在" };
  }
  if (r.kind === "acp-http") return { kind: "acp-http", ok: !!r.processName, detail: "按宿主进程名找网关端口" };
  if (r.kind === "acp-stdio") {
    const ok = !!(r.command && r.args?.length);
    return { kind: "acp-stdio", ok, detail: ok ? "" : "runner.command / runner.args 不完整" };
  }
  return { kind: String(r.kind || "?"), ok: false, detail: "未知 kind" };
}
const workerBlockedUntil: Record<string, number> = {};   // 命令行系 worker 的登录/额度熔断
const workerBlockedWhy: Record<string, string> = {};
/** 一个正在跑的进程属于谁：exec 属于卡的负责人，review/plan 属于验收方/指挥官（这样顶栏不会把"Codex 在验收"显示成"Qoder 在干活"）。 */
const runOwner = new Map<string, string>();
const ownerOfRun = (key: string) => runOwner.get(key) || allCards().find((c: any) => c.id === key.split(":")[0])?.worker;
function blockedSecFor(name: string) {
  if (!hasOwnRunner(name)) return codexBlockedSec();
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
  scope?: string, keepSession?: boolean,
}) {
  const bin = codexBin();
  if (!bin) { emit("probe_fail", args.cardId, { worker: "codex", error: "找不到 codex 可执行文件，见 config/workers.json 的 bin 字段" }); return { ok: false, error: "no-codex-bin", output: "" }; }
  mkdirSync(args.workdir, { recursive: true });
  const lastFile = path.join(DIR_TMP, `${args.cardId}.last.md`);
  try { if (existsSync(lastFile)) writeFileSync(lastFile, ""); } catch {}
  // 会话续接：有记录就 resume（resume 不接受 -s/-C/--add-dir，改用 -c 覆盖 + 子进程 cwd）
  const wantSession = args.keepSession !== false;
  const prevSession = wantSession ? getSession("codex", args.scope) : null;
  const resumeId = prevSession?.id || "";
  const cmd = [bin, "exec"];
  if (resumeId) cmd.push("resume", resumeId);
  cmd.push("--json", "--skip-git-repo-check");
  if (resumeId) {
    cmd.push("-c", "approval_policy=\"never\"", "-c", `sandbox_mode="${args.sandbox || "workspace-write"}"`);
    emit("session_resume", args.cardId, { worker: "codex", scope: args.scope || "default", id: resumeId.slice(0, 8), turns: prevSession.turns });
  } else {
    cmd.push("-s", args.sandbox || "workspace-write", "-c", "approval_policy=\"never\"", "-C", args.workdir);
  }
  const cmodel = args.model ?? modelOf("codex");
  if (cmodel) cmd.push("-m", cmodel);
  if (args.schemaFile) cmd.push("--output-schema", args.schemaFile);
  cmd.push("--output-last-message", lastFile, args.prompt);

  const timeoutMin = args.timeoutMin ?? GUARD.defaultTimeoutMin;
  emit("autostart", args.cardId, { worker: "codex", purpose: args.purpose, workdir: path.relative(ROOT, args.workdir).replace(/\\/g, "/") });

  let proc: any;
  try {
    // stdin 必须 ignore：若继承父进程（服务）的 stdin，一旦启动服务的 shell 退出导致句柄失效，
    // codex 读 stdin 会瞬间退出 code 66（EX_NOINPUT），24ms 内失败且无输出。runCodebuddy 一直这么做的。
    proc = Bun.spawn(cmd, { cwd: args.workdir, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: process.env });
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
  // 会话续接：新会话从流里抓 thread_id；resume 成功则累加轮数
  if (wantSession) {
    const got = sessionIdFromOutput(output);
    if (got && got !== resumeId) {
      setSession("codex", args.scope, got, { source: "captured" });
      emit("session_new", args.cardId, { worker: "codex", scope: args.scope || "default", id: got.slice(0, 8) });
    } else if (resumeId && ok) {
      setSession("codex", args.scope, resumeId, { source: "resumed" });
    }
  }
  return { ok, code, output: last || output, error: ok ? "" : `${why}（exit=${code}）`, detail: rawErr.slice(0, 900) };
}

/**
 * Qoder 桌面端/CLI 会话会给子进程注入一整族 QODER_* 变量。工作台的 qoder 子进程必须是
 * "像用户在自己终端里敲 qodercli"的干净环境，两类变量必须摘掉：
 *  1) QODER_AGENT_SDK_ENTRYPOINT（如 "sdk-ts"）：透传给 qodercli 会让它误以为在 Agent SDK
 *     里运行，强制要求 --input-format stream-json，不满足就秒退 code 1（sdk_invalid_args，
 *     见 qoder-worker-runtime.mjs 的入口判定）。
 *  2) QODER_CONFIG_DIR / QODERCN_CONFIG_DIR（都指向应用自己的 ~/.qoder-cn）：透传则子进程
 *     读的凭证位置和"用户在普通终端登录的 CLI"（默认目录）不一致，会出现"明明登了仍报
 *     Not logged in"。摘掉后统一回默认目录，工作台和普通终端共用同一份登录。
 */
function qoderCleanEnv(): Record<string, any> {
  const env: Record<string, any> = { ...process.env };
  delete env.QODER_AGENT_SDK_ENTRYPOINT;
  delete env.QODER_CONFIG_DIR;
  delete env.QODERCN_CONFIG_DIR;
  return env;
}

/**
 * CodeBuddy 系（workbuddy / workbuddyai）无头执行体。
 * 两个 App 各带一份 codebuddy CLI，用 -p + stream-json 非交互跑；
 * 凭证走 CODEBUDDY_API_KEY 等环境变量（只透传，不读取、不打印）。
 */
async function runCodebuddy(args: { cardId: string, worker: string, prompt: string, workdir: string, addDir: string, timeoutMin?: number, purpose: string, noTools?: boolean, model?: string, scope?: string, keepSession?: boolean }) {
  const w = WORKERS[args.worker];
  const r = w?.runner;
  if (!r?.node || !r?.cli || !existsSync(r.node) || !existsSync(r.cli)) {
    return { ok: false, code: -1, output: "", error: "找不到 codebuddy CLI，见 config/workers.json 的 runner 字段", detail: "" };
  }
  mkdirSync(args.workdir, { recursive: true });
  const isQoder = r.kind === "qoder";
  const model = args.model ?? modelOf(args.worker);
  const noTools = args.noTools ? ["--tools", ""] : [];
  // 口令里的图片：Qoder 用 --attachment 挂上去，CodeBuddy 系没这个参数就只留路径
  const imgs = imagesInText(args.prompt);
  const qoderAttach = isQoder ? imgs.flatMap((p) => ["--attachment", p]) : [];
  /* 会话续接：两个 CLI 都支持 --session-id（先占号）/ --resume（续上一条）。
     Qoder 原来的 --no-session-persistence 会把会话丢掉，要会话时不能带。 */
  const wantSession = args.keepSession !== false;
  const prev = wantSession ? getSession(args.worker, args.scope) : null;
  let sessionArgs: string[] = [];
  if (wantSession) {
    if (prev?.id) {
      sessionArgs = ["--resume", prev.id];
      emit("session_resume", args.cardId, { worker: args.worker, scope: args.scope || "default", id: prev.id.slice(0, 8), turns: prev.turns });
    } else if (isQoder) {
      // Qoder 认 --session-id：先占号，后面直接 --resume
      const fresh = newSessionId();
      sessionArgs = ["--session-id", fresh];
      setSession(args.worker, args.scope, fresh, { source: "created" });
      emit("session_new", args.cardId, { worker: args.worker, scope: args.scope || "default", id: fresh.slice(0, 8) });
    }
    // CodeBuddy 系会自己覆盖 --session-id，所以不传，跑完从流里抓真实 session_id
  }
  const cmd = isQoder
    ? [r.node, r.cli, "-p", "-o", "stream-json", ...noTools, "--permission-mode", r.permissionMode || "bypass_permissions",
        ...(model ? ["-m", model] : []), "--add-dir", args.addDir, ...qoderAttach, ...sessionArgs, args.prompt]
    : [r.node, r.cli, "-p", "--output-format", "stream-json", "--verbose", ...noTools, ...(model ? ["--model", model] : []),
        "--permission-mode", r.permissionMode || "acceptEdits", "--add-dir", args.addDir, "--max-turns", String(r.maxTurns || 40), ...sessionArgs, args.prompt];
  const env: Record<string, any> = isQoder ? qoderCleanEnv() : { ...process.env };
  if (r.configDir && !isQoder) { env.CODEBUDDY_CONFIG_DIR = r.configDir; env.WORKBUDDY_CONFIG_DIR = r.configDir; }
  // runner.env：WorkBuddy 更新后只发 lite-wb 包，不带这条就 MODULE_NOT_FOUND('../dist/codebuddy')
  if (r.env && typeof r.env === "object") Object.assign(env, r.env);
  // Key 只放用户环境变量里，配置文件只记变量名；服务不是从带变量的终端启动时，现读注册表兜底
  if (r.apiKeyEnv && !env[r.apiKeyEnv]) {
    const k = readUserEnv(r.apiKeyEnv);
    if (k) env[r.apiKeyEnv] = k;
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

  let lastText = "", resultText = "", usage: any = null, fallback = "", rawOut = "";
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
        rawOut += line + "\n";
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
  // 会话续接：CodeBuddy 系新建时从流里抓真实 session_id（它会自己覆盖 --session-id）
  if (wantSession && !prev?.id && ok) {
    const got = sessionIdFromOutput(rawOut);
    if (got) {
      setSession(args.worker, args.scope, got, { source: "captured" });
      emit("session_new", args.cardId, { worker: args.worker, scope: args.scope || "default", id: got.slice(0, 8) });
    }
  } else if (wantSession && prev?.id && ok) {
    setSession(args.worker, args.scope, prev.id, { source: "resumed" });
  }
  return { ok, code, output: resultText || lastText, error: ok ? "" : `${why}（exit=${code}）`, detail: rawErr.slice(0, 900), fallback };
}

/* ------------------------------------------------- 对话（任务）与拆单（指挥官） */
/** 让任意一个工具跑一次：Codex 走自己的执行体，其余走命令行执行体。拆单、验收、测试都从这里过。 */
async function runAgent(name: string, a: {
  cardId: string, prompt: string, workdir: string, timeoutMin: number, purpose: string,
  schemaFile?: string, sandbox?: string, noTools?: boolean, model?: string,
  scope?: string, keepSession?: boolean,
}) {
  if (isExtraRunner(name)) {
    const runner = WORKERS[name]?.runner ?? {};
    const wantSession = a.keepSession !== false;
    const prev = wantSession ? getSession(name, a.scope) : null;
    const common = {
      cardId: a.cardId, worker: name, prompt: a.prompt, workdir: a.workdir,
      addDir: ROOT, timeoutMin: a.timeoutMin, purpose: a.purpose,
      model: a.model ?? modelOf(name), emit, tmpDir: DIR_TMP, runner,
      scope: a.scope, keepSession: a.keepSession,
      sessionId: prev?.id || undefined,
      onSessionId: wantSession
        ? (id: string) => { if (id) setSession(name, a.scope, id, { source: "captured" }); }
        : undefined,
    };
    if (prev?.id) emit("session_resume", a.cardId, { worker: name, scope: a.scope || "default", id: prev.id.slice(0, 8), turns: prev.turns });
    const kind = runner.kind;
    if (kind === "trae") return runTrae(common);
    if (kind === "acp-http") return runAcpHttp(common);
    if (kind === "acp-stdio") return runAcpStdio(common);
    return { ok: false, output: "", error: `未知 runner.kind: ${kind}`, detail: "" };
  }
  if (isCliRunner(name)) {
    return runCodebuddy({ cardId: a.cardId, worker: name, prompt: a.prompt, workdir: a.workdir, addDir: ROOT, timeoutMin: a.timeoutMin, purpose: a.purpose, noTools: a.noTools, model: a.model, scope: a.scope, keepSession: a.keepSession });
  }
  return runCodex({ cardId: a.cardId, prompt: a.prompt, workdir: a.workdir, timeoutMin: a.timeoutMin, sandbox: a.sandbox, schemaFile: a.schemaFile, purpose: a.purpose, model: a.model, scope: a.scope, keepSession: a.keepSession });
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
          // 执行方式：self=指挥官自己干 / parallel=与其他无依赖卡同时开工 / serial=等上游通过后接力
          mode: { type: "string", enum: ["self", "parallel", "serial"] },
        },
        // 这家网关（以及 OpenAI 结构化输出）要求 additionalProperties:false 时每个属性都在 required 里
        required: ["key", "title", "worker", "deps", "do", "reference", "avoid", "done_when", "mode"],
      },
    },
    questions: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "cards", "questions"],
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
  const names = plannableWorkers();
  const cmd = commanderName();
  return [
    "你是这次多 AI 协作的总指挥。你负责拆任务，也要判断哪些事该自己干。",
    "",
    "用户的目标：", goal, "",
    ...(context ? ["这个对话里已有的背景：", context, ""] : []),
    `可用的执行者（worker 字段只能填这些名字：${names.join(" / ")}；其中 ${cmd} 是你自己）：`, workerRosterText(), "",
    "拆单规则：",
    `1. 1 到 ${GUARD.maxCardsPerBatch} 张卡。简单的事一张卡就够，不要为了凑数硬拆。每张卡只有一个负责人，颗粒度到"一次能交付一个可验收的东西"。`,
    "2. 按上面每个 AI 的「擅长」来分配，谁最合适就派给谁；拿不准就派给列表里的第一个。",
    `2b. 你也要干活：如果这件事最适合你（写代码、拆解复杂问题、批量改文件、技术验证），worker 直接填 "${cmd}"，mode 填 "self"。适合某个专长工具的，就派给那个工具。`,
    "2c. mode 三选一：self=你自己干；parallel=这件事和其他卡互不依赖，可以同时开工；serial=必须等上游卡通过后才接力。",
    "3. title 用大白话，用户一眼能看懂这一步在干嘛，不超过 20 个字。",
    "4. summary 用一两句中文，告诉用户你打算怎么做、一共几步、哪几步同时跑。",
    "5. deps 填其他卡的 key（小写英文），没有就空数组。有依赖的卡，在 do 里写明要读哪一张上游卡的产出（派单时会给出绝对路径）。",
    "6. 每张卡必须有：do（做什么，具体到能直接动手）、reference（参照物，可空）、avoid（不要什么，写清禁止方向）、done_when（定义完成，可勾选的硬条件，验收方只看这几条，写得可以逐条检查）。",
    "7. key 用小写短横线英文，如 topics / rewrite / page。",
    "8. 每张卡的 9 个字段（key/title/worker/deps/do/reference/avoid/done_when/mode）都必须出现，没有内容就填空字符串或空数组。",
    "9. 产出位置：派单时会给每个 worker 一个专属产出目录。do 和 done_when 里不要写具体目录路径，只写文件名（如 hello.html），统一说「放在你的产出目录里」。",
    "9b. done_when 每一条独占一行，格式 `- [ ] 条款`，用换行分隔，不要用逗号连成一行。",
    "10. 下面「可复用资产」列出了 assets\\ 里已有的东西；本任务能复用就在卡里写明路径，没有就忽略。",
    "11. 你不需要也不允许执行任何命令或读取文件，需要的背景都已经在这条消息里。直接输出结果。",
    "12. done_when 里凡涉及数量/字数/格式的条款，必须写清口径（例：正文不超过 600 字，不算标题、表格和来源链接），让工人和验收方对同一条款不会有第二种理解。",
    "13. questions：把你拿不准、且只有用户能拍板的参数列进去（最多 2 条，每条不超过 25 字，如「视频要做几分钟？」）；能按常识和惯例自己拍板的一律不许问。没有就填空数组。",
    "14. 如果背景里有「参谋团意见」，先把各家点子揉成一条连贯主线再出卡：开场怎么钩、中段怎么展开、怎么收尾，能对上哪位参谋的点子就对上；互相冲突时选对用户目标最有力的那条。参谋意见是参考，不必每句都用。",
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
  let context = jobContext(job, roundId);
  if (round.council?.minutes) context += "\n\n参谋团意见（供揉主线）：\n" + String(round.council.minutes).slice(0, 12000);
  if (round.answers) context += "\n\n你上一轮问过：\n" + (round.questions || []).map((q: string) => "- " + q).join("\n") + "\n用户的回答：" + String(round.answers).slice(0, 1000) + "\n（已经有用户答案了，这一轮 questions 必须是空数组，不许再问）";
  const prompt = planPrompt(round.text, context);
  // cwd 必须是总线根目录，否则读不到 assets\ / shared\，"先查可复用资产"就是空话
  const cmd = commanderName();
  let res: any = await runAgent(cmd, { cardId: runKey, prompt, workdir: ROOT, timeoutMin: Math.min(GUARD.defaultTimeoutMin, 6), sandbox: "workspace-write", schemaFile, purpose: "plan", noTools: true, scope: "plan" });
  let parsed = res.ok ? parsePlanOutput(res.output) : null;
  if (!parsed && res.ok) {
    res = await runAgent(cmd, { cardId: runKey, prompt: prompt + "\n\n13. 再强调一次：只输出一个 JSON 对象，不要任何多余文字。", workdir: ROOT, sandbox: "read-only", timeoutMin: 6, purpose: "plan-retry", noTools: true, scope: "plan" });
    parsed = parsePlanOutput(res.output);
  }
  if (!parsed || !Array.isArray(parsed.cards) || !parsed.cards.length) {
    const why = res.error || (titleOf(cmd) + " 没有按要求回方案");
    patchRound(jobId, roundId, { status: "plan_failed", error: why, detail: (res as any).detail || "" });
    emit("plan_failed", runKey, { error: why });
    return;
  }
  const keys = parsed.cards.map((c: any) => c.key);
  const draft = parsed.cards.slice(0, GUARD.maxCardsPerBatch).map((c: any) => ({
    key: c.key || "card",
    title: String(c.title || c.key || "未命名步骤").slice(0, 60),
    // self / 指挥官 / 空 都归一成真实执行者；指挥官可以给自己派活
    worker: resolvePlanWorker(c.worker),
    mode: ["self", "parallel", "serial"].includes(String(c.mode)) ? String(c.mode) : "",
    deps: (Array.isArray(c.deps) ? c.deps : []).filter((d: any) => keys.includes(d)),
    做什么: String(c.do || ""), 参照物: String(c.reference || ""),
    不要什么: String(c.avoid || ""), 定义完成: normalizeChecklist(String(c.done_when || "")),
  }));
  let questions = (Array.isArray(parsed.questions) ? parsed.questions : []).map((q: any) => String(q).trim()).filter(Boolean).slice(0, 2);
  if (round.answers) questions = [];   // 一轮最多问一次：用户回答过就不再问
  patchRound(jobId, roundId, { status: "draft", summary: String(parsed.summary || ""), cards: draft, questions, error: "", detail: "" });
  emit("plan_ready", runKey, { cards: draft.length, questions: questions.length });
  const fresh = readJob(jobId)?.rounds.find((r: any) => r.id === roundId);
  if (questions.length) emit("plan_questions", runKey, { questions });
  // 有没解决的问题先停下等用户：不自动派单，等「回答并重规划」或「不问，直接干」
  if (fresh?.auto && !questions.length) await dispatchRound(jobId, roundId);
}

/* ----------------------------------------------------------- 参谋团（席位制） */

/** 正在跑参谋席位的数量，顶栏显示用 */
let councilSeatsActive = 0;

/** 给一席挑执行工具：显式指定的优先（失效自动换）；auto 按当前分到席位的负载挑最闲的。
 *  这里不能用 workerNames()——指挥官（codex）也可以当席位，只要它不是 off。 */
function assignSeatTool(seat: any, load: Record<string, number>): string {
  const healthy = Object.keys(WORKERS).filter((n) => isAutoWorker(n) && blockedSecFor(n) === 0);
  if (!healthy.length) return "";
  const pick = (n: string) => { load[n] = (load[n] || 0) + 1; return n; };
  const want = String(seat.tool || "auto");
  if (want !== "auto" && healthy.includes(want)) return pick(want);
  const best = healthy.slice().sort((a, b) => ((load[a] || 0) - (load[b] || 0)) || a.localeCompare(b))[0];
  return pick(best);
}

function seatPrompt(seat: any, goal: string, context: string) {
  let skill = "";
  try { skill = readFileSync(path.join(ROOT, String(seat.skill)), "utf8"); } catch {}
  return [
    skill || `你是参谋团里的「${seat.name}」席，独立给出你的意见。`,
    "",
    "===== 本次议题 =====",
    "用户的目标：" + goal,
    ...(context ? ["", "这个对话里已有的背景：", context] : []),
    "",
    "作为参谋团成员给出你的独立意见，供总指挥官接下来揉成一条主线。",
    "铁律：你只出意见——不执行任何操作、不读写任何文件、不写成品内容（逐字稿/代码/文案成品都不写）。",
    "直接按你人设文件里的「输出契约」四节格式输出，不要输出别的内容。",
  ].join("\n");
}

/** 一场参谋会议：席位并行出意见 → 纪要落盘 → 自动接着拆单。工具/预算不够会跳会直接拆。 */
async function runCouncil(jobId: string, roundId: string) {
  const job = readJob(jobId);
  const round = job?.rounds.find((r: any) => r.id === roundId);
  if (!job || !round) return;
  const context = jobContext(job, roundId);
  const skipTo = (why: string) => {
    emit("council_skipped", `${jobId}-${roundId}`, { why });
    patchRound(jobId, roundId, { council: { at: stamp(), seats: [], done: true, minutes: "", skipped: why } });
    runPlan(jobId, roundId);
  };
  const seats = councilSeats();
  const cap = Number(COUNCIL.councilBudgetPerDay || 0);
  const used = councilUsedToday();
  if (!seats.length) return skipTo("没有配置参谋席位");
  if (used + seats.length > cap) return skipTo(`参谋预算不够（今日 ${used}/${cap}）`);
  const load: Record<string, number> = {};
  const plan = seats.map((s: any) => ({ seat: s, tool: assignSeatTool(s, load) }));
  if (plan.filter((p) => p.tool).length < 2) return skipTo("健康的工具不够开一场会（至少要 2 席）");
  patchRound(jobId, roundId, {
    council: {
      at: stamp(), done: false, minutes: "",
      seats: plan.map((p) => ({ id: p.seat.id, name: p.seat.name, tool: p.tool, status: p.tool ? "working" : "absent", file: "", summary: "", ok: false, error: p.tool ? "" : "没有可用工具，缺席" })),
    },
  });
  emit("council_start", `${jobId}-${roundId}`, { seats: plan.length, roster: plan.map((p) => `${p.seat.id}→${p.tool || "缺席"}`).join(" ") });
  const outDir = path.join(DIR_SHARED, "council", `${jobId}-${roundId}`);
  mkdirSync(outDir, { recursive: true });
  councilSeatsActive += plan.filter((p) => p.tool).length;
  const results: any[] = [];
  await Promise.all(plan.map(async (p: any) => {
    if (!p.tool) { results.push({ seat: p.seat, tool: "", ok: false, output: "" }); return; }
    const runKey = `${jobId}-${roundId}:${p.seat.id}`;
    const res: any = await runAgent(p.tool, { cardId: runKey, prompt: seatPrompt(p.seat, round.text, context), workdir: ROOT, timeoutMin: 6, purpose: "council", sandbox: "read-only", noTools: true, scope: "council:" + (p.seat?.id || "seat") });
    const output = String(res.output || "").trim();
    const core = (((output.match(/##\s*核心判断\s*\n+([\s\S]*?)(?=\n##|$)/) || [])[1]) || "").replace(/\s+/g, " ").trim();
    const rel = path.relative(ROOT, path.join(outDir, `${p.seat.id}.md`)).replace(/\\/g, "/");
    try {
      writeFileSync(path.join(outDir, `${p.seat.id}.md`), `# ${p.seat.name}（工具：${p.tool}）· ${jobId} ${roundId}\n\n执行状态：${res.ok ? "完成" : "失败——" + res.error}\n\n${output || "（没有拿到输出）"}\n`);
    } catch {}
    results.push({ seat: p.seat, tool: p.tool, ok: !!res.ok, output, file: rel });
    const fresh = readJob(jobId)?.rounds.find((r: any) => r.id === roundId);
    const seatsNow = ((fresh?.council?.seats) || []).map((s: any) => s.id === p.seat.id
      ? { ...s, status: res.ok ? "done" : "failed", file: rel, summary: core.slice(0, 120), ok: !!res.ok, error: res.ok ? "" : String(res.error || "").slice(0, 200) } : s);
    patchRound(jobId, roundId, { council: { ...(fresh?.council || {}), seats: seatsNow } });
    emit("council_seat", runKey, { seat: p.seat.id, tool: p.tool, ok: !!res.ok, summary: core.slice(0, 120) });
  }));
  councilSeatsActive = Math.max(0, councilSeatsActive - plan.filter((p) => p.tool).length);
  const order = new Map(plan.map((p, i) => [p.seat.id, i]));
  const okOnes = results.filter((r) => r.ok && r.output).sort((a, b) => (order.get(a.seat.id) || 0) - (order.get(b.seat.id) || 0));
  const absent = results.filter((r) => !r.ok).map((r) => r.seat.name).join("、");
  const header = `【${roundId} 参谋会议】应到 ${plan.length} 席，出席 ${okOnes.length} 席${absent ? "（" + absent + "缺席/失败）" : ""}。`;
  const minutes = okOnes.length ? header + "\n\n" + okOnes.map((r: any) => `【${r.seat.name}（${r.tool}）】\n${r.output.slice(0, 2500)}`).join("\n\n") : header;
  const fresh2 = readJob(jobId)?.rounds.find((r: any) => r.id === roundId);
  patchRound(jobId, roundId, { council: { ...(fresh2?.council || {}), done: true, minutes } });
  emit("council_done", `${jobId}-${roundId}`, { ok: okOnes.length, total: plan.length });
  await runPlan(jobId, roundId);
}

async function dispatchRound(jobId: string, roundId: string, override?: any[]) {
  const job = readJob(jobId);
  const round = job?.rounds.find((r: any) => r.id === roundId);
  if (!job || !round) throw new Error("找不到这一轮");
  if (round.status === "running" || round.status === "finished") throw new Error("这一轮已经派出去了");
  const cards = (override || round.cards || []).slice(0, GUARD.maxCardsPerBatch);
  if (!cards.length) throw new Error("没有可派发的步骤");
  const names = workerNames();
  for (const c of cards) { if (!names.includes(c.worker)) c.worker = names[0]; }
  const created = await dispatchCards(cards, jobId);
  patchRound(jobId, roundId, { status: "running", dispatched: created.map((c: any) => c.id), dispatchedAt: stamp() });
  return created;
}

function startRound(jobId: string, text: string, auto: boolean, council?: boolean) {
  const job = readJob(jobId)!;
  const roundId = `R${job.rounds.length + 1}`;
  const def = job.councilOn ?? COUNCIL.councilDefault ?? false;
  const useCouncil = (council ?? def) === true && councilSeats().length > 0;
  job.rounds.push({ id: roundId, text, at: stamp(), status: useCouncil ? "council" : "planning", auto, councilOn: useCouncil, cards: [], dispatched: [] });
  job.updatedAt = stamp();
  writeJob(job);
  emit("round_started", `${jobId}-${roundId}`, { text: text.slice(0, 200), council: useCouncil });
  if (!canRun(commanderName())) {
    patchRound(jobId, roundId, { status: "plan_failed", error: "找不到指挥官 " + titleOf(commanderName()) + " 的程序，去「设置」换一个指挥官" });
    return roundId;
  }
  if (useCouncil) runCouncil(jobId, roundId); else runPlan(jobId, roundId);
  return roundId;
}

function newJob(text: string, auto: boolean, council?: boolean) {
  const id = nextJobId();
  const title = text.replace(/\s+/g, " ").trim().slice(0, 28) + (text.trim().length > 28 ? "…" : "");
  writeJob({ id, title, createdAt: stamp(), updatedAt: stamp(), archived: false, councilOn: council, rounds: [] });
  writeFileSync(path.join(DIR_INTAKE, `${id}.md`), `# ${id}\n\n${text}\n\n发布时间：${stamp()}\n`);
  const roundId = startRound(id, text, auto, council);
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
      if (r.status === "council") patchRound(job.id, r.id, { status: "plan_failed", error: "工作台重启，参谋会议被打断了，重新说一句接着来" });
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
const budgetNotified = new Set<string>();   // 被预算挡住的卡每天只播报一次，免得每 5 秒刷屏

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
    timeoutMin: w.timeoutMin || GUARD.defaultTimeoutMin, purpose: "exec", sandbox: w.sandbox || "danger-full-access", scope: card.scope || "default",
  });
  if (res.ok) {
    const done = findCardFile(card.id);
    if (done?.state === "claimed") transition(card.id, "claimed", "done", { worker: card.worker, note: "exec 完成" });
    if (res.output) { try { appendFileSync(path.join(artDir, "note.md"), `\n\n（工作台记录的最后一条 ${card.worker} 输出）\n` + res.output.slice(0, 4000)); } catch {} }
    emit("auto_done", card.id, { worker: card.worker });
  } else {
    transition(card.id, "claimed", "human", { worker: card.worker, note: "自动执行失败 " + res.error + (res.detail ? "；细节：" + String(res.detail).replace(/\s+/g, " ").slice(0, 200) : "") });
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
    cardId, prompt: reviewPromptText, workdir: ROOT, timeoutMin: REVIEW_MIN, purpose: "review", scope: "review",
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
    // 开关在 guardrails.autoRedispatchOnce；次数上限在 reviewPolicy.maxAutoRedispatch（默认 1）
    const allowRedispatch = CFG.guardrails?.autoRedispatchOnce === true && Number(CFG.reviewPolicy?.maxAutoRedispatch ?? 1) > 0;
    if (!already && allowRedispatch) {
      transition(cardId, "review", "fail", { worker: parsed.worker, note: "不通过，带意见自动重派一次，详见 reviews/" + cardId });
      const again = { ...parsed, id: cardId, 做什么: parsed.做什么 + "\n\n【上一轮验收不通过，请照下面意见补齐】\n" + text.slice(0, 1500) };
      if (isAutoWorker(parsed.worker)) { transition(cardId, "fail", "todo", { worker: parsed.worker, note: "自动重派" }); queueAuto(again); }
      else { transition(cardId, "fail", "waiting", { worker: parsed.worker, note: "验收不通过，需人工重派（意见在 reviews/）" }); emit("needs_trigger", cardId, { worker: parsed.worker, reason: "redispatch" }); }
    } else {
      transition(cardId, "review", "human", { worker: parsed.worker, note: already ? "不通过且自动重派已用尽" : "不通过，自动重派未开启" });
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
  const used = usedToday();
  for (const c of allCards()) {
    if (c.state !== "todo") continue;
    if (!isAutoWorker(c.worker)) continue;
    if (autoQueue.some((q: any) => q.id === c.id) || running.has(c.id + ":exec")) continue;
    if (!depsPass(c)) continue;
    if (used >= GUARD.dailyAutoRunBudget) {
      const key = `${day()}:${c.id}`;
      if (!budgetNotified.has(key)) {
        budgetNotified.add(key);
        emit("budget_block", c.id, { used, cap: GUARD.dailyAutoRunBudget, note: "今日自动预算用完了，这张卡排队等着；明天自动恢复，或去设置里调高预算" });
      }
      continue;
    }
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
    mode: c.mode || "", selfRun: isCommanderCard(c.worker),
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

  /* ---- 会话续接：查看 / 重置 ---- */
  if (url.pathname === "/api/sessions" && m === "GET") {
    const all = loadSessions();
    const rows = Object.entries(all).map(([key, v]: [string, any]) => ({
      key, worker: v.worker || key.split("::")[0], scope: v.scope || "default",
      id: v.id, short: String(v.id || "").slice(0, 8),
      turns: v.turns || 0, updatedAt: v.updatedAt || "", source: v.source || "",
      workerTitle: titleOf(v.worker || key.split("::")[0]),
    })).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return ok({ sessions: rows, workers: Object.keys(WORKERS).map((n) => ({ name: n, title: titleOf(n) })) });
  }
  if (url.pathname === "/api/sessions/reset" && m === "POST") {
    const b = await req.json().catch(() => ({}));
    const worker = String(b?.worker || "").trim();
    if (!worker || !WORKERS[worker]) return err("未知工具", 400);
    const scope = b?.scope === undefined || b?.scope === null ? undefined : String(b.scope);
    resetSession(worker, scope);
    emit("session_reset", null, { worker, scope: scope ?? "all" });
    return ok({ reset: true, worker, scope: scope ?? "all" });
  }

  if (url.pathname === "/api/state") {
    const all = allCards();
    const workers = await probe();
    return ok({
      root: ROOT,
      jobs: listJobs().map((j: any) => summarizeJob(j, all)),
      workers,
      guard: {
        ...GUARD, runningNow: running.size, usedToday: usedToday(), budgetLeft: Math.max(0, GUARD.dailyAutoRunBudget - usedToday()),
        councilCap: Number(COUNCIL.councilBudgetPerDay || 0), councilUsed: councilUsedToday(),
        councilLeft: Math.max(0, Number(COUNCIL.councilBudgetPerDay || 0) - councilUsedToday()),
        councilDefault: COUNCIL.councilDefault === true, councilActive: councilSeatsActive,
      },
    });
  }

  if (url.pathname === "/api/jobs" && m === "POST") {
    const b = await req.json();
    const files: Attachment[] = Array.isArray(b?.files) ? b.files.filter((f: any) => f && f.path) : [];
    let text = String(b?.text || "").trim();
    if (text.length < 2 && !files.length) return err("先写一句你想让 AI 帮你做什么");
    if (text.length < 2) text = "看这些附件，按里面的内容处理。";
    const id = nextJobId();
    // 附件先落到这个对话的目录下，再把清单拼进正文
    if (files.length) {
      for (const f of files) {
        try {
          const src = String(f.path);
          const target = path.join(attachDir(id), safeFileName(f.name || path.basename(src)));
          if (existsSync(src) && path.resolve(src) !== path.resolve(target)) writeFileSync(target, readFileSync(src));
          f.path = existsSync(target) ? target : src;
        } catch { /* 挪不动就保留原路径 */ }
      }
    }
    text = withAttachments(text, files);
    return ok(newJob(text, b.auto !== false, typeof b.council === "boolean" ? b.council : undefined));
  }

  if (seg[1] === "jobs" && seg[2]) {
    const jobId = seg[2];
    const job = readJob(jobId);
    if (!job) return err("没有这个对话", 404);

    if (m === "GET" && !seg[3]) {
      const cards = allCards().filter((c: any) => c.job === jobId).map(cardView);
      const all = allCards();
      const planLive: Record<string, any> = {};
      for (const r of job.rounds) {
        if (r.status === "planning" && liveNow[jobId + "-" + r.id]) planLive[r.id] = liveNow[jobId + "-" + r.id];
        if (r.status === "council") {
          const seatsLive: Record<string, any> = {};
          for (const s of (r.council?.seats || [])) { const l = liveNow[jobId + "-" + r.id + ":" + s.id]; if (l) seatsLive[s.id] = l; }
          if (Object.keys(seatsLive).length) planLive[r.id] = seatsLive;
        }
      }
      return ok({ job, status: jobStatus(job, all.filter((c: any) => c.job === jobId)), cards, events: jobEvents(jobId), planLive, workers: await probe() });
    }
    if (m === "POST" && seg[3] === "say") {
      const b = await req.json();
      const files: Attachment[] = Array.isArray(b?.files) ? b.files.filter((f: any) => f && f.path) : [];
      let text = String(b?.text || "").trim();
      if (text.length < 2 && !files.length) return err("说点什么吧");
      if (text.length < 2) text = "看这些附件，按里面的内容继续处理。";
      const last = job.rounds[job.rounds.length - 1];
      if (last && (last.status === "planning")) return err(titleOf(commanderName()) + " 还在拆上一句话，稍等一下");
      if (last && last.status === "council") return err("参谋团还在开会，稍等一下");
      if (files.length) {
        for (const f of files) {
          try {
            const src = String(f.path);
            const target = path.join(attachDir(jobId), safeFileName(f.name || path.basename(src)));
            if (existsSync(src) && path.resolve(src) !== path.resolve(target)) writeFileSync(target, readFileSync(src));
            f.path = existsSync(target) ? target : src;
          } catch { /* 保留原路径 */ }
        }
      }
      text = withAttachments(text, files);
      return ok({ roundId: startRound(jobId, text, b.auto !== false, typeof b.council === "boolean" ? b.council : undefined) });
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
        if (act === "answer") {
          const b = await req.json().catch(() => ({}));
          const text = String(b.text || "").trim();
          const r = job.rounds.find((x: any) => x.id === roundId);
          if (!r) return err("找不到这一轮", 404);
          if (!(r.questions || []).length) return err("这一轮没有待回答的问题", 409);
          if (r.status !== "draft") return err("这一轮现在不是待回答状态", 409);
          if (text.length < 2) return err("写一句你的回答");
          patchRound(jobId, roundId, { answers: text, status: "planning", summary: "", cards: [], dispatched: [], ok: undefined, finishedAt: undefined, error: "" });
          emit("plan_answered", `${jobId}-${roundId}`, { text: text.slice(0, 200) });
          runPlan(jobId, roundId);
          return ok();
        }
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
    const name = seg[2];
    if (!WORKERS[name]) return err("未知工具", 404);
    try {
      const d = await listModels(name);
      const list = d.list || [];
      const info = d.info || {};
      const picked = pickModel(name, list, info);
      if (picked) AUTO_PICK[name] = picked;
      return ok({
        models: list,
        info,
        // 设置页拿这个当"用推荐"按钮的目标
        recommended: picked || WORKERS[name].recommendedModel || "",
        free: list.filter((m) => creditsAreFree(info[m])),
        policy: WORKERS[name].modelPolicy || null,
        modelSource: modelSourceOf(name),
      });
    } catch (e: any) { return err(e.message || String(e), 502); }
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
    // 可带自定义口令和会话作用域：用来验证同一个作用域是不是真的接上了上一次
    const testPrompt = String(b?.prompt || "只回复两个字：收到").slice(0, 2000);
    const testScope = b?.scope === undefined ? "test" : String(b.scope);
    try {
      const res: any = await runAgent(name, { cardId: "TEST-" + name, prompt: testPrompt, workdir: ROOT, timeoutMin: Number(b?.timeoutMin || 2), purpose: "test", noTools: true, sandbox: "read-only", model, scope: testScope });
      const text = String(res.output || "").replace(/\s+/g, " ").trim().slice(0, 120);
      const swapped = String(res.fallback || "");
      const good = !!res.ok && text.length > 0 && !swapped;
      if (good) blockedCooldownClear(name);
      const why = swapped ? `这个模型现在用不了，工具悄悄换成了默认模型（${swapped}）。真跑任务也会这样换，请换一个` : (res.error || "没有收到回复");
      return ok({ ok: good, ms: Date.now() - t0, text, error: good ? "" : why, debug: String((res as any).detail || "").slice(0, 500) });
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

  /* ---- 附件上传 / 预览 ---- */
  if (url.pathname === "/api/upload" && m === "POST") {
    const jobId = String(url.searchParams.get("job") || "tmp");
    const isAvatar = url.searchParams.get("kind") === "avatar";
    if (isAvatar) mkdirSync(DIR_AVATAR, { recursive: true });
    let form: any;
    try { form = await req.formData(); }
    catch (e: any) { return err("上传内容解析失败（需要 multipart/form-data）：" + (e?.message || e), 400); }
    const dir = isAvatar ? DIR_AVATAR : attachDir(jobId);
    const saved: Attachment[] = [];
    const entries = form.getAll("files");
    if (!entries.length) return err("没有收到文件", 400);
    for (const entry of entries.slice(0, 10)) {
      if (typeof entry === "string") continue;
      const blob = entry as File;
      if (blob.size > ATTACH_LIMIT_BYTES) return err(`${blob.name} 超过 25MB`, 413);
      const name = safeFileName(blob.name || `pasted_${Date.now()}.png`);
      let target = path.join(dir, name);
      if (existsSync(target)) {
        const ext = path.extname(name);
        const stem = name.slice(0, name.length - ext.length);
        let i = 2;
        while (existsSync(target)) { target = path.join(dir, `${stem}_${i}${ext}`); i++; }
      }
      await Bun.write(target, blob);
      saved.push({ name: path.basename(target), path: target, kind: IMAGE_EXT.test(target) ? "image" : "file", size: blob.size });
    }
    if (!saved.length) return err("没有有效文件", 400);
    emit("attach_upload", null, { job: jobId, count: saved.length });
    return ok({ files: saved });
  }

  if (url.pathname === "/api/attachment" && m === "GET") {
    const p = String(url.searchParams.get("path") || "");
    const abs = path.resolve(p);
    const bases = [path.resolve(DIR_ATTACH), path.resolve(DIR_AVATAR)];
    if (!bases.some((b) => abs === b || abs.startsWith(b + path.sep))) return err("路径不合法", 400);
    if (!existsSync(abs)) return err("文件不存在", 404);
    const ext = path.extname(abs).toLowerCase();
    const type = ext === ".png" ? "image/png"
      : (ext === ".jpg" || ext === ".jpeg") ? "image/jpeg"
        : ext === ".webp" ? "image/webp"
          : ext === ".gif" ? "image/gif"
            : ext === ".bmp" ? "image/bmp" : "application/octet-stream";
    return new Response(Bun.file(abs), { headers: { "content-type": type, "cache-control": "max-age=3600" } });
  }

  /* ---- 参谋团设置：圆桌席位可视化编辑 ---- */
  const seatIdOk = (v: string) => /^[a-z0-9][a-z0-9_-]{0,23}$/i.test(v);
  const councilSkillDir = path.join(HERE, "council");

  if (url.pathname === "/api/council" && m === "GET") {
    const seats = (Array.isArray(COUNCIL.seats) ? COUNCIL.seats : []).map((s: any) => ({
      id: String(s.id || ""), name: String(s.name || s.id || ""), skill: String(s.skill || ""),
      tool: String(s.tool || "auto"), enabled: s.enabled !== false,
      avatar: String(s.avatar || ""),
      avatarUrl: s.avatar ? "/api/attachment?path=" + encodeURIComponent(String(s.avatar)) : "",
      skillExists: (() => { try { return existsSync(path.join(ROOT, String(s.skill || ""))); } catch { return false; } })(),
    }));
    let skills: any[] = [];
    try {
      skills = readdirSync(councilSkillDir).filter((f) => f.endsWith(".md")).map((f) => ({ file: `console/council/${f}`, id: f.slice(0, -3) }));
    } catch { /* 目录不存在就是还没有人格文件 */ }
    const tools = Object.keys(WORKERS).map((n) => ({ name: n, title: titleOf(n), role: roleOf(n), ok: canRun(n), blockedSec: blockedSecFor(n) }));
    return ok({
      councilDefault: COUNCIL.councilDefault === true,
      councilBudgetPerDay: Number(COUNCIL.councilBudgetPerDay || 0),
      seats, skills, tools, usedToday: councilUsedToday(),
    });
  }

  if (url.pathname === "/api/council" && m === "POST") {
    const b = await req.json();
    const rawSeats = Array.isArray(b?.seats) ? b.seats : [];
    if (rawSeats.length > 8) return err("参谋席位最多 8 个");
    const seen = new Set<string>();
    const seats: any[] = [];
    for (const s of rawSeats) {
      const id = String(s?.id || "").trim();
      if (!seatIdOk(id)) return err(`席位 id 不合法：${id || "(空)"}（只能用小写字母数字和 - _）`);
      if (seen.has(id)) return err(`席位 id 重复：${id}`);
      seen.add(id);
      const name = String(s?.name || "").trim().slice(0, 24) || id;
      const tool = String(s?.tool || "auto").trim();
      if (tool !== "auto" && !WORKERS[tool]) return err(`席位 ${id} 指了不存在的工具：${tool}`);
      let skill = String(s?.skill || "").trim();
      if (!skill) skill = `console/council/${id}.md`;
      if (!/^console[\\/]council[\\/][\w.-]+\.md$/.test(skill)) return err(`席位 ${id} 的人格文件路径不合法：${skill}`);
      let avatar = String(s?.avatar || "").trim().replace(/\\/g, "/");
      if (avatar) {
        const absA = path.resolve(avatar);
        const baseA = path.resolve(DIR_AVATAR);
        if (!absA.startsWith(baseA + path.sep) || !IMAGE_EXT.test(absA)) return err(`席位 ${id} 的头像路径不合法：${avatar}`);
        avatar = absA;
      }
      seats.push({ id, name, skill: skill.replace(/\\/g, "/"), tool, enabled: s?.enabled !== false, ...(avatar ? { avatar } : {}) });
    }
    const budget = Math.max(0, Math.min(200, Number(b?.councilBudgetPerDay ?? 0) | 0));
    const payload = { councilDefault: b?.councilDefault === true, councilBudgetPerDay: budget, seats };
    try { writeFileSync(COUNCIL_FILE, JSON.stringify(payload, null, 2) + "\n"); }
    catch (e: any) { return err("写入 config/council.json 失败：" + (e.message || e)); }
    COUNCIL = loadCouncil();
    emit("council_config", null, { seats: seats.length, default: payload.councilDefault });
    return ok({ saved: true, seats: seats.length });
  }

  // 一键铺一套经典席位（只补缺的人格文件，不覆盖你改过的）
  if (url.pathname === "/api/council/preset" && m === "POST") {
    const roster = [
      { id: "munger", name: "芒格参谋", tool: "codex" },
      { id: "musk", name: "马斯克参谋", tool: "workbuddy" },
      { id: "bezos", name: "贝索斯参谋", tool: "auto" },
      { id: "jobs", name: "乔布斯参谋", tool: "auto" },
    ];
    mkdirSync(councilSkillDir, { recursive: true });
    for (const r of roster) {
      const abs = path.join(councilSkillDir, `${r.id}.md`);
      if (!existsSync(abs)) {
        writeFileSync(abs, `# ${r.name}\n\n（人格文件占位：把「${r.name}」的思维方式、判断标准和输出契约写在这里。）\n\n## 输出契约\n\n1. 核心判断\n2. 依据\n3. 风险\n4. 下一步\n`);
      }
    }
    return ok({ created: roster.map((r) => `console/council/${r.id}.md`) });
  }

  if (url.pathname === "/api/council/skill" && m === "GET") {
    const file = String(url.searchParams.get("file") || "");
    if (!/^console[\\/]council[\\/][\w.-]+\.md$/.test(file)) return err("路径不合法", 400);
    try { return ok({ file, content: readFileSync(path.join(ROOT, file), "utf8") }); }
    catch { return ok({ file, content: "", missing: true }); }
  }
  if (url.pathname === "/api/council/skill" && m === "POST") {
    const b = await req.json();
    const file = String(b?.file || "");
    if (!/^console[\\/]council[\\/][\w.-]+\.md$/.test(file)) return err("路径不合法", 400);
    const content = String(b?.content ?? "");
    if (content.length > 60_000) return err("人格文件太长（上限 60000 字符）");
    try { mkdirSync(councilSkillDir, { recursive: true }); writeFileSync(path.join(ROOT, file), content); }
    catch (e: any) { return err("写入人格文件失败：" + (e.message || e)); }
    return ok({ saved: true, file });
  }

  /* ---- 流程模板 ---- */
  if (url.pathname === "/api/flows" && m === "GET") {
    const flows = loadFlows().map((f: any) => ({
      ...f,
      steps: f.steps.map((s: any) => {
        const w = resolvePlanWorker(s.worker);
        return { ...s, worker: w, workerTitle: titleOf(w), workerOk: canRun(w) };
      }),
    }));
    return ok({ flows, tools: Object.keys(WORKERS).map((n) => ({ name: n, title: titleOf(n), ok: canRun(n), role: roleOf(n) })) });
  }
  if (url.pathname === "/api/flows" && m === "POST") {
    const b = await req.json();
    const list = Array.isArray(b?.flows) ? b.flows : [];
    if (list.length > 20) return err("流程最多 20 个");
    const seen = new Set<string>();
    for (const f of list) {
      const bad = validateFlow(f);
      if (bad) return err(bad);
      if (seen.has(f.id)) return err(`流程 id 重复：${f.id}`);
      seen.add(f.id);
    }
    try { saveFlows(list); } catch (e: any) { return err("写入 config/flows.json 失败：" + (e.message || e)); }
    emit("flows_config", null, { flows: list.length });
    return ok({ saved: true, flows: list.length });
  }
  if (url.pathname === "/api/flows/run" && m === "POST") {
    const b = await req.json();
    const flowId = String(b?.flowId || "");
    const flow = loadFlows().find((f: any) => f.id === flowId);
    if (!flow) return err("找不到这个流程：" + flowId, 404);
    const goal = String(b?.text || flow.desc || flow.name).trim().slice(0, 2000);
    if (goal.length < 2) return err("先写一句这次要做什么");
    const extra = goal === (flow.desc || flow.name) ? "" : goal;
    const cards = flow.steps.map((s: any, i: number) => {
      const card = flowStepToCard(s, i, flow.id);
      if (extra) card.做什么 = `${card.做什么}\n\n【本次的具体要求】\n${extra}`;
      return card;
    });
    const id = nextJobId();
    const title = `${flow.name} · ${goal}`.replace(/\s+/g, " ").slice(0, 28) + "…";
    writeJob({ id, title, createdAt: stamp(), updatedAt: stamp(), archived: false, councilOn: false, flow: flow.id, rounds: [] });
    writeFileSync(path.join(DIR_INTAKE, `${id}.md`), `# ${id}（流程：${flow.name}）\n\n${goal}\n\n发布时间：${stamp()}\n`);
    const job = readJob(id)!;
    job.rounds.push({
      id: "R1", text: goal, at: stamp(), status: "draft", auto: true, councilOn: false,
      flow: flow.id, planFrom: "flow", cards, dispatched: [],
      summary: `按「${flow.name}」模板直接派工：${flow.steps.length} 步，不经过拆单。`,
    });
    job.updatedAt = stamp();
    writeJob(job);
    emit("round_started", `${id}-R1`, { text: goal.slice(0, 200), flow: flow.id });
    const created = await dispatchRound(id, "R1", cards);
    return ok({ id, roundId: "R1", cards: created.map((c: any) => ({ id: c.id, worker: c.worker, title: c.title })) });
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
      // 前端文件：console/ 根目录，以及 console/assets/ 下的图片（AI 生成的底图放这里）
      const isAsset = /^assets\/[\w.-]+\.(png|jpe?g|webp|svg)$/i.test(file);
      if (!isAsset && !/^[\w.-]+\.(html|css|js)$/.test(file)) return new Response("404", { status: 404 });
      const target = path.join(HERE, file);
      if (!existsSync(target)) return new Response("404 工作台前端缺失：console/" + file, { status: 404 });
      const type = file.endsWith(".css") ? "text/css"
        : file.endsWith(".js") ? "text/javascript"
          : /\.png$/i.test(file) ? "image/png"
            : /\.jpe?g$/i.test(file) ? "image/jpeg"
              : /\.webp$/i.test(file) ? "image/webp"
                : /\.svg$/i.test(file) ? "image/svg+xml" : "text/html";
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

hydrateKeys();
console.log(`AI 指挥台 → http://127.0.0.1:${server.port}   根目录 ${ROOT}   轮询 ${POLL / 1000}s   指挥官=${titleOf(commanderName())}`);
refreshIndex();
recoverOrphans();
