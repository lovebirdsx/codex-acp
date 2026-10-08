# cases-session.md — 会话/模型/额度改动的完整叙事

对应 `CLAUDE.md`「fork 已有的本地改动」中带「详见本文档」的会话类条目，保留完整 bug 叙事与设计约束，供 rebase 冲突时参考。

## 网关模型注入会话模型清单

（**新增** `src/ExtraModels.ts`；接线在 `src/CodexAcpServer.ts` 私有 `withExtraModels`）

`availableModels` 来自 app-server `model/list` 的内置 OpenAI 目录，网关模型永远列不出；`createModelConfigOption` 只把**当前**未编目模型 unshift 进选项作兜底，一旦切走就再也切不回、同网关的其它模型更是完全不可见。修复：客户端经顶层 `_meta.extraModels` 注入候选（与 claude fork **刻意同名同层级**，编辑器一份载荷喂两个 fork），两个注入点（`tryCreateSession` 覆盖 new+resume、`getOrCreateSessionWithHistory` 覆盖 load——每次重开都从零重建 picker，漏一处模型就会消失）经 `withExtraModels` 收敛为同一追加逻辑（坏载荷降级空数组、去重、上限 64）；synthesized 条目 `supportedReasoningEfforts: []`（网关模型的 effort 能力未知，乱给会提供端点拒绝的选项）+ `defaultReasoningEffort` 拷贝会话当前 effort（**不写死 `"medium"`**，网关可能不收——它正是选中后 `ModelId` 的 effort 半段）。配套测试 `src/__tests__/CodexACPAgent/session-config-options.test.ts` 的 `describe("client-injected extra models (_meta.extraModels)")`。

## 模型是否在自己目录里的权威上报

（`src/CodexAcpServer.ts` `SessionState.modelKnownInCatalog` + 私有 `isModelInCatalogue` / `createSessionModelMeta`，三个会话响应 `newSession`/`loadSession`/`resumeSession` 展开 `_meta.codex.modelKnownInCatalog`）

编辑器对「上下文窗口未知」的 codex 模型会弹一次粘性警告引导填 `aiSettings.json` 的 `maxInputTokens`，但编辑器自己的知识库常落后 OpenAI 发版，把知识库缺项当成「codex 也不知道」会**误伤官方内置模型**（实测 `gpt-5.6-sol` 明明在 `model/list` 里、`thread/tokenUsage/updated` 会带回真值，却被要求手填）。客户端无法自行判定：`configOptions` 里目录条目与注入条目形状完全相同，上报的窗口也与 272K 回落无法区分。故 fork 上报这一位——**必须用 `withExtraModels` 之前的原始 `catalogueModels`**（合并后二者不可辨，这正是客户端答不出的原因），复用 `findCurrentModel` 剥 effort 后段；两个会话构造点（`tryCreateSession` 覆盖 new+resume、`getOrCreateSessionWithHistory` 覆盖 load）都要赋值，漏一处该路径就退化成误报。编辑器侧 `readCodexModelKnownInCatalog` 把字段缺失（旧 dist）视为「未知」而非 `false`，保证向后兼容。配套测试同上 describe 块两例（目录内→`true`、仅注入→`false`）。

## session 费用计算相关改动

（`src/CodexAcpServer.ts`、`src/CodexEventHandler.ts`）

上报 per-model USD 用量到 `_meta`，供父项目算人民币开销。子 Agent thread（collab/Task spawn 的独立 thread）的 `thread/tokenUsage/updated` 上游会发但默认无人订阅（`notify()` 按 threadId 精确路由）；子线程发现统一走上游 `CodexSubagentSubscriptions`（`CodexAppServerClient.onServerNotification` 是 Map.set，旧 fork 自建的 `subscribeToSubagentThreadEvents` 会覆盖上游 handler、破坏原生子会话路由，故删除）。原生子会话 client 走 dispatch 进主 handler；无原生子会话（编辑器不 advertise subagents 能力）时 fork 在该 discover 回调里对 `thread/tokenUsage/updated` 额外 dispatch 一次。主 handler 按 `params.threadId !== sessionState.sessionId` 分流到 `handleSubagentTokenUsage`（绝不污染主线程 turn/token 状态），快照记入 `SessionState.subagentTokenUsage` 并聚合进 `usage_update`/`buildQuotaMeta` 的 `_meta.quota`（`used`/`size` 保持主线程上下文口径）；同时给对应 subAgentActivity 卡片补发 `_universe/subagentStats`（无 model，父项目只显 tokens 不定价）。配套测试 `subagent-token-usage.test.ts`。

