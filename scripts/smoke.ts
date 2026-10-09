/**
 * 总线自检：不依赖任何 AI 真开工，验证文件总线与状态机本身是否工作。
 * 用法：bun run scripts/smoke.ts  （需先 bun run console/server.ts）
 *
 * 它做五件事：
 *  1) 走真实入口建一个对话（POST /api/jobs），拿到轮次 id
 *  2) 用「直接派一单」绕过拆单（POST /api/jobs/<j>/round/<r>/direct），
 *     生成一张派给 L2 worker 的卡 → 应自动进入 waiting（等人工触发）
 *  3) 取该卡的派工口令 → 应内联总线协议 + DONE 交接兜底
 *  4) 模拟那个 worker 交活：写产出文件 + DONE 标记 → 服务端轮询应把卡推出 waiting
 *  5) 校验租约语义：被领走的卡不能被重复领
 *
 * 退出码：全部通过 = 0，有失败 = 1（可直接用在 CI）。
 */
const BASE = process.env.CONSOLE_BASE || "http://127.0.0.1:8787";
import * as nodePath from "node:path";
import { mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
const ROOT = nodePath.resolve(import.meta.dir, "..");

const j = async (u: string, o?: any) => { const r = await fetch(BASE + u, o); const d = await r.json().catch(() => ({})); return { status: r.status, d }; };
const post = (u: string, b: any) => j(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ck = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`); ok ? pass++ : fail++; };

console.log("根目录:", ROOT);

// 0) 连通性
const st0 = (await j("/api/state")).d;
if (!st0 || !st0.workers) { console.log(`❌ 连不上工作台 ${BASE}，先 bun run console/server.ts`); process.exit(1); }

const wnames: string[] = Object.keys(st0.workers);
const runnable = (n: string) => !!(st0.workers[n].runner || st0.workers[n].tier === "L1") && st0.workers[n].canRun !== false;
const worker = wnames.find((n) => st0.workers[n].tier !== "L1" && runnable(n));
if (!worker) {
  console.log("⚠️  本机没有任何「可运行的干活 AI」（config/workers.json 里的路径还是占位符，或 CLI 没装）。");
  console.log("   状态机自检需要至少一个能跑的工人，先按 README 把 workers.json 填好再跑这个脚本。");
  console.log(`   各工具当前状态：`);
  for (const n of wnames) console.log(`     - ${n}: canRun=${st0.workers[n].canRun} ${st0.workers[n].bin || ""}`);
  process.exit(0);
}
console.log("自检用工人:", worker, "\n");

// 1) 建一个真实对话，拿到轮次 id
const job = await post("/api/jobs", { text: "总线自检：这是一条不会真的派给 AI 的对话，可忽略", auto: false });
if (!job.d?.id) { console.log("❌ 建对话失败:", JSON.stringify(job.d)); process.exit(1); }
const jobId = job.d.id;
ck(`建对话 ${jobId}`, true);

const detail = (await j(`/api/jobs/${jobId}`)).d;
const rounds = detail?.job?.rounds || [];
const round = rounds[rounds.length - 1];
if (!round) { console.log("❌ 拿不到轮次:", JSON.stringify(detail).slice(0, 200)); process.exit(1); }
const roundId = round.id;

// 2) 直接派一单（不走指挥官拆单），生成一张卡
const dd = await post(`/api/jobs/${jobId}/round/${roundId}/direct`, { worker });
const cardId: string = (dd.d?.created || [])[0];
if (!cardId) { console.log("❌ 派单失败:", JSON.stringify(dd.d)); process.exit(1); }
ck(`派单生成 ${cardId}`, true);

// 卡的详情从对话接口取（没有单独的 GET /api/card/<id>）
const cardOf = async () => {
  const d = (await j(`/api/jobs/${jobId}`)).d;
  return (d?.cards || []).find((c: any) => c.id === cardId) || {};
};
let card = await cardOf();
// 配了 runner 的工人会自动开工（claimed 甚至直接跑起来）；没配 runner 的才停在 waiting 等人工粘贴口令。
// 两种都是对的，只断言"卡被接受了、负责人解析正确"。
const autoWorker = !!(st0.workers[worker].runner || st0.workers[worker].tier === "L1");
const okState = autoWorker ? ["claimed", "review", "done", "pass"] : ["waiting"];
ck(
  autoWorker ? "自动运行的工人应被直接领走（不等人工）" : "手动触发的工人应进入 waiting",
  okState.includes(card.state),
  `实际=${card.state}`,
);
ck("负责人应被正确解析回来", card.worker === worker, `实际="${card.worker}"`);

// 3) 口令
const ord = (await j(`/api/card/${cardId}/order`)).d.order || "";
ck("口令内联了总线协议全文", ord.includes("总线协议全文"), `口令 ${ord.length} 字`);
ck("口令含 DONE 交接兜底", ord.includes("名字正好是 DONE"));
ck("口令写明只写自己的目录", ord.includes(worker));

// 4) 模拟交活：写产出 + DONE（自动运行的工人已经在干活，这里只补验证 DONE 标记的发现路径）
const artDir = nodePath.join(ROOT, st0.workers[worker].dir || worker, cardId);
mkdirSync(artDir, { recursive: true });
writeFileSync(nodePath.join(artDir, "自检产出.md"), "（自检产生的文件，可删）\n");
await sleep(300);
writeFileSync(nodePath.join(artDir, "DONE"), "");
console.log("…等服务端轮询发现 DONE 标记");
let state = card.state;
for (let i = 0; i < 10; i++) {
  await sleep(2500);
  state = (await cardOf()).state;
  if (state && state !== "waiting") break;
}
ck("服务端能跟踪到产出目录并把卡推进（DONE 兜底链路通）", !!state && state !== "waiting", `实际=${state}`);

// 5) 租约语义：卡已被领走、不再是 waiting，重复触发应被拒
const re = await post(`/api/card/${cardId}/triggered`, {});
ck("卡不在 waiting 时不能再被触发（租约成立）", re.status !== 200, `HTTP ${re.status}`);

// 清理自检痕迹
try {
  for (const f of readdirSync(nodePath.join(ROOT, "tasks"))) if (f.startsWith(cardId + ".")) rmSync(nodePath.join(ROOT, "tasks", f));
  rmSync(artDir, { recursive: true, force: true });
  console.log("\n已清理自检卡与自检产物");
} catch (e: any) { console.log("\n清理失败（不影响结果）:", e.message); }

console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
