/**
 * 额外执行体（runners-extra）——把已跑通的三类接入合进指挥台，不动原有执行体。
 *
 * 支持三种 runner.kind：
 *   trae      TRAE CLI 一次性执行（traecli exec --json -o <file>）
 *   acp-http  接桌面 App 自带的 ACP 网关（WorkBuddy AI 国际版走这条）
 *   acp-stdio 接 IDE 内置的 ACP worker（Qoder 国际版走这条）
 *
 * 与 runCodex / runCodebuddy 保持同一契约：返回 { ok, code, output, error, detail }，
 * 并复用 server.ts 传进来的 emit 发事件，所以前端的时间线和日志流不用改。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/* ACP 客户端直接复用已经跑通的那份实现，避免复制一份会漂移的代码。 */
const ACP_MODULE = "file:///D:/dsh/plugins/dsh-subagent-external/lib/acp-transport.mjs";
let acpModule: any = null;
async function acp() {
  if (!acpModule) acpModule = await import(ACP_MODULE);
  return acpModule;
}

export type ExtraRunArgs = {
  cardId: string;
  worker: string;
  prompt: string;
  workdir: string;
  addDir: string;
  timeoutMin: number;
  model?: string;
  /** server.ts 的事件发射器，签名与 emit(type, card, data) 一致 */
  emit: (type: string, card: string | null, data?: any) => void;
  /** 临时目录，用于 -o/--output-last-message 落盘 */
  tmpDir: string;
  /** 该 worker 的 runner 配置 */
  runner: any;
  /** 会话续接：有这个 id 就 resume 同一条对话 */
  sessionId?: string;
  /** 需要新建会话时用这个 id 占号（支持 --session-id 的 CLI 用） */
  createSessionId?: string;
  /** 本次跑完如果拿到/新建了会话 id，回调给 server.ts 存起来 */
  onSessionId?: (id: string) => void;
};

type RunResult = { ok: boolean; code?: number; output: string; error: string; detail: string; raw?: string };

const tail = (lines: string[], n = 8) => lines.slice(-n).join(" ｜ ");

/* ------------------------------------------------------------------ trae --- */

/**
 * TRAE CLI 非交互执行。
 *
 * 它和 Codex 的同族用法一致：`exec` 子命令、`--json` 出 JSONL、`-o` 把最后一条
 * 回复单独写文件。答案优先读 `-o` 文件——命令行 stdout 前面有 banner
 * （`TRAE CLI v0.209.1` / workdir / model / provider），直接当答案会脏。
 */
