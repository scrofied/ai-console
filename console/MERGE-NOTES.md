# 多 AI 接入 · 合并说明

> 这次把跑通的接入合并进原有控制台。**没有动原有执行体**，只加了一个 runner 模块、
> 在 `server.ts` 里加了分发点、在 `config/workers.json` 里加了三个 worker。

## 现在能调度的 worker

| worker | 执行体 | 状态 | 说明 |
|---|---|---|---|
| `codex` | 原有 `runCodex` | ✅ | 指挥官默认 |
| `workbuddy` | 原有 `runCodebuddy`（codebuddy CLI） | ✅（本次修复） | 见下方“修复了既有故障” |
| `qoder` | 原有 `runCodebuddy`（qodercli） | ✅ | |
| `traework` | **新增** `runTrae` | ✅ | TRAE CLI `exec --json -o` |
| `qoder-intl` | **新增** `runAcpStdio` | ✅ | IDE 内置 ACP worker |
| `workbuddyai` | **新增** `runAcpHttp` | ✅（需 App 有对话） | 走桌面 App 的 ACP 网关 |

六个 worker 的真实连通性测试（设置页“测试”按钮走的同一条路径）：

```
codex        ok=True  38517ms  收到
workbuddy    ok=True  11271ms  收到
qoder        ok=True  13190ms  收到
traework     ok=True   5391ms  收到
qoder-intl   ok=True  13970ms  收到
workbuddyai  ok=True  21617ms  收到收到
```

`workbuddyai` 的回复出现重复（`收到收到`）是它复用 App 对话导致的回声，
不是本轮答案拼接错误——见下方限制说明。

## 三种新 runner 的原理

### 1. `trae` —— 一次性执行

```
<traex.exe> exec --json -y -C <workdir> --output-last-message <tmp> --add-dir <ROOT> [-m <model>] <prompt>
```

答案读 `-o` 落盘的文件。不能直接读 stdout：`traecli exec` 会先打印
`TRAE CLI v0.209.1` / workdir / model / provider 的 banner。

**不能用 ACP 吗？** 能用（`traecli acp serve`），但一次性 `exec` 更省事：
不用管进程生命周期，也不用处理 ACP 的 session 复用。

### 2. `acp-stdio` —— IDE 内置 worker

```
<node> "<...>/qoder-worker-runtime.obf.mjs" --permission-mode bypass_permissions [-m <model>] --acp
```

`--acp` 是 Qoder 代码里 `.hideHelp()` 藏起来的参数，`--help` 里看不到。
每轮一个短命进程，session 不跨进程。**不需要开 GUI。**

### 3. `acp-http` —— 桌面 App 的网关

WorkBuddy AI 的 CLI 用 CN 的 `CODEBUDDY_API_KEY` 会被 **401** 拒：

```
401 Authentication required (auth-type:cli-external-link, token-type:ApiKey, token-length:59)
(target: https://www.workbuddy.ai)
```

CN 的 key 只对 `www.workbuddy.cn` 有效。AI 版的登录态由桌面 App 在内存里注入给它
自己起的网关，所以只能走网关。

**端口是动态的**，而且两个 WorkBuddy 的 ACP 握手逐字节相同（落地页都是
`CodeBuddy Remote Control`、同样 2098 字节），**只有宿主进程名能区分**：

```json
"runner": { "kind": "acp-http", "processName": "WorkBuddyAI", "headers": { "x-codebuddy-request": "1" } }
```

一次性 PowerShell 查 `LocalPort → OwningProcess → ProcessName`，只保留宿主是
`WorkBuddyAI.exe` 的端口，再逐个做 ACP 握手确认。

## 修复了既有故障：workbuddy (CN) 原本就跑不起来

合并前 `workbuddy` 的测试结果是 `退出码 1`。原因不是配置写错，是 **CodeBuddy 系 App
更新后只发布 lite-wb 包**：

