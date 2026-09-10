# CLAUDE.md — fork 维护与上游合并指南

本仓库是 **OpenAI `codex-acp` 的自维护 fork**（origin: `lovebirdsx/codex-acp`，上游: `agentclientprotocol/codex-acp`），作为 git submodule 嵌入 `universe-editor` 的 `vendor/codex-acp`。它是 stdio ACP agent：拉起 Codex App Server，把 ACP 请求翻译成 Codex 操作，再把 Codex 事件映回客户端。

> 项目结构 / 测试约定 / discriminated-union 写法 → 见 `AGENTS.md`；运行环境变量 / 本地客户端配置 / 打包 → 见 `README.md` 与 `readme-dev.md`。本文件**只讲 fork 特有的事**，不重复上述内容。

## 头号红线：保持源码 diff 最小，便于上游合并

所有改动都要让「与上游的 diff」尽可能小、尽可能聚焦：

- **必须沿用本仓库自身的代码风格，不是父项目 universe-editor 的风格。** 本仓库 = **4 空格缩进 + 分号 + 双引号**；父项目 = 无分号 + 单引号 + 2 空格。两者完全相反。
- **当心父项目的 PostToolUse prettier 钩子。** 在 `universe-editor` 里用工具编辑本目录下的 `.ts` 时，父项目的 prettier 会按**父项目风格**重排整个文件，瞬间产生上千行无关 diff，彻底毁掉上游合并能力。本仓库**没有**自己的 prettier/eslint 配置，无法自动纠偏。改 fork 源码时，优先用最小化的精确 `Edit`，改完**立即检查 `git -C vendor/codex-acp diff`**，确认只有你预期的那几行变化；若发现整文件被重排，立刻 `git checkout` 还原后改用不会触发格式化的方式。
- 能不改源码就不改。优先走运行期开关（`CODEX_CONFIG` / `MODEL_PROVIDER` / 其它 env，见 `README.md`）或在父项目 `apps/editor` 侧解决。
- 真要改源码时：改动尽量局部、自包含、加清晰注释说明「为什么 fork 要这么做」，方便日后 rebase 时辨认与保留。

## fork 已有的本地改动（rebase 上游时需保留）

按提交信息为中文者识别（上游均为英文）。带「详见」的条目，完整 bug 叙事/设计约束已拆到对应 cases 文档：