export async function runTrae(a: ExtraRunArgs): Promise<RunResult> {
  const r = a.runner ?? {};
  const exe = r.bin;
  if (!exe || !existsSync(exe)) {
    return { ok: false, output: "", error: "找不到 traecli 可执行文件（runner.bin）", detail: "" };
  }
  mkdirSync(a.workdir, { recursive: true });
  const lastFile = path.join(a.tmpDir, `${a.cardId}.trae.last.md`);
  try { writeFileSync(lastFile, ""); } catch { /* 目录不存在会在下面报错 */ }

  const cmd = [exe, "exec"];
  /* 会话续接：`exec resume <id>` 接着上次那条对话。
     注意 resume 不接受 -C / --add-dir；但**必须**带 -y 和 --skip-git-repo-check，
     否则报 "Not inside a trusted directory"。工作目录靠子进程 cwd。 */
  if (a.sessionId) {
    cmd.push("resume", a.sessionId, "--json", "-y", "--skip-git-repo-check", "--output-last-message", lastFile);
  } else {
    cmd.push("--json", "-y", "-C", a.workdir, "--output-last-message", lastFile, "--add-dir", a.addDir);
  }
  if (a.model) cmd.push("-m", a.model);
  // 口令里出现的图片路径以 -i 传进去，让它真的看见图
  const imgRe = /([A-Za-z]:[\\/][^\s"'<>｜|]+?\.(?:png|jpe?g|webp|gif|bmp))/gi;
  const seenImg = new Set<string>();
  let mm: RegExpExecArray | null;
  while ((mm = imgRe.exec(a.prompt)) && seenImg.size < 6) {
    const p = mm[1].replace(/[),。；;]+$/, "");
    if (seenImg.has(p)) continue;
    try { if (existsSync(p)) { seenImg.add(p); cmd.push("-i", p); } } catch { /* 路径非法跳过 */ }
  }
  cmd.push(a.prompt);

  a.emit("autostart", a.cardId, {
    worker: a.worker, purpose: "exec",
    workdir: path.relative(a.addDir, a.workdir).replace(/\\/g, "/") || ".",
  });

  const res = await runChild(cmd, {
    cwd: a.workdir,
    env: { ...process.env },
    timeoutMin: a.timeoutMin,
    tmpDir: a.tmpDir,
    cardId: a.cardId,
    worker: a.worker,
    emit: a.emit,
    lastFile,
  });
  // 首次跑完把会话 id 抓出来（Trae 在 thread.started 事件里），下次直接用 `exec resume` 接上
  if (!a.sessionId && res.ok) {
    const src = String(res.raw || "") + "\n" + String(res.output || "");
    const m = src.match(/"thread_id"\s*:\s*"([0-9a-fA-F-]{8,})"/i)
      || src.match(/"(?:session_?id|conversation_?id)"\s*:\s*"([0-9a-fA-F-]{8,})"/i)
      || src.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
    if (m) a.onSessionId?.(m[1]);
  }
  return res;
}

/* --------------------------------------------------------------- acp-http --- */

/**
 * 通过桌面 App 自带的 ACP 网关执行。
 *
 * WorkBuddy AI 的 CLI 用 CN 的 CODEBUDDY_API_KEY 会被 401 拒（两个产品域名不同），
 * 但桌面 App 的登录态会在内存里注入给它自己起的网关，所以走网关是这条唯一的
 * 认证路径。网关端口每次启动都变，因此按 `processName` 认领监听端口——
 * 两个 WorkBuddy 的 ACP 握手逐字节相同，只有宿主进程名能区分。
 */
export async function runAcpHttp(a: ExtraRunArgs): Promise<RunResult> {
  const r = a.runner ?? {};
  const { HttpAcpSession, attachPermissionAutoResponder } = await acp();

  a.emit("autostart", a.cardId, { worker: a.worker, purpose: "exec", workdir: "." });

  const baseUrl = await resolveGateway(r.processName, r.baseUrl);
  if (!baseUrl) {
    return {
      ok: false, output: "",
      error: `找不到 ${a.worker} 的 ACP 网关——先把 ${r.appTitle || a.worker} 打开并开一个对话`,
      detail: "",
    };
  }
  a.emit("worker_event", a.cardId, { worker: a.worker, kind: "gateway", text: baseUrl });

  const session = new HttpAcpSession({
    baseUrl,
    headers: r.headers ?? { "x-codebuddy-request": "1" },
    requestTimeoutMs: a.timeoutMin * 60_000,
  });
  const notes: string[] = [];
  attachPermissionAutoResponder(session, (n: string) => {
    notes.push(n);
    a.emit("worker_event", a.cardId, { worker: a.worker, kind: "permission", text: n });
  });
  session.onUpdate((params: any) => {
    const u = params?.update ?? {};
    if (u.sessionUpdate === "tool_call") {
      a.emit("worker_event", a.cardId, {
        worker: a.worker, kind: "tool_call",
        text: `${u.kind ?? ""} ${u.title ?? ""}`.trim().slice(0, 300),
      });
    }
  });

  try {
    await session.connect();
    await session.initialize({ clientName: "ai-console" });
    const created = await session.request("session/new", { cwd: a.workdir, mcpServers: [] });
    const sessionId = created?.sessionId;
    if (!sessionId) throw new Error("session/new 没有返回 sessionId");

    // 模型：网关的 session/new 会带回可选模型；选了就发 set_model，
    // 不支持就算了（不让选模型失败拖垮整张卡）。
    if (a.model) {
      try {
        await session.request("session/set_model", { sessionId, modelId: a.model }, { timeoutMs: 15_000 });
        a.emit("worker_event", a.cardId, { worker: a.worker, kind: "model", text: a.model });
      } catch { /* 网关不支持切模型时忽略 */ }
    }

    const turn = await session.prompt(sessionId, a.prompt);
    const text = String(turn?.text ?? "").trim();
    const stop = String(turn?.stopReason ?? "");
    const ok = stop === "end_turn" || stop === "completed";
    // 网关会复用桌面 App 里正在聊的那个对话，所以它有一种可预期的失败：拒答
    // （对话历史太长/上下文不适合再塞任务）。必须判失败并说清怎么修，否则卡里
    // 会拿到一段和任务无关的旧文本当成产出。
    const why = ok ? "" : stop === "refusal"
      ? "网关拒答：它复用的是桌面 App 里当前那个对话，历史太长时不会再接新任务。"
        + "去 WorkBuddy AI 里新开一个对话（或清理当前对话）后重试。"
      : `ACP 轮次以 ${stop || "未知原因"} 结束`;
    return { ok, code: ok ? 0 : 1, output: text, error: why, detail: notes.join(" ｜ ") };
  } catch (error: any) {
    return { ok: false, output: "", error: `ACP 失败：${error.message}`, detail: notes.join(" ｜ ") };
  } finally {
    try { session.close(); } catch { /* 已经关了 */ }
  }
}

/* -------------------------------------------------------------- acp-stdio --- */

/**
 * 通过 IDE 内置的 ACP worker 执行（stdio，每轮一个短命进程）。
 *
 * Qoder 的 `--acp` 是代码里 `.hideHelp()` 藏起来的参数，`--help` 看不到；
 * 这里按已验证的调用方式：`<node> <worker.mjs> --permission-mode bypass_permissions [-m model] --acp`。
 */
export async function runAcpStdio(a: ExtraRunArgs): Promise<RunResult> {
  const r = a.runner ?? {};
  const { StdioAcpSession, attachPermissionAutoResponder } = await acp();

  a.emit("autostart", a.cardId, { worker: a.worker, purpose: "exec", workdir: "." });

  const args = [...(r.args ?? []), "--acp"];
  if (a.model) args.push("-m", a.model);

  const session = new StdioAcpSession({
    command: r.command,
    args,
    cwd: r.processCwd ?? a.workdir,
    env: r.env ?? {},
    requestTimeoutMs: a.timeoutMin * 60_000,
    onStderr: (chunk: string) => {
      const t = String(chunk).trim();
      if (t) a.emit("worker_stderr", a.cardId, { worker: a.worker, text: t.slice(0, 300) });
    },
  });
  const notes: string[] = [];
  attachPermissionAutoResponder(session, (n: string) => notes.push(n));

  try {
    await session.connect();
    await session.initialize({ clientName: "ai-console" });
    const created = await session.request("session/new", { cwd: a.workdir, mcpServers: [] });
    const sessionId = created?.sessionId;
    if (!sessionId) throw new Error("session/new 没有返回 sessionId");
    const turn = await session.prompt(sessionId, a.prompt);
    const text = String(turn?.text ?? "").trim();
    const ok = turn?.stopReason === "end_turn" || turn?.stopReason === "completed";
    return {
      ok,
      code: ok ? 0 : 1,
      output: text,
      error: ok ? "" : `ACP 轮次以 ${turn?.stopReason} 结束`,
      detail: notes.join(" ｜ "),
    };
  } catch (error: any) {
    return { ok: false, output: "", error: `ACP(stdio) 失败：${error.message}`, detail: notes.join(" ｜ ") };
  } finally {
    try { session.close(); } catch { /* 已经关了 */ }
  }
}

/* ------------------------------------------------------------------ 公共 --- */

/**
 * 问 ACP 网关"你有哪些模型"。
 *
 * `session/new` 的响应里带 `models.availableModels`，每项有 `_meta.credits`
 * （如 `x0.34 credits`，空串表示不计倍率）。这是 WorkBuddy AI 唯一能拿到
 * "哪个模型免费"的地方——它的 CLI 用 CN 的 key 会 401，只能走网关。
 */
export async function listGatewayModels(
  processName: string,
  baseUrl?: string,
): Promise<Array<{ id: string; name: string; credits: string }>> {
  const { HttpAcpSession } = await acp();
  const resolved = await resolveGateway(processName, baseUrl);
  if (!resolved) throw new Error("找不到网关（先把 App 打开并开一个对话）");

  const session = new HttpAcpSession({
    baseUrl: resolved,
    headers: { "x-codebuddy-request": "1" },
    requestTimeoutMs: 30_000,
  });
  try {
    await session.connect();
    await session.initialize({ clientName: "ai-console" });
    const created = await session.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    const raw = created?.models?.availableModels ?? [];
    const out: Array<{ id: string; name: string; credits: string }> = [];
    for (const m of raw) {
      const id = String(m?.modelId ?? m?.id ?? "").trim();
      if (!id) continue;
      out.push({
        id,
        name: String(m?.name ?? id),
        credits: String(m?._meta?.credits ?? "").replace(/\s*credits$/i, "").trim(),
      });
    }
    return out;
  } finally {
    try { session.close(); } catch { /* 已经关了 */ }
  }
}

/** 一次 PowerShell 查询拿到「端口 → 宿主进程名」，两个 WorkBuddy 只能靠这个区分。 */
async function listeningPortsWithNames(): Promise<Array<{ port: number; name: string }>> {
  const ps = [
    "Get-NetTCPConnection -State Listen | ForEach-Object {",
    "  $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue;",
    "  if ($p) { '{0}|{1}' -f $_.LocalPort, $p.ProcessName }",
    "} | Sort-Object -Unique",
  ].join(" ");
  const out = await new Promise<string>((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    });
    let buf = "";
    child.stdout?.on("data", (c) => { buf += c.toString(); });
    child.on("error", () => resolve(""));
    child.on("exit", () => resolve(buf));
  });
  const rows: Array<{ port: number; name: string }> = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\d{2,5})\|(\S+)$/.exec(line.trim());
    if (m) rows.push({ port: Number(m[1]), name: m[2] });
  }
  return rows;
}