`D:\workbuddy\resources\app.asar.unpacked\cli\dist\` 里现在只有
`codebuddy-lite-wb.mjs`（9.5 MB）+ `lazy-lite-wb\`，没有 `codebuddy.js`，
所以 `bin/codebuddy` 的 `require('../dist/codebuddy')` 直接
`MODULE_NOT_FOUND`。

修法：给 runner 加了 `env` 支持，并补上分流开关：

```json
"env": { "CODEBUDDY_FORCE_LITE_WB_BUNDLE": "1" }
```

修完 `workbuddy` 从 `ok=False(732ms)` 变成 `ok=True(8417ms) 收到`。

## workbuddyai 的限制（已能跑，但有前提）

`session/new` 返回的**不是新会话，而是桌面 App 当前打开的那个对话**——探针里能看到
网关把整段历史（几百个工具调用）全量回放。

因此它有两种可预期的失败：

1. **拒答** `stopReason: "refusal"`：对话历史太长时它不再接新任务。runner 会判失败并
   给出可操作提示：
   > 网关拒答：它复用的是桌面 App 里当前那个对话，历史太长时不会再接新任务。
   > 去 WorkBuddy AI 里新开一个对话（或清理当前对话）后重试。
2. **回声**：回复里可能带上上一轮的文本（实测出现过 `收到收到`）。

**实测结论：切到 `default-model` 后本轮能通过**（21.6s，`ok=True`）。但仍受 App 对话状态
影响，不适合当无人值守的主力。**要彻底稳定，二选一：**
1. 拿一个 AI 站（`www.workbuddy.ai`）专属的 API Key，改用 `codebuddy` 执行体，
   像 CN 那样彻底脱离 GUI。这条路要你提供 key。
2. 每次派工前在 App 里开一个新对话。

## 多模态输入：粘贴 / 拖拽 / 选文件

对话输入框和新任务输入框现在都能直接塞文件，跟正常 AI 聊天一样。

### 三种进法

1. **粘贴** —— 截图后 `Ctrl+V`、复制一个文件再粘贴，都直接变成附件
2. **拖拽** —— 把文件拖进输入框区域，会出现蓝色虚线高亮，松手即加
3. **📎 按钮** —— 打开系统文件选择器，可多选

### 附件条

加进来的文件显示成一排小卡：图片显示**真实缩略图**，其他显示文件图标，右上角 `✕` 移除。
上限 **10 个**、单个 **25MB**，超了会明确提示并跳过。

### 发出去之后

1. 文件上传到 `intake/attachments/`，按对话分组（新任务先落 `tmp/`，建对话时自动挪进 `Jxx/`）
2. 消息正文后面自动追加一段清单：

```
【附件（1 个，都在本机磁盘上，需要时按路径读取）】
1. 测试截图.png｜图片｜39 KB
   路径：D:\agent\AI指挥台\intake\attachments\J13\测试截图.png
```

3. **图片还会真的传给模型**：口令里出现的图片路径会被提取出来，按各家支持的方式挂上去——

| 工具 | 图片参数 |
|---|---|
| Codex | `-i <path>` |
| Trae | `-i <path>` |
| Qoder | `--attachment <path>` |
| CodeBuddy 系 | 没有该参数，只留路径（靠 Read 读文件） |

所以图片不是"告诉它有个文件"，而是**模型真能看见图**（在支持的工具上）。

### 接口

| 接口 | 作用 |
|---|---|
| `POST /api/upload?job=Jxx` | multipart 上传，返回 `{files:[{name,path,kind,size}]}` |
| `GET /api/attachment?path=` | 预览/下载，**只放行 `intake/attachments/` 下的文件** |

`POST /api/jobs` 和 `POST /api/jobs/:id/say` 都接受 `files` 数组；正文会用它拼清单，
并把文件挪进对话目录（同名不覆盖，自动加序号）。

### 实测

- 上传 `测试截图.png`（40KB）→ 存到 `intake/attachments/tmp/`，`kind=image`
- 预览接口取回 40000 字节，PNG magic 正确
- 用该附件建对话 J13 → 文件被挪进 `intake/attachments/J13/`，正文含清单和绝对路径
- 界面里塞一张截图 + 一个 .txt → 附件条显示缩略图和文件图标、`✕` 可移除、📎 按钮就位
- 消息气泡里完整显示附件清单

## 流程模板：把跑通的人工分工固化下来

顶栏新增「≡ 流程」按钮。一套流程 = **固定步骤 + 每步固定执行者**，开工时直接按模板
建卡派单，**不经过指挥官拆单**——省一次模型调用，也避免每次拆得不一样。

### 界面

左边是流程列表（显示步骤链，如 `workbuddy → traework → workbuddy → qoder`），
右边是竖向流水线：每步一个带序号的彩色节点（颜色对应 AI）、AI 名字、依赖标签。
点一步展开编辑：这一步叫什么、由哪个 AI 干、要等谁先完成（勾选前面的步骤）、
做什么、参照物、不要什么、什么算完成。

### 内置两个模板

**短视频流水线**（按你描述的流程，对应各家的强项）

| 步 | 做什么 | 给谁 | 为什么是它 |
|---|---|---|---|
| 1 找对标 | 找 3-5 个同赛道爆款，记标题/钩子/结构/数据 | WorkBuddy | 它的强项是资料整理与调研 |
| 2 转逐字稿 | 选出最值得仿的一条，逐拍拆结构骨架 | Trae | 长上下文，适合啃长文案 |
| 3 仿写文案 | 按骨架换题材，出逐字稿 + 纯口播 | WorkBuddy | 它的强项是写文档和文案 |
| 4 生成视频 | 拆分镜 + 出可执行剪辑清单 | Qoder | 它的强项里有视频渲染 |

**资料→网页**：整理资料 → 出页面结构（Codex）→ 写单文件页面（Qoder）

### 开工

点「用这个流程开工」→ 填一句这次要做什么 → 「确认开工」。
这句话会**追加到每一步的「做什么」后面**（作为「本次的具体要求」），
所以同一套流程可以反复用于不同题材。

实测（J12）：

```
POST /api/flows/run {flowId: video-pipeline, text: "做一期讲…的短视频"}
→ T28 workbuddy  找对标     干活中   deps=[]              running=True
  T29 traework   转逐字稿   排队中   deps=[T28]
  T30 workbuddy  仿写文案   排队中   deps=[T29]
  T31 qoder      生成视频   排队中   deps=[T30]