## mid-turn 普通 `session/prompt` 转 steering

（`src/CodexAcpServer.ts` `prompt()` 早退分支 + 新增 `promptViaSteering`）

turn 运行中 client 再发一条普通 prompt（universe-editor 编辑器的 mid-turn steering 方式）时，原正常路径会清掉 `currentTurnId` 并发第二个 `turn/start`——app-server 把输入并入运行中的 turn，新 turn id 永远等不到 `turn/completed`，`awaitTurnCompleted`（裸 promise 无超时）永不 resolve，client 会话永远卡在 running。修复：检测到 `activePrompts` 里有运行中 prompt 时改走 `executeOrQueueSteeringRequest`（SteeringQueue 串行 → `turn/steer` 注入或兜底开新 turn），再 await 对应 activePrompt 的 `completion` 后回 `{stopReason:"end_turn"}`（对齐 claude fork mid-turn prompt 的 settle 语义）；`failed` 抛 RequestError，校验类 RequestError（如纯文本模型收图片）原样上传。递归安全：`startNewTurnFromSteering` 调 `this.prompt()` 前已 await 前一 prompt 的 completion。配套测试 `steer-events.test.ts`「session/prompt during an active turn」三个用例。

## 官方订阅额度用量

（`src/CodexAppServerClient.ts` / `src/AcpExtensions.ts` / `src/CodexAcpServer.ts`）

编辑器输入框的用量指示器要在 ChatGPT 登录下显示额度窗口百分比，而不是内部网关的人民币月度开销。新增两个 client→agent ext-method——`universe-editor/subscription_usage`（读 `account/rateLimits/read`，原样透传 `rateLimits`/`rateLimitsByLimitId`，归一化交给编辑器侧，避免两个 fork 各写一份漂移）与 `universe-editor/consume_reset_credit`（`account/rateLimitResetCredit/consume`，省略 `creditId` 由后端挑下一张；`idempotencyKey` 必填且非空——空 key 会让后端每次重试都多扣一张额度）。**关键坑**：`RateLimitResetCreditsSummary.availableCount` 是 ts-rs 对 Rust u64 的产物即 `bigint`，`JSON.stringify` 遇 bigint 直接抛 `TypeError` 会带崩整条 JSON-RPC 响应——handler 返回前必须 `String(...)`，编辑器侧 `Number()` 还原。两个 case 都套 `runWithProcessCheck`；读取失败降级为 `supported:false` 而非报错（编辑器据此隐藏指示器）。**auth-mode 门控（务必保留）**：`readSubscriptionUsage` 先 `getAuthenticationStatus()`，只有 `type === "chat-gpt"` 才发 `account/rateLimits/read`，其余（`gateway`/`api-key`/`unauthenticated`）直接返回 `supported:false` 且不发该 RPC——`account/rateLimits/read` 按 `auth.json` 的账号作答，**与本轮实际计费到哪个 `model_provider` 无关**，用户配了自定义网关但残留过 `codex login` 时会把 ChatGPT 套餐窗口误报成网关会话的额度百分比（编辑器 `resolveUsageDisplay` 让 subscription 无条件压过 account，误报一次网关账号数字就永远没机会显示）；claude fork 早有等价位 `rateLimitsAvailable`。配套测试 `src/__tests__/subscriptionUsage.test.ts`。

## 非原生（编辑器）子 Agent 留痕

（新增 `src/subagents/ChildTranscript.ts`；接线在 `src/subagents/CodexSubagentSubscriptions.ts`、`src/CodexEventHandler.ts`、`src/CodexAcpServer.ts`、`src/tool-calls/AcpToolCallRenderer.ts` / `ClientCapabilities.ts` / `ToolFacts.ts` / `reporters/SubagentActivityReporter.ts`）