- 网关模型注入会话模型清单（**新增** `src/ExtraModels.ts`；接线在 `src/CodexAcpServer.ts` 私有 `withExtraModels`）：客户端经顶层 `_meta.extraModels` 注入候选（与 claude fork **刻意同名同层级**，编辑器一份载荷喂两个 fork），两个注入点（new+resume、load）经 `withExtraModels` 收敛同一追加逻辑；synthesized 条目 `supportedReasoningEfforts: []` + `defaultReasoningEffort` 拷贝会话当前 effort（**不写死 `"medium"`**）。详见 [cases-session.md](cases-session.md)
- 模型是否在目录里的权威上报（`src/CodexAcpServer.ts` `SessionState.modelKnownInCatalog` + 私有 `isModelInCatalogue` / `createSessionModelMeta`，三个会话响应展开 `_meta.codex.modelKnownInCatalog`）：客户端无法自行判定（目录条目与注入条目形状完全相同），fork 上报这一位——**必须用 `withExtraModels` 之前的原始 `catalogueModels`**；两个会话构造点都要赋值，漏一处退化成误报。编辑器侧 `readCodexModelKnownInCatalog` 把字段缺失视为「未知」保证向后兼容。详见 [cases-session.md](cases-session.md)
- `build.mjs` — 上游自带（esbuild，`npm run build`）；fork 的增量只有末尾写出 `dist/package.json` (`{"type":"module"}`)，使其在 `app.asar` 旁被 Node 当模块加载。父项目用 `pnpm agent:build` 调它。
- session 费用计算相关改动（`src/CodexAcpServer.ts`、`src/CodexEventHandler.ts`）：上报 per-model USD 用量到 `_meta`，供父项目算人民币开销。子 Agent thread（collab/Task spawn 的独立 thread）的 `thread/tokenUsage/updated` 上游会发但默认无人订阅，子线程发现统一走上游 `src/subagents/CodexSubagentSubscriptions.ts`（旧 fork 自建的 `subscribeToSubagentThreadEvents` 已删除——它用 Map.set 覆盖上游 handler，破坏原生子会话路由）；原生子会话 client 走 dispatch 进主 handler，无原生子会话（编辑器）则 fork 在该 discover 回调里对 `thread/tokenUsage/updated` 额外 dispatch 一次；主 handler 按 `params.threadId !== sessionState.sessionId` 分流到 `handleSubagentTokenUsage`（绝不污染主线程 turn/token 状态）。快照记入 `SessionState.subagentTokenUsage` 并聚合进 `usage_update`/`buildQuotaMeta` 的 `_meta.quota`（`used`/`size` 保持主线程上下文口径）；同时给对应 subAgentActivity 卡片补发 `_universe/subagentStats`（无 model，父项目只显 tokens 不定价）。配套测试 `subagent-token-usage.test.ts`。详见 [cases-session.md](cases-session.md)
- Claude 兼容改动（`src/CodexAcpClient.ts`），让一套 `.claude/` 同时服务 Claude 与 Codex：
  - **skills**：`refreshSkills` 额外把 `cwd/.claude/skills` 与各 `additionalRoots/.claude/skills` 加进 `skills/extraRoots/set`（codex 从不扫 `.claude/skills`，须显式列出；与 `.agents/skills` 保持对称、不做存在性检查以最小化 diff）。
  - **memory**：`buildMemoryInstructions(cwd)` 读 `cwd/.claude/memory/MEMORY.md` 作为 `developerInstructions` 注入 `threadStart`/`threadResume`（附加层，**绝不**用 `baseInstructions`——那会替换 codex 自身系统提示）；索引缺失/为空则不注入。
  - 配套测试：`CodexAcpClient.test.ts` 两处 `extraRoots` 断言 + `ignoredFields` 加入 `extraRoots`（规避 Windows 反斜杠快照漂移）+ `data/send-attachments-turn-start.json` 快照前置匿名化 skills 事件。
