# Stage A 端到端实测记录 · 2026-10-05

一句话目标 → Codex 总指挥拆单 → 派单（L2 降级 / L1 自动开工）→ 真产出落盘 → 自动交叉验收 → pass。
本目录是那次真实运行的原始证据，不是演示数据。

## 时间线

| 时刻 | 发生了什么 |
|---|---|
| 13:13 | `POST /api/plan/P75841295/dispatch`：三张卡落 `tasks/`，T01/T02 进"等人工触发"，T03 进"待办"等依赖 |
| 13:13 | 人工把 T01/T02 判为 pass（测试钩子，见下面"这次哪里不纯净"） |
| 13:15 | 服务端 `pumpWaitingAuto` 发现 T03 依赖已满足 → 原子改名 `.todo.md → .claimed.codex.md` → `codex exec` 真起跑 |
| 13:16 | Codex 在 `codex\T03\` 写出 `验收结果.md`(1538B)、`note.md`(733B)、`DONE` → 工作台检测到 → `claimed → done` |
| 13:18–13:21 | 第一次自动验收失败：`-s read-only` / `workspace-write` 下这台机器的 Codex alpha 起不了 shell，验收方读不到文件，只能回 `VERDICT: human` |
| 13:25 | 验收方改用与执行同一档沙箱后重跑：真读了 `codex\T03\验收结果.md`，逐条给结论，`VERDICT: pass` → 卡进"通过" |

## 拆单结果（Codex 自己拆的，没人写模板）

`plan.json` 里是三张卡，字段齐全，依赖用的是 key 名（`topics → scripts → review`），派单时由服务端换成真实卡号：

- **T01 topics → traework（L2）**：先查 `assets\` 有无可复用选题资产，再出 3 个有区分度的方向 + 每个一条"值不值得做"的判断标准
- **T02 scripts → doubao（L2）**：依赖 T01，写三条 15 秒口播稿
- **T03 review → codex（L1）**：依赖 T02，逐条核对交付完整性

值得注意：它在拆单时主动执行了协议里"开工前先查 assets 复用"这条规则，还因为自己当时读不到目录，在 summary 里写明"未能直接检查，要求首卡负责人开工时先查并记录实际路径"。

## L1 的真实产出

`T03.验收结果.md` 是 Codex 写的。它去查了 `doubao\02\`，发现是空目录（因为 T02 是我人工判过的，确实没有产出），于是如实报"实际交付 0 条，三条全部未通过"，并且没有编造内容。`T03.note.md` 里它另外记了不确定点："若交付存放于其他位置或 topics 有其他名称，当前无法判断实际内容。"

`T03.review.md` 是另一条独立会话对这份产出的验收结论（`VERDICT: pass`，带 `文件:行号` 证据）。

## 这次哪里不纯净（如实说明）

1. **T01、T02 没有真的由 TraeWork / 豆包 干活**，是我用卡详情里的"人工改状态"直接判成 pass 的，目的是把依赖门控和 L1 链路先跑通。这两家的 L2 真机验证属于 Stage B，需要你在工作台里复制口令粘一次。
2. **验收方和产出方是同一家（codex）**。本机只有 codex 能无人值守执行，`pickReviewer` 找不到"另一家 L1"时降级成"同源独立会话"：新 thread、cwd 相同、看不到产出过程，结论文件里已如实标注"非跨家，可人工推翻"。等 Stage C 把第二家升成 L1，这里会自动回到真交叉。
3. **T03 这张卡本身是"验收卡"**，所以它交付的东西就是一份验收报告。链路是真的，但活的内容比较特殊。

## 为跑通这次改掉的四个真 bug

- 拆单 schema 被网关拒：严格模式要求 `required` 列出 `properties` 的每一个键（缺 `avoid` 就直接 `Invalid schema for response_format`）
- 依赖永远不满足：卡里存的是 key 名 `scripts`，`depsPass` 拿它去找 `scripts.todo.md` 找不到，卡死在队列里；现在派单时先把 key 换成真实卡号，换不上就发 `dep_dropped` 事件而不是永远等
- 依赖变 pass 后没人再拉队列：`pumpAuto` 只在入队时调用过一次，现在进心跳
- 沙箱档位：这台机器的 Codex alpha 在 Windows 下 `workspace-write` 等于只读、`read-only` 连 shell 都起不来，只有 `danger-full-access` 能真读写（用户明确批准，暂不加越界写入看门狗）。同时执行与验收的 cwd 必须是总线根目录，否则它读不到 `AGENTS.md` / `shared\` / `assets\`