**问题**：编辑器（universe-editor）没有原生 subagent session，codex 会话里只有扁平的 `spawnAgent` / 「Start subagent X」卡，看不到子 agent 做了什么——claude 会话却把 Agent/Task 子 agent 的工具卡与文本嵌套展示在父卡下。原生子会话路线在编辑器侧走不通：ACP SDK 1.2.1 的 `zSessionUpdate` 是字面量 `z.union`，draft #1992 的 `subagent_spawned` / `subagent_state_update` 会被 parse 抛错，并被 `jsonrpc.js` 的 `.catch(err => this.close(err))` **关闭整条连接**。所以只在 `_meta` 自由字段里补信息，**绝不新增 sessionUpdate 变体**：父卡带 `_meta.codex.subagent = {threadId, path, activity}`，子项带 `_meta.codex.parentToolCallId`（值 = 父卡 ACP toolCallId）。编辑器侧只加一个读取器（`readParentToolCallId`，同时认 claude 的 `claudeCode.parentToolUseId`）。

**为什么必须能力位门控**：非 AIR 客户端的期望输出由「基线减去 `AIR_ONLY_CODEX_KEYS`」派生，`subagent` 正在该列表里（`src/__tests__/scenarios/baseline.ts`）——无条件恢复标记就得改上游测试基建，并让 Zed 等客户端凭空多出 `_meta` 键。故整个特性（标记 + live 子项路由 + 回放）都挂在 `clientCapabilities._meta["subagent-transcript"] === true` 上（**与 claude fork 同一字面量**，编辑器一份载荷喂两个 fork，先例是 `extraModels`）；`data/baseline/**`、`data/air/**`、39 个 scenario 基线一行不改，其它客户端零行为变化。形状不是新造的：baseline/plain/subagent-activity.jsonl 逐字节保留了 AIR 化之前 `_meta.codex.subagent` 的形态，且**只出现在 `subAgentActivity` 卡**（collab 卡从不带，故 `ToolFacts.subagentInfo` 与 `subagent` 分开，不复用后者）。

**白名单与深度**：子线程通知只放行「子 agent 干了什么」——`item/started|completed`（item 类型 ∈ commandExecution / fileChange / mcpToolCall / dynamicToolCall / webSearch / imageView / imageGeneration / reasoning / agentMessage）、`item/agentMessage/delta`、`item/reasoning/*`、`item/commandExecution/outputDelta|terminalInteraction`、`item/mcpToolCall/progress`。`turn/*`、`thread/*`、`plan`、`compaction`、`error`、`subAgentActivity`、`collabAgentToolCall` 一律不转发：它们描述子会话而非子 agent 的工作，且会污染根 turn 状态。`agentMessage` 项在白名单里是为回放（子 turn 的文本以 item 存在），live 与回放都复用根线程的渲染器——`createItemEvent` / `completeItemEvent` 对 `agentMessage` 都返回 null（文本走 delta），所以 live 不会重复发。深度**只做一层**（root 的直接子线程）：`CodexSubagentSubscriptions.discover(session, event, depth)` 的 `depth === 0` 分支才走 `dispatchChild`，孙线程维持旧表现（子项丢弃 + 记日志），与编辑器 `_childrenOf` 只查顶层 slot 一致。

**父卡与映射语义**：映射是 `SessionState.subagentParentItemByThreadId`（跨 prompt 存活），父卡有两个来源：`subAgentActivity` 卡（标题可读、承载 `_universe/subagentStats`）与**协作 `spawnAgent` 卡**。第二个来源是**真机修正**：最初只认 activity 卡，实测 codex 0.159.1 的委派走协作工具（`spawnAgent` + `wait`/`closeAgent`），**整轮不发一条 `subAgentActivity`**——只认 activity 会让特性在真实会话里永不触发（探针日志：`collabAgentToolCall` ×12、`subAgentActivity` ×0）。所以：`CollabAgentReporter` 给 spawnAgent 盖 `_meta.codex.subagent`（`subagentInfo = {threadId?, activity}`，**不给 `path`**——协作没有 agent path；app-server 只在 **completed** 项里给 `receiverThreadIds`，started 项是空数组，所以 started 卡只有 `activity`），`CodexEventHandler.recordCollaborationChildren` 把每个 receiver thread 记到该 spawn 卡（kind `"spawned"`）。`wait` / `sendInput` / `resumeAgent` / `closeAgent` 是控制调用而非子 agent：`subagent` 与 `subagentInfo` 都不盖，也绝不接管已有映射（只认 `tool === "spawnAgent"`）。写入语义 `kind === "started" || !map.has(threadId)`：**started 覆盖**（codex 恢复子 agent 会再发一次 started，子项该跟新卡）、**spawned / completed 只在缺席时兜底**（有 activity 卡时它优先，统计与子项留同一张卡）、首见兜底。对读 trail 的客户端，这是有意的可见变化：统计徽标从「最近的 activity 卡」移到启动该子 agent 的卡；无能力位客户端不受影响（见下「统计映射的两套账」）。

