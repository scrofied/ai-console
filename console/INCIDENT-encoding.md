# 事故记录：server.ts 被 PowerShell 写成双重编码

**状态：已解决**（2026-10-19 09:5x）。最终走的是「重建」而不是「修字」，
详见文末「最终怎么收的」。

时间：2026-10-19 09:0x
影响：`console/server.ts` 文本损坏，**无法再编译启动**；正在运行的服务（pid 79148）是损坏前加载的，
仍然正常，但**一旦重启就起不来**。

## 怎么发生的

我用 PowerShell 做了一次「读全文 → 正则替换 → 写回」：

```powershell
(Get-Content $p -Raw) -replace '...' | Set-Content -LiteralPath $p -Encoding UTF8 -NoNewline
```

`Get-Content -Raw` 在 PowerShell 5.1 里按系统 ANSI（cp936）解码 UTF-8 文件，
`Set-Content -Encoding UTF8` 又把解出来的乱码写成 UTF-8 —— 典型的**双重编码**。

而且这个 GBK 变体解码器会：
- 把解不了的字节对吞成 `?`（**连原文件里的引号、括号都可能被吞**）
- 把某些单字节映射到私用区（U+E000..U+F8FF）

所以不只是中文变乱码：**字符串的结束引号被吃掉**，代码语法也跟着坏了。

## 已经确认救不回来的原因

- 没有 git，没有可用备份（`server.ts.bak-before-merge` 是合并前的老版本，少几百 KB 的功能）
- `?` 到底吞了 1 个还是 2 个字节无从判断，反解会级联错位
- 尝试过：cp936 反向编码、私用区映射、带前向对齐的 UTF-8 约束求解 —— 都只能恢复到
  「大部分正确 + 2532 处空洞」的程度，空洞里含有被吞掉的引号，编译不过
- Bun 没有落盘的转译缓存

## 现场保留

| 文件 | 说明 |
|---|---|
| `server.ts` | 损坏版（原样，供比对） |
| `server.ts.corrupted` | 同上，副本 |
| `server.ts.recovered-holes` | 反解结果：非损坏部分 100% 准确，损失处标 `⟦?⟧` |
| `server.ts.bak-before-merge` | 合并前老版本（98KB） |

## 可选的两条路

1. **修复**：以 `server.ts.recovered-holes` 为基础，把 453 行里的 `⟦?⟧` 按上下文补回中文
   （补的时候把被吞的引号一起补上），每改一批就用 `bun build` 验一次语法。
   代码结构是完整的，只有字符串/注释受损 —— 工作量可控，但需要细心。
2. **回滚**：用 `server.ts.bak-before-merge` 启动，代价是丢掉这轮做的全部功能
   （参谋团、流程模板、附件、会话续接、模型策略、底图等）。

## 最终怎么收的：重建，不是修字

修字这条路走不通——`?` 到底吞了 1 个还是 2 个字节无从判断，反解会级联错位，
453 行里还有被吞掉的引号和对象键（`做什么` → `做什⟦?⟧`）。子 agent 试过一轮，
还把代码里的 `"` 写成了中文引号 `“”`，反而更难收拾。

改成**以 `server.ts.bak-before-merge`（98KB，干净、能编译）为基底，把我这几轮加的功能
逐块接回去**。关键发现：这份备份其实**没有损坏**——之前看到的乱码是 PowerShell
`Get-Content` 的显示问题，文件本身是正常 UTF-8。

接回去的东西：

| 功能 | 内容 |
|---|---|
| 额外执行体 | `runners-extra` 导入、`EXTRA_KINDS` / `isExtraRunner` / `hasOwnRunner` / `runnerStatus`、`runAgent` 分派 |
| 会话续接 | `config/sessions.json` 读写、`sessionKey/get/set/reset`、`sessionIdFromOutput`、三个执行体的 resume 参数、`/api/sessions` + `/api/sessions/reset` |
| 附件 | 上传/预览接口、`withAttachments`、`imagesInText`、创建与追问两条链路接受 `files` |
| 参谋团 | `/api/council` 读写 + 人格文件读写 + `COUNCIL` 改可重载 |
| 流程模板 | `/api/flows` 读写 + `/api/flows/run`、`flowStepToCard` / `validateFlow` |
| 指挥官干活 | `plannableWorkers` / `resolvePlanWorker` / `isCommanderCard`、`PLAN_SCHEMA` 加 `mode`、拆单提示词重写、卡片读写 `mode`/`执行方式`、`cardView` 加 `mode`/`selfRun` |
| 底图 | `/assets/*.png` 静态路由 |
| 环境变量 | `readUserEnv`（写文件再读，绕开沙箱管道限制）+ 启动时 `hydrateKeys()` |
| WorkBuddy | `runner.env` 合并（`CODEBUDDY_FORCE_LITE_WB_BUNDLE=1`） |

**顺带修掉的两个真问题**：

1. `canRun()` 不认识额外执行体，导致 Trae 被判成"跑不起来"（`/api/settings/test` 直接 400）。
2. WorkBuddy 的 Key 兜底用 `Bun.spawnSync` 抓 stdout，在受限沙箱下管道不可用，
   Key 永远读不到（表现为 `Authentication required`）。改成让 PowerShell 写临时文件再读。

## 验证结果

| 项 | 结果 |
|---|---|
| `bun build` 编译 | 通过 |
| 服务启动 | 通过（8787） |
| `/api/state` `/api/council` `/api/flows` `/api/sessions` `/assets/...` `/` | 全 200 |
| 13 个历史任务 | 全部还在 |
| 会话续接（先记 8123 → 再问） | Codex ✅ WorkBuddy ✅ Qoder ✅ Trae ✅ |

## 仍然缺的（重建版没有，需要时再补）

- `AUTO_PICK` / `creditsAreFree` / `modelSourceOf` / `warmModelCatalogs`：
  设置页里"自动按优先级挑免费模型"那套。**手动选模型仍然正常**，只是少了自动挑。
- 图片以 `-i` / `--attachment` 传给 CLI（附件仍会上传并把路径写进正文，执行体能按路径读）。

## 教训（写进 MERGE-NOTES 了）

**永远不要用 PowerShell 的 `Get-Content` / `Set-Content` 改这些源文件。**
要么用编辑工具，要么用 Python 显式 `encoding="utf-8"`。
这一条之前已经踩过一次（index.html），这是第二次，代价大得多。