```

步骤里的 `deps` 写的是 key（`benchmark`/`transcript`/`copy`），
派单时 `dispatchCards` 自动映射成真实卡号（`T28`…），所以模板不用关心卡号。

### 接口

| 接口 | 作用 |
|---|---|
| `GET /api/flows` | 流程列表 + 工具清单（带可用性） |
| `POST /api/flows` | 保存流程（校验 id/key 唯一、依赖必须指向真实步骤、不许依赖自己、≤12 步） |
| `POST /api/flows/run` | 按模板建对话 + 建卡 + 立刻派单 |

### 和你现在做法的差别（需要你确认）

你说「这些流程基本固定在对应 AI 的固定的对话里」。现在的实现是：
**每步仍然是一次独立的委派，交接靠文件**（上一步产物路径会注入到下一步的口令里），
而不是把几步塞进同一个聊天会话。

这样做的好处是每步都能单独重试、单独验收，坏处是**上下文不会在对话里累积**。

如果你要的是「第 3 步能看到第 1、2 步在同一个对话里的问答应答」，那需要给每步加
「沿用上次对话」开关，底层用各 CLI 的 session resume：

| 工具 | 续接方式 |
|---|---|
| Codex | `codex exec resume <session-id>` |
| Qoder | `--continue` / `--resume <id>` |
| Trae | `exec resume` |
| CodeBuddy | `--continue` / `--resume <id>` |

**这条我还没实现，也没验证过**（需要抓每轮返回的 session id 并持久化）。
要的话我下一步做，做完每个步骤卡片上会多一个「续用上次对话」的勾。

## 参谋团：可视化圆桌设置

顶栏新增「◎ 参谋团」按钮，打开是一张**圆桌**：每一席坐在桌边，中间是会议信息。

### 能改什么

| 项 | 说明 |
|---|---|
| **谁坐在桌上** | 加席 / 移除席（最多 8 席） |
| **这一席叫什么** | 席位名，最多 24 字 |
| **这一席用哪个 AI** | 下拉：`自动`（按负载挑最闲的）或指定某个工具；会标出「不可用 / 熔断中」 |
| **人格文件** | 下拉选已有 `console/council/*.md`，或新建 |
| **人格内容** | 右侧可直接编辑并「保存人格」，参会时这一段原样作为该席提示词 |
| **开不开会** | 中间开关「开局默认开参谋会」 |
| **会议预算** | 中间数字框，每天最多开几次（0–200） |

### 视觉：3D 会议室 + 真人感

圆桌用的是**独立深色皮肤 + 真 3D 透视**，只在 `#council` 弹窗内生效。

**3D 是怎么做出来的（不是画一张斜图）**

- 舞台开 `perspective: 1500px`（灭点在 `50% 30%`）
- 桌面是一个**正圆** `470×470`，放在 `rotateX(58deg)` 的平面上 —— 被透视压成椭圆，
  这才是真实的俯视效果，放大缩小、移动都成立
- 桌子下面垫一层 `translateZ(-18px)` 的更深圆盘，做出**桌面厚度**
- 席位站在桌边，按角度算景深：越靠后的席位**越小越暗**（`scale 0.86→1.06`，
  `opacity 0.80→1.0`），靠前的更大更亮
- 层级：桌子(z:1) → 铜牌(z:2) → 席位(z:3) → 选中/悬停(z:5)

**真人照片：四位参谋已经放上真脸**

| 席位 | 人物 | 图片来源 |
|---|---|---|
| munger | 查理·芒格 | 维基百科页面主图（Wikimedia Commons，自由许可） |
| musk | 埃隆·马斯克 | 同上 |
| bezos | 杰夫·贝索斯 | 同上 |
| jobs | 史蒂夫·乔布斯 | 同上 |

取图流程（可复用，`config` 里换人只要改名字）：
1. `GET https://en.wikipedia.org/api/rest_v1/page/summary/<人物英文名>` 拿到 `originalimage.source`
2. 下载原图（带 `User-Agent`，Wikimedia 要求）
3. 处理成大头贴：按**上中区域**取正方形（偏上取脸、留一点肩）→ 缩放到 420×420 →
   椭圆暗角压边（和其他头像的影棚感统一）→ 存 `intake/avatars/<席位id>.jpg`
4. `POST /api/council` 把 `avatar` 指到该文件

**授权说明**：这几张来自维基百科/维基共享，属于自由许可，**仅用于本机个人工具**没问题；
如果要对外分发或商用，请自行核对每张图的许可与署名要求，或换成你自己的照片
（每席点「上传照片」即可替换）。

**程序化头像仍然保留**：没上传照片的席位会自动用 `console/portrait.js` 生成一张稳定的
插画人像（按席位 id），所以新加席位不会开天窗。

**能力边界**：插画级人像 ≠ 照片级写实。真实照片靠上面这套取图/上传；
要"凭空生成照片级的人"，得本机跑扩散模型。

**踩过的坑（都修了）**

1. 用 PowerShell 的 `Set-Content -Encoding UTF8` 去改 `index.html`，把中文写成了**双重
   编码**（`参谋团` → `鍙傝皨鍥`），且产生私用区字符导致反向解码不可逆 —— 最后按原结构
   重写了 `index.html`（4983 字节，40 个 id，中文校验通过）。
   **教训：改这些文件只用编辑工具或 Python（显式 utf-8），不要用 PowerShell 5.1 的
   `Set-Content`。**
2. `.rt-orbit` 的 `position/left/top/transform` 原本只写在旧皮肤文件里，整份覆盖后它退化成
   普通流方块 —— 覆盖皮肤文件时定位基类必须自己写全。
3. `.rt-table` 用负 margin 居中不可靠（会被 ui.css 的旧规则影响，实测表盘左边缘正好落在
   中心、右半被裁掉）。改成 `transform: translate(-50%,-50%) translateZ(0)`。
4. 别用 `conic-gradient + mix-blend-mode:screen` 做流光：截图上会出现可见的硬边方块。
5. 席位一开始用「从平面立起来」（`translate(-50%,-100%) rotateX(-56deg)`），结果最上面那席
   被推出舞台裁掉、又被铜牌压住。改成 2.5D（表盘真 3D + 席位按景深缩放），稳定得多。

**验证方法**：`elementFromPoint` 定位可疑元素，对不上就**逐像素采样** + 放大三倍看，
最后确认过一道"接缝"其实是席位卡的玻璃渐变在压缩预览里的错觉。
几何也可以直接量：`stage_c=523 table_c=523 hub_c=523`（三者同心）。

### 按钮与控件规范（buttons.css）

之前按钮没有统一标准：顶栏三个按钮被挤成"流/程"竖排、开始按钮巨大、📎 和旁边不等高、
每个弹窗各自改 padding、同行的 select 比 button 高 4px。现在收敛成一套：

**四个高度档**（`--btn-h-*`）：`xs 26` / `sm 32` / `md 38` / `lg 46`
字号配套 `12.5 / 13.5 / 15 / 16`，圆角 `8 / 8 / 10 / 12`，内边距 `10 / 13 / 17 / 24`。

**三条硬规矩**：

1. `white-space: nowrap` —— 任何容器都不许把按钮文字压成竖排（这就是顶栏"流/程"的根因）
2. `flex: 0 0 auto` —— flex 容器不许把按钮压扁
3. 表单控件（select / input）跟按钮同高 —— 同一行不允许高低不齐

**语义色**：`primary`（蓝渐变）/ `ghost`（无边框）/ `subtle`（灰底）/ `danger`（红字），
`icon` 变体是正方形。

**各处统一后的结果**：

| 位置 | 之前 | 现在 |
|---|---|---|
| 顶栏 流程/参谋团/设置 | 44×68 竖排 | 72~86×34 横排 |
| 开始 | 106×88 | 82×46 |
| 📎（新任务行） | 34×34，和开始不齐 | 46×46，与开始同高同基线 |
| 弹窗底部按钮 | 各自 padding | 全部 32 高 |
| 设置页 select vs 按钮 | 36 vs 32 | 都是 32 |

**暗面板规则**：圆桌弹窗是深色，里面所有 `.btn` 统一切成"玻璃 + 金边"（`#council .btn`），
避免白底按钮突兀；主按钮改金色渐变。

加载顺序：`ui.css → council.css → flows.css → attach.css → buttons.css`（最后加载才能覆盖前面）。

## 会话续接：同类任务固定同一条对话

原来每次调用 CLI 都是**全新会话**，上下文等于 0，同一类任务每次都要从头交代一遍。
现在按「工具 + 作用域」维护固定 session id，之后每次都 resume 它。

### 四个 CLI 的续接方式（实测）

| CLI | 新建时指定 id | 续接 | 备注 |
|---|---|---|---|
| Qoder | `--session-id <uuid>` | `--resume <id>` | 之前带的 `--no-session-persistence` 会丢会话，已去掉 |
| WorkBuddy (codebuddy) | `--session-id <uuid>` | `--resume <id>` | |
| Codex | ✗ 没有这个参数 | `exec resume <id>` | 只能从 `--json` 流里抓 `thread_id` |
| Trae | ✗ `--session-id` 只是命名，不是真 id | `exec resume <id>` | 从 `thread.started` 事件抓 `thread_id` |

### 两个必须记的坑

1. **`exec resume` 接受的参数更少**：Codex 的 resume 不认 `-s` / `-C` / `--add-dir`；
   Trae 的 resume 不认 `-C` / `--add-dir`，但**必须**带 `-y --skip-git-repo-check`，
   否则报 `Not inside a trusted directory`。工作目录一律靠子进程的 `cwd` 传。
2. **Trae 的 `--session-id` 是假的**：传了也不会用它当线程 id，`resume` 会报
   `no rollout found for thread id`。只能从 `thread.started` 事件里抓真 id。
   为此外层 `runChild` 多返回一个 `raw`（完整 JSON 流），否则抓不到。

### 作用域怎么分（"同类任务"怎么界定）

key = `${worker}::${scope}`，存在 `config/sessions.json`：

| scope | 谁在用 |
|---|---|
| `default` | 普通任务卡（没有流程归属的） |
| `flow:<流程id>/<步骤key>` | 流程模板的某一步 —— **"找对标"这一步永远是同一条对话，跨任务累积** |
| `council:<席位id>` | 每个参谋席位各一条 |
| `review` | 验收方单独一条，不污染它干活的上下文 |
| `plan` | 指挥官拆单 |
| `test` | 设置页的连通性测试 |

### 实测结果（口令：先记 4711，再问是多少）

| 工具 | 第一次 | 第二次 | 结论 |
|---|---|---|---|
| Qoder | 好的 | **4711** | ✅ |
| WorkBuddy | 好的 | **4711** | ✅ |
| Codex | 好的 | **4711** | ✅ |
| Trae | 好的 | **4711** | ✅ |

### 接口与重置

| 接口 | 作用 |
|---|---|
| `GET /api/sessions` | 列出所有会话（工具 / 作用域 / id 前 8 位 / 轮数 / 更新时间） |
| `POST /api/sessions/reset` | `{worker, scope?}`，不传 scope 就清掉这个工具的所有会话 |
| `POST /api/settings/test` | 现在支持 `{prompt, scope, timeoutMin}`，可用来验证"是不是真接上了上一次" |

**为什么必须有重置**：会话是累积的，跑歪了会一直歪下去；上下文变长也会变慢变贵。
重置就是"开新的一局"。

## 底图：AI 生成 + 在图上二次开发

**关键发现：子 agent 里有两个会生图。**

| 子 agent | 生图能力 | 说明 |
|---|---|---|
| **WorkBuddy** | ✅ 有内置 `ImageGen` | 直接出图，右下角带 "AI生成 WORKBUDDY" 水印 |
| **Qoder** | ✅ 能出图 | 出图质量更稳，可指定相机角度 |
| Trae | ❌ 没有 | 只有 Read/Write/WebFetch/WebSearch 一类工具 |
| 外部 API | ❌ 都不可用 | pollinations 要付费；你的网关 `gpt-image-1` 被 `403 该组未开启`；HuggingFace 被 TLS 阻断 |

所以"AI 生图"这条路，走的是**让 Qoder 生图**，不是调外部接口。

**生成的两张候选**（都在 `console/assets/`）：

| 文件 | 来源 | 尺寸 | 桌面椭圆 ry/rx | 结论 |
|---|---|---|---|---|
| `table-sci-fi.png` | Qoder（高俯角） | 1792×1024 | 0.432 | **采用** —— 俯角够高，人围一圈不挤 |
| `table-sci-alt.png` | WorkBuddy | 1536×960 | 偏扁 | 备选 —— 更"全息玻璃"，但相机太低压，人摆上去会挤成一条线 |

**二次开发的做法**：

1. 用像素扫描量出底图里桌面发光环的椭圆：中心 `(49.2%, 57.2%)`、`rx=38.1%`、`ry=28.8%`
2. 人物按这个椭圆排布（半径 ×1.03），正好站在图里那圈**白色席卡外侧**
3. 舞台改成图片模式：`aspect-ratio:1792/1024` + `background:center/cover`，
   并把原来 CSS 画的桌子（`.rt-scene`）隐藏
4. 叠一层径向暗角压暗四周，保证名牌和 HUD 可读
5. 桌沿再叠一圈青色辉光（`.rt-rim`），选中席位时脉冲
6. 前后分层仍然生效：`z=3` 的人被桌子挡住，`z=9` 的人压在桌前

底图是运行时探测的：`new Image()` 能加载 `/assets/table-sci-fi.png` 才切图片模式，
没有这张图就自动退回 CSS 画的桌子——**换图只要替换一个文件**（换完要重新量椭圆，
改 `SCENE_SHAPE` 和 `.rt-rim` 的百分比）。

**水印处理**：Qoder 的图右下角有 "Qoder AI 生成"，用邻近地面的模糊块盖掉再叠一层淡暗角；
WorkBuddy 的水印在 `table-sci-alt.png` 里没处理（备选图，暂时用不到）。

### 视觉：照着真实会议的做法重做（v3）

参考过的三处：

| 来源 | 借鉴的做法 |
|---|---|
| [CSS-Tricks · 圆形头像列表](https://css-tricks.com/responsive-list-of-avatars-using-modern-css-part-2/) | 环形排布用 `rotate(-θ) translate(r) rotate(θ)`；半径取 `(尺寸+间距)/(2·sin(π/N))`，保证任意席位数**都不重叠** |
| [Zoom 视图模式](https://dmu.freshservice.com/support/solutions/articles/14000050197-View-options-within-a-meeting) | 发言者放大 + 外环高亮，也就是"谁在说话"的空间强调 |
| [Clubhouse / 空间头像专利](https://patentimages.storage.googleapis.com/59/df/30/456e4ede7ded0d/US20230082021A1.pdf) | 头像用圆形，按角色分主次；发言时有环 |

**最关键的一处改动是空间关系，不是画质。**

v2 的问题是人和桌子没有关系——人都"浮"在桌子上方。v3 改成：

- **z-index 分层**：桌子 `z=5`；远侧的人 `z=3`（被桌子挡住一部分），近侧的人 `z=9`（压在桌子前面）。
  这才有"坐在桌边"的遮挡关系
- **空气透视**：越远的人 `scale` 越小（0.82→1.06）、`brightness` 越低（0.72→1.0）
- **桌面名牌**：每个人面前一块铜色名牌，像会议桌上的席卡
- **落地阴影**：名牌下方一片椭圆阴影，人"落"在桌边而不是飘着
- **主持人标记**：指挥官那席多一个金色「主持」角标
- **发言呼吸环**：选中的席位外圈有一圈金色脉冲（`@keyframes rtSpeak`）
- **会议信息移到左上角 HUD**：真实圆桌中间是空的，而且原来居中的牌子会压住桌边的人

**中途踩的坑**：桌子厚度原本用 `translateZ(-18px)` 叠一层深色圆盘，透视下缩成一块**黑洞**
落在桌面正中。改成只留边缘的 `box-shadow` 厚度，桌面提亮。

### 交互

- 点一个人 → 右侧切到他的编辑器；金色描边 + 呼吸环标出当前选中
- 改名字时只重绘名牌上的文字，不重建编辑器（否则输入框会失焦）
- `加一席` / `移除` / `改 AI` / `换头像` 都只改**本地草稿**，必须点「保存参谋团」才落盘
- 保存后服务端**立即重载** `config/council.json`，下一场会就按新席位开，不用重启

### 实现

| 接口 | 作用 |
|---|---|
| `GET /api/council` | 席位 + 可用工具 + 已有的人格文件 + 今日已用次数 |
| `POST /api/council` | 保存 `councilDefault` / `councilBudgetPerDay` / `seats`，并重载内存配置 |
| `GET /api/council/skill?file=` | 读一席的人格文件 |
| `POST /api/council/skill` | 写人格文件（新建或覆盖，上限 60000 字符） |

**安全约束**（都在服务端校验，不是只靠前端）：
- 席位 `id` 只允许 `[a-z0-9_-]{1,24}`，且不许重复 —— 它同时是配置键和人格文件名
- 人格文件路径必须匹配 `console/council/*.md`，挡掉 `../` 穿越
- 席位指派的工具必须真的存在
- 席位上限 8 个，预算上限 200

**文件**：
`console/council.js`（圆桌逻辑）、`console/council.css`（圆桌样式）、
`index.html` 加了按钮和弹窗容器、`server.ts` 加了四组接口并把 `COUNCIL`
从启动时读一次的 `const` 改成可重载的 `let`。

### 实测

- 4 席正常渲染，环形分布，中心显示「4 席 · 今日已用 0 次」
- 加一席 → 变 5 席、自动重排、新席自动选中、人格文件标「（新建）」，**服务端仍是 4 席**（草稿未保存）
- 保存往返：改名 `贝索斯参谋 → 贝索斯参谋（改）`、`tool: auto → qoder`、禁用乔布斯席，
  重新 `GET` 全部生效；随后完整还原
- 人格文件读写：564 → 589 → 还原 564 字符，标记校验通过

## 指挥官也干活：自己派给自己 / 并行 / 串行

拆单不再只是"把活分出去"。指挥官（Codex）现在会判断这件事该怎么干，并在方案里
用 `mode` 说明判断结果，`worker` 可以直接填 `self` 表示自己干。

### 四种情况（都已实测）

| 情况 | 方案表现 | 实测 |
|---|---|---|
| 一个人就能交付 | 1 张卡，`worker=self`，`mode=self` | ✅ J07/T23：Codex 自己写了 `hello.txt`（`Hello AI`），**由 workbuddy 验收通过** |
| 几件事互不依赖 | 多张卡，`deps=[]`，`mode=parallel` | ✅ J11/T25+T26：qoder 写 `page.html`、workbuddy 写 `doc.md`，**同时开工** |
| 必须按顺序接力 | 后一张 `deps=[前一张]`，`mode=serial` | ✅ J11/T27：Codex 等前两张都 pass 后才动手 |
| 混合 | self 卡与别的 AI 卡混排，靠 deps 定先后 | ✅ J11 全链路：并行两张 + 指挥官收口 |

J11 的实际方案（Codex 自己写的 summary）：

> 先让 qoder 和 workbuddy 各领一张无依赖的卡，并行制作页面和说明。
> 两张卡都完成并通过验收后，再由我汇总两个文件的路径，写入 final.txt。

```
page   → qoder     mode=parallel  deps=[]         页卡
doc    → workbuddy mode=parallel  deps=[]         说明
final  → codex     mode=serial    deps=[page,doc] 指挥官自己收口
```

产物：`qoder\T25\page.html` + `workbuddy\T26\doc.md` + `codex\T27\final.txt`
（final.txt 内容是两个文件的绝对路径）。

### 关键实现点

1. **拆单名单纳入指挥官**：`plannableWorkers()` = 指挥官 + 全体 worker，指挥官排第一。
   原来的 `workerNames()` 只取 `role==="worker"`，所以指挥官永远不可能被派活。
2. **`self` 归一**：`resolvePlanWorker()` 把 `self / 自己 / commander / 指挥官` 都解析成
   当前指挥官名，认不出来才退回第一个可选执行者。拆单落地和 `dispatchRound` 两处都过一遍。
3. **不自己验自己**：`pickReviewer()` 本来就排除产出方，指挥官干的卡会自动派给别的 AI
   验收（实测 T23 由 workbuddy 验收）。
4. **执行方式落盘**：任务卡里写 `执行方式:` 和 `模式:` 两行，`parseCard` 读回 `mode`，
   `/api/state` 的卡片多出 `mode` 和 `selfRun` 两个字段，界面可以标"指挥官自己干"。
5. **结构化输出约束**：这家网关（以及 OpenAI 结构化输出）要求 `additionalProperties:false`
   时**每个属性都必须出现在 `required` 里**，所以 `mode` 也必须列进 `required`，否则报
   `Invalid schema ... 'required' is required to be supplied`。

### 踩过的两个坑（已修，记一下）

- 不要往 `负责人:` 那一行追加任何括号标注（比如"（指挥官自己干）"）。`parseCard` 会把整行
  当 worker 读走，结果是 `codex（指挥官自己干）` 查不到 `WORKERS`，验收方也会因此选错人。
  标注放在独立的 `执行方式:` 行里。
- 用 PowerShell 手工调 `/api/jobs` 时，PS 5.1 的 `Invoke-RestMethod -Body <string>` 默认按
  ANSI 编码，中文会变成 `?`（存进 job 就是乱码，模型拆不动）。要用
  `-Body ([Text.Encoding]::UTF8.GetBytes($json)) -ContentType 'application/json; charset=utf-8'`。
  浏览器 UI 不受影响。

## 模型选择：手动 / 自动优先级 / 优先免费

六个 worker **都支持选模型**，用设置页（右上角"设置"）的下拉框即可，不需要改代码。

### 三层取值，前者胜过后者

1. **手动选**（设置页下拉框，存进 `config/settings.json` 的 `models`）
2. **自动优先级**（`workers.json` 的 `modelPolicy`，启动时预热模型清单后生效）
3. **配置默认**（`model` / `runner.model`），都没有就用工具自己的默认

启动后可以在 `console/server.out.log` 看到一行 `自动优先级模型：...`，`/api/state` 的
`workers.*.model` 就是当前真正会用的模型。

### 自动优先级的规则

```
显式 priority 列表第一位（且清单里有）
  → recommendedModel
  → 第一个免费模型
  → 标准清单第一个
```

`preferFree: true` 会把**免费模型整体排到前面**（在 priority/recommended 之后）。
`custom-local:*`（你自己接的通道）统一压到最后，避免自动挑选落到它身上。

### 各家的模型清单来源

| worker | 枚举方式 | 能看出免费吗 |
|---|---|---|
| `workbuddy` | App 缓存的产品配置（带倍率） | ✅ 空倍率=免费 |
| `workbuddyai` | 网关 `session/new` 的 `availableModels._meta.credits` | ✅ 空倍率=免费 |
| `qoder` / `qoder-intl` | `<worker> --list-models` | ❌ 只给名字 |
| `traework` | `traex.exe models`（独立子命令） | ❌ 只给名字 |
| `codex` | `codex debug models` | ❌ 只给名字 |

倍率判定：`""`（未标）、`0`、`free`、`免费` 算免费；`x0.34`、`x1.2` 算收费。

### 当前实测出来的清单规模

```
workbuddy     43 个模型
workbuddyai   38 个模型，其中 12 个免费
qoder-intl    18 个模型
traework      23 个模型
```

### 现在各 worker 生效的模型

| worker | 模型 | 来源 |
|---|---|---|
| codex | gpt-6.1-sol | 配置/手动 |
| workbuddy | deepseek-v4.1-flash | 手动（你原来设的） |
| qoder | Qwen3.8-Flash | 手动（你原来设的） |
| workbuddyai | default-model | **自动**（免费） |
| qoder-intl | Qwen3.8-Flash | **自动** |
| traework | DeepSeek-V4-Flash | **自动** |

### 换模型

- **手动**：设置页 → 选工具 → 下拉选模型 → 保存。下拉里 `★` 是自动优先级推荐的，
  也可以点"用推荐"；读不到清单时会变成手填输入框。
- **改优先级**：编辑 `config/workers.json` 里对应 worker 的
  `modelPolicy.priority`，重启服务生效。

```json
"modelPolicy": {
  "preferFree": true,
  "priority": ["DeepSeek-V4-Flash", "GLM-5.3-Flash", "Qwen3.8-Flash"]
}
```

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `console/runners-extra.ts` | **新增**：三个 runner + 网关发现 + 网关模型清单 `listGatewayModels` |
| `console/server.ts` | 加 import；`EXTRA_KINDS`/`isExtraRunner`/`hasOwnRunner`；`runAgent` 分发；`blockedSecFor`/`blockedCooldownClear`/`canRun`/`probe`/`PROC_HINTS` 支持新种类；`runCodebuddy` 支持 `runner.env`；`fetchModels` 支持三种新 kind + 免费判定 + 自动优先级；`AUTO_PICK` + `warmModelCatalogs()`；`/api/models` 返回 `free`/`policy`/`modelSource` |
| `config/workers.json` | 加 `workbuddyai`/`qoder-intl`/`traework`（含 `modelPolicy`）；`workbuddy` 补 `env` |

备份在同目录：`server.ts.bak-before-merge`、`workers.json.bak-before-merge`。

## 回滚

```bash
cd /d/agent/AI指挥台
cp console/server.ts.bak-before-merge console/server.ts
cp config/workers.json.bak-before-merge config/workers.json
bash console/start.sh --restart
```

## 重启方式

```bash
cd /d/agent/AI指挥台 && bash console/start.sh --restart
```

或者直接：`bun run console/server.ts`（在根目录下）。

**注意**：服务的 stdin 必须是空的（`start.sh` 里 `< /dev/null` 就是干这个的）。
若继承启动终端的 stdin，终端一退，codex 读 stdio 会秒退 66。