/**
 * 找出某个 App 的 ACP 网关地址。
 *
 * 顺序：显式 baseUrl（能用就用）→ 按宿主进程名认领端口 → 逐个做 ACP 握手确认。
 * 端口是动态的，所以不能只信配置；但也不能盲扫（两个 WorkBuddy 握手一样，
 * 扫错就拿到别人账号的答案），必须进程名过滤。
 */
async function resolveGateway(processName: string, baseUrl?: string): Promise<string | null> {
  const { HttpAcpSession } = await acp();
  const probe = async (url: string) => {
    const s = new HttpAcpSession({
      baseUrl: url,
      headers: { "x-codebuddy-request": "1" },
      requestTimeoutMs: 6_000,
    });
    try { await s.connect(); return true; } catch { return false; } finally { s.close(); }
  };

  if (baseUrl && await probe(baseUrl)) return baseUrl;
  if (!processName) return null;

  const rows = await listeningPortsWithNames();
  const candidates = rows
    .filter((row) => row.name.toLowerCase() === processName.toLowerCase())
    .map((row) => row.port);
  for (const port of candidates) {
    const url = `http://127.0.0.1:${port}`;
    if (await probe(url)) return url;
  }
  return null;
}

/** 跑一个子进程，统一收 stdout/stderr、超时、尾部诊断。 */
async function runChild(cmd: string[], o: {
  cwd: string; env: Record<string, any>; timeoutMin: number;
  tmpDir: string; cardId: string; worker: string;
  emit: (type: string, card: string | null, data?: any) => void;
  lastFile: string;
}): Promise<RunResult> {
  let proc: any;
  try {
    proc = spawn(cmd[0], cmd.slice(1), {
      cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
  } catch (error: any) {
    return { ok: false, output: "", error: "spawn-failed: " + error.message, detail: "" };
  }

  let killed = false;
  const killer = setTimeout(() => {
    killed = true;
    try { proc.kill(); } catch { /* 已经退出 */ }
    o.emit("card_timeout", o.cardId, { timeoutMin: o.timeoutMin });
  }, o.timeoutMin * 60_000);

  let stdoutText = "";
  const errTail: string[] = [];
  const consume = async (stream: any, isErr: boolean) => {
    if (!stream) return;
    let buf = "";
    for await (const chunk of stream) {
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        if (isErr) { errTail.push(line.slice(0, 300)); if (errTail.length > 8) errTail.shift(); continue; }
        stdoutText += line + "\n";
        try {
          const j = JSON.parse(line);
          const item = j?.item;
          const cand = item?.type === "agent_message" ? item.text
            : (j?.message?.content?.[0]?.text ?? j?.text ?? j?.result ?? null);
          if (typeof cand === "string" && cand.trim()) {
            o.emit("worker_event", o.cardId, {
              worker: o.worker, kind: String(j.type ?? j.item_type ?? "event").slice(0, 40),
              text: cand.slice(0, 600),
            });
          }
        } catch { /* banner / 非 JSON 行 */ }
      }
    }
  };
  await Promise.all([consume(proc.stdout, false), consume(proc.stderr, true)]);
  const code: number = await new Promise((resolve) => proc.on("exit", (c: number) => resolve(c ?? -1)));
  clearTimeout(killer);

  const last = existsSync(o.lastFile) ? readFileSync(o.lastFile, "utf8").trim() : "";
  const ok = code === 0 && !killed && !/Authentication required|Not logged in|Please use \/login/i.test(last);
  if (!ok && /Authentication required|Not logged in|\/login/i.test(last + " " + errTail.join(" "))) {
    errTail.push("命令行未登录：先在终端跑一次登录");
  }
  o.emit("worker_exit", o.cardId, { worker: o.worker, purpose: "exec", code, ok, killed });
  return {
    ok,
    code,
    output: last || stdoutText.trim(),
    // 原始 JSON 流也带上：抓会话 id（thread.started）要看完整的流，不能只看最后一条回复
    raw: stdoutText,
    error: ok ? "" : (killed ? `超过 ${o.timeoutMin} 分钟被中止` : `${o.worker} 退出码 ${code}`),
    detail: tail(errTail),
  };
}