**无父卡缓冲**：codex 会在 spawning collaboration item 之后直接发子线程输出，而 activity item 可能更晚到。`CodexEventHandler` 用 `PendingNotificationBuffer`（per-thread，相邻 delta 合并，32MB 字节上限）暂存未命中的子通知，最多 `MAX_PENDING_SUBAGENT_THREADS = 16` 个线程、超出丢最旧的并记日志；`handleNotification` 末尾 `flushPendingChildTranscript()`，保证父卡先入队（同一串行队列）。子项永久无父卡时（极端）只丢该子项的嵌套，不 fail。**真机边界**：协作路径下子线程与它的 id 同时诞生（`receiverThreadIds` 在 spawn 的 completed 项里给出），实测在那之前到达的子线程事件只有 `thread/status/changed` / `mcpServer/startupStatus/updated` / `warning`——全在白名单外，故协作路径没有可见丢失；缓冲真正要挡的是 activity 路径（卡可能晚于子输出）。`dispose()`（prompt 收尾）会清空缓冲，因为那之后不再有卡会到。

**统计映射的两套账**：`createSubagentStatsUpdate` 读的映射按客户端分流（`CodexEventHandler.subagentParents`）：**读 trail 的客户端**用 session 级 `subagentParentItemByThreadId`（子 agent 跨 prompt 继续时仍归启动它的那张卡），**其余客户端**（plain/zed/AIR）用 handler 私有 `subagentCardOfPrompt`（每 prompt 一张，等价于改动前的字段）。分流原因：session 级映射会让无能力位客户端在后续 prompt 收到它以前收不到的 `toolCallStats` 更新，违反「其它客户端零变化」——分流后它们的 `_universe/subagentStats` 目标卡与更新集合和改动前一模一样。

**id 命名空间：v1 不加前缀**。依据是本机 rollout 实测 item id 前缀化（`call_*` / uuid / `msg_*` / `rs_*`…），跨 rollout 共享仅 4 例且均来自 fork/resume 复制；真正碰撞需「同一根下两个子线程出现同一 item id」，观测不到。**逃生舱**：真出现时在**子转发边界**加纯函数 `childItemId(threadId, itemId)`，live 与 replay 同一处映射（这正是现在不做前缀的原因——同一映射要落在两条路径）。同时该路径对每个子项 `item/started` 打一条 debug 日志（`Sub-agent transcript item` + threadId/itemId），便于真机复现。

**v1 明确不做**：孙线程子项、子权限卡（`renderPermissionToolCall` 不加标记）、子 `request_user_input` 回放；控制调用（`wait`/`sendInput`/`closeAgent`）卡不带标记、不承载子项。**子线程比根 turn 活得久**时，根 turn 结束的 `_settleOrphanToolCalls` 可能先给在飞子卡发孤儿 notice，随后 `item/completed` 正常落定——`handleChildTranscript` **不带 `disposed` 闸门**（与根线程一致），所以这句成立：卡的落定不依赖 prompt 是否已收尾。

**配套测试**：`src/__tests__/scenarios/editor-subagent-transcript.test.ts`（编辑器能力档案跑既有场景，断言标记形状 / 归属 / 一层深度 / 迟到输出 / plain 档案零变化；外加本地场景 `collaboration-work`：started 项空 `receiverThreadIds` + completed 项才带 id、子工作随后到达、`wait` 控制卡无标记、子 token 落在 spawn 卡）、`src/__tests__/CodexACPAgent/subagent-transcript.test.ts`（缓冲与顺序、闸门、Start 卡落点、started 重指向、缓冲溢出）。