- 取消/中断表现（`src/CodexAcpServer.ts`）：`cancelledPromptResponse` **不再**推送 `*Conversation interrupted*` agent chunk（编辑器现在自己渲染取消）；`streamThreadHistory` 对 `thread/resume` 重建出的 `status === "interrupted"` turn 补无 messageId 的 `user_message_chunk`（文本 `[Request interrupted by user]`）——被中断 turn 的部分输出不在 rollout 里、resume 无法恢复，只能恢复中断痕迹。详见 [cases-replay.md](cases-replay.md)
- 探活心跳（`src/ACPSessionConnection.ts` / `src/CodexEventHandler.ts` / `src/CodexAcpClient.ts` / `src/CodexAcpServer.ts`）：turn 运行且 ACP wire 静默 ≥30s 时先以廉价只读 RPC（`thread/loaded/list`，10s 超时）探活 app-server 核心，**只有核心应答**才转发无内容心跳（防编辑器 stall 看门狗误杀长静默会话）。**载体是自定义通知 `_universe/liveness_ping`（params `{sessionId}`），必须走 extNotification 钩子**——塞 SessionUpdate union 私有变体会被 SDK 的 zod 校验整体拒绝，到不了客户端 handler。配套测试 `src/__tests__/liveness-probe.test.ts`（fake timers）。
- MCP 启动结果上报（`src/ACPSessionConnection.ts` 常量 / `src/mcp/McpSessionStartup.ts` `publish`）：上游只对启动失败/取消发 tool_call 卡片，ready 的 server 完全静默——编辑器 MCP 面板把 server 播种为 `pending` 后永远等不到确认。fork 在 startup 结果就绪时追发 `_universe/mcp_server_status`（params `{sessionId, servers: [{name, status}]}`，status = `connected`/`failed`/`cancelled`）。配套测试 `load-session.test.ts`「forwards the MCP startup outcome…」。
- 恢复时图片重放顺序（`src/CodexAcpServer.ts` `createUserMessageUpdates` / `userInputToContentBlocks`）：`thread/resume` 重建的 content 把 text 排在 image 前，verbatim 重放会把图片渲染在文本之后；用稳定排序把 image/localImage 提到 text 前，`data:` URL 经 `parseImageDataUrl` 还原为真 ACP `image` block（走与 live 一致的 ImageRow 渲染）。详见 [cases-replay.md](cases-replay.md)
- live `request_user_input` 留痕 + 回放（`src/CodexElicitationHandler.ts` + `src/RequestUserInputHistory.ts` + `src/RequestUserInputReplay.ts`）：`publishUserInputCard` 在回答（含 decline/cancel/超时，均记 `（跳过）`）后补发 `tool_call`+`tool_call_update` 对，把问题、选项与答案留在会话时间线里（渲染函数在 `RequestUserInputHistory.ts`，live 与回放共用）。**回放半边保留**：typed items（`thread/turns/list` + `thread/items/list`）既无 questions 也无答案，`RequestUserInputReplay.ts` 只从 rollout JSONL 补回这一对（**不恢复旧的整份 shell 解析**，那三个 shell 补丁保持删除），按共享锚点（tool id==`call_id`、user item `clientId`==rollout `client_id`、agent 文本键）插回 typed 流，带 rewind/边界两个截断守卫，走同一份回放字节预算，读盘有 `ReplayFileRead` 的 stat 先判 64MB 上限；失败只丢卡片不 fail 会话。**答案折叠：AIR 走上游 `None of the above` + `user_note:` 原样，非 AIR（编辑器）保留 fork 折叠 `<选项>（补充：<备注>）`**。配套测试 `RequestUserInputReplay.test.ts` / `ReplayFileRead.test.ts` / `elicitation-events.test.ts` / `load-session.test.ts`（rollout fixture 全链路）。详见 [cases-replay.md](cases-replay.md)
- mid-turn 普通 `session/prompt` 转 steering（`src/CodexAcpServer.ts` `prompt()` 早退分支 + 新增 `promptViaSteering`）：原正常路径会清掉 `currentTurnId` 并发第二个 `turn/start`，新 turn id 永远等不到完成、client 会话永远卡 running；修复为检测到 `activePrompts` 有运行中 prompt 时改走 `executeOrQueueSteeringRequest`，回 `{stopReason:"end_turn"}`；`failed` 抛 RequestError（校验类原样上传）。配套测试 `steer-events.test.ts` 三个用例。详见 [cases-session.md](cases-session.md)
- 官方订阅额度用量（`src/CodexAppServerClient.ts` / `src/AcpExtensions.ts` / `src/CodexAcpServer.ts`）：新增 `universe-editor/subscription_usage`（读 `account/rateLimits/read`，原样透传，归一化交给编辑器侧）与 `universe-editor/consume_reset_credit`（`idempotencyKey` 必填且非空——空 key 会让后端每次重试都多扣一张额度）。**关键坑：`availableCount` 是 ts-rs 对 Rust u64 的产物即 `bigint`，`JSON.stringify` 直接抛 `TypeError` 带崩整条 JSON-RPC 响应——返回前必须 `String(...)`**。**auth-mode 门控（务必保留）：只有 `type === "chat-gpt"` 才发 RPC**——`account/rateLimits/read` 按 `auth.json` 的账号作答、与本轮实际计费到哪个 `model_provider` 无关，残留过 `codex login` 会把 ChatGPT 套餐窗口误报成网关会话额度。详见 [cases-session.md](cases-session.md)
- 历史回放字节预算（`src/ReplayBudget.ts`；接线在 `src/CodexAcpServer.ts` `streamThreadHistory` → `streamCappedHistoryUpdate` / `streamHistoryItem`）：回放把整条 thread 物化成 `session/update` 逐条下发，**无累计预算、无单条截断**——长构建型会话每次 resume 都重发整个语料库，实测把编辑器 renderer 打到 4.4GB OOM（claude fork 早有 `MAIN_REPLAY_MESSAGE_CAP_BYTES` 等价上限，本组是对齐）：
  - `ReplayBudget.ts`：`capReplayUpdate(update, maxFieldBytes=1MB)` **递归遍历 update 的所有字符串字段**截断（**刻意不按 item 类型 switch**——任何 thread item 类型新加重字段当天即被覆盖，不会静默绕过），返回截断后字节数供累计记账；`REPLAY_TOTAL_CAP_BYTES=96MB`。`streamCappedHistoryUpdate` 逐条 `capReplayUpdate` + 累计，超限时 logger 记录并发一条 `agent_message_chunk` 说明后令 `streamHistoryItem` 返回 false，两条回放路径（legacy 循环与 `streamNativeThreadHistory` 的嵌套子会话）都据此提前 return（**从头发、超限停 = 丢较新的尾部**，与 claude fork 同向；不 fail 整个 resume，会话仍带较早历史打开）。预算对象 `ReplayBudgetState` 由 `streamThreadHistory` 创建，嵌套子会话共用同一份。
  - 配套测试 `src/__tests__/ReplayBudget.test.ts`（5 例：小 update 保持引用同一性 / 命令输出在 text block 与 rawOutput **两份**都被截断 / diff 双侧截断 / 巨型 payload 记账受 cap 约束 / 循环引用不爆栈）。
  - **ReplayFileRead.ts（保留）**：提问卡片回放读 rollout 走 `readFileWithinCap`（stat 先判，`REPLAY_ROLLOUT_READ_CAP_BYTES=64MB`，超限只丢卡片），卡片同样计入本条预算。旧 fork 该模块还守的另一处磁盘读——回放重建 diff 读文件全文——已随 typed-item 重构消失（diff 由 codex 的 `FileUpdateChange.diff` 重建，上游 `FileChangeReporter` 自带 `fitsDiffLimit` 尺寸闸）。

