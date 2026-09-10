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