rebase/merge 上游后，逐一核对这些改动是否仍在、是否需随上游 API 调整。

## 配置 upstream remote

本地 clone 默认只有 `origin`（fork）。remote 是本地状态、不随仓库传播，须每个 clone 各自配一次。在**父项目根目录**跑：

```bash
node scripts/setup-vendor-remotes.mjs   # 一键为两个 fork 配 upstream
```

或手动：`git -C vendor/codex-acp remote add upstream https://github.com/agentclientprotocol/codex-acp.git`。配完 `git -C vendor/codex-acp remote -v` 应含 `upstream`。

## 构建与父项目的衔接

构建 / 打包 / 启动机制（`pnpm agent:build`、`ELECTRON_RUN_AS_NODE`、`extraResources`）→ 见**根 CLAUDE.md「内置 ACP agent」节**。fork 特有：本目录 `npm run build`（= `node build.mjs`）仅重建 `dist/index.js`；`dist/` 与 `node_modules/` 均 `.gitignore`，不进 fork 提交。

## 升级 Codex 原生二进制

`@openai/codex` 是本仓库 dependency，App Server 协议类型由它生成。升级步骤（详见 `readme-dev.md` 末节）：

1. 改 `package.json` 里 `@openai/codex` 版本。
2. `npm run generate-types` 重新生成 `src/app-server/`（生成代码，**勿手改**）。
3. `npm run typecheck && npm run test` 确认无类型错误 / 测试失败。

注意：父项目另有 `apps/editor/.../codexBinary` 维护一个独立下载的 codex 二进制版本号，升级时两边需对齐。

## 调试 / 受控实验

- Codex 内部 trace 日志：`~/.codex/logs_2.sqlite`（表 `logs`，用 Node `node:sqlite` 只读打开）；`RUST_LOG=trace` 让 codex 把详细 trace 打到 stderr。
- 复现协议层问题的最小手段：`spawn` 出的 `codex app-server` 是 newline-delimited JSON-RPC over stdio，手动发 `initialize` → `thread/start{cwd,config:{}}` 即可测会话创建耗时；用 PowerShell `Get-CimInstance Win32_Process` 观察它 spawn 的子进程（如 git）。
- 已知坑：Windows 上 `thread/start` 在 **cwd 为 git 仓库**时会被 codex 原生二进制内部一个挂起的 `git rev-parse --git-dir` 子进程拖慢 ~4.5s（与仓库大小、skills、网络均无关）。这是**原生二进制的 bug，adapter 改不了**——**勿在 fork 源码里加 workaround**，应走升级二进制 / 上游报 bug。

## 其它

- 制作相关功能时，记得同步更新本文档（大叙事拆到 cases 文档）。
