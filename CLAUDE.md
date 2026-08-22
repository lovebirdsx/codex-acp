# CLAUDE.md — fork 维护与上游合并指南

本仓库是 **OpenAI `codex-acp` 的自维护 fork**（origin: `lovebirdsx/codex-acp`，上游: `agentclientprotocol/codex-acp`），作为 git submodule 嵌入 `universe-editor` 的 `vendor/codex-acp`。它是 stdio ACP agent：拉起 Codex App Server，把 ACP 请求翻译成 Codex 操作，再把 Codex 事件映回客户端。

> 项目结构 / 测试约定 / discriminated-union 写法 → 见 `AGENTS.md`；运行环境变量 / 本地客户端配置 / 打包 → 见 `README.md` 与 `readme-dev.md`。本文件**只讲 fork 特有的事**，不重复上述内容。

## 头号红线：保持源码 diff 最小，便于上游合并

这是 fork 的生命线。所有改动都要让「与上游的 diff」尽可能小、尽可能聚焦：

- **必须沿用本仓库自身的代码风格，不是父项目 universe-editor 的风格。** 本仓库 = **4 空格缩进 + 分号 + 双引号**；父项目 = 无分号 + 单引号 + 2 空格。两者完全相反。
- **当心父项目的 PostToolUse prettier 钩子。** 在 `universe-editor` 里用工具编辑本目录下的 `.ts` 时，父项目的 prettier 会按**父项目风格**重排整个文件，瞬间产生上千行无关 diff，彻底毁掉上游合并能力。本仓库**没有**自己的 prettier/eslint 配置，无法自动纠偏。
  - 改 fork 源码时，优先用最小化的精确 `Edit`，改完**立即检查 `git -C vendor/codex-acp diff`**，确认只有你预期的那几行变化；若发现整文件被重排，立刻 `git checkout` 还原后改用不会触发格式化的方式。
- 能不改源码就不改。优先走运行期开关（`CODEX_CONFIG` / `MODEL_PROVIDER` / 其它 env，见 `README.md`）或在父项目 `apps/editor` 侧解决。
- 真要改源码时：改动尽量局部、自包含、加清晰注释说明「为什么 fork 要这么做」，方便日后 rebase 时辨认与保留。

## fork 已有的本地改动（rebase 上游时需保留）

按提交信息为中文者识别（上游均为英文）：

- `build.mjs` — fork 自有的 esbuild 打包脚本（上游用 bun bundle）。产物 `dist/index.js` 为 ESM，并写出 `dist/package.json` (`{"type":"module"}`)，使其在 `app.asar` 旁被 Node 当模块加载。父项目用 `pnpm agent:build` 调它。
- session 费用计算相关改动（`src/CodexAcpServer.ts`、`src/CodexEventHandler.ts`）：上报 per-model USD 用量到 `_meta`，供父项目算人民币开销。子 Agent thread（collab/Task spawn 的独立 thread）的 `thread/tokenUsage/updated` 上游会发但默认无人订阅（`notify()` 按 threadId 精确路由）——`subscribeToSubagentThread`（CodexAcpServer）+ `subscribeToSubagentThreadEvents`（CodexAcpClient，去重与 closeSession 清理同源）为每个从 `subAgentActivity.agentThreadId` / `collabAgentToolCall.receiverThreadIds` 发现的子线程注册**仅认 token-usage** 的窄 handler（绝不进主 CodexEventHandler，防污染 turn 状态），快照记入 `SessionState.subagentTokenUsage` 并聚合进 `usage_update`/`buildQuotaMeta` 的 `_meta.quota`（`used`/`size` 保持主线程上下文口径）；同时给对应 subAgentActivity 卡片补发 `_universe/subagentStats`（无 model，父项目只显 tokens 不定价）。配套测试 `subagent-token-usage.test.ts`。
- Claude 兼容改动（`src/CodexAcpClient.ts`），让一套 `.claude/` 同时服务 Claude 与 Codex：
  - **skills**：`refreshSkills` 在 codex 原生的 `.agents/skills` 之外，额外把 `cwd/.claude/skills` 与各 `additionalRoots/.claude/skills` 加进 `skills/extraRoots/set`。codex 会自动扫 cwd 下的 `.agents/skills` 但从不扫 `.claude/skills`，故须显式列出。与 `.agents/skills` 保持对称（不做存在性检查）以最小化 diff。
  - **memory**：新增 `buildMemoryInstructions(cwd)`，读 `cwd/.claude/memory/MEMORY.md` 作为 `developerInstructions`（附加层，**绝不**用 `baseInstructions`——那会替换 codex 自身系统提示）注入到 `threadStart`/`threadResume`。对齐 Claude 每轮自动加载 memory 索引的行为；codex 随后可用文件工具按需读取 `.claude/memory/<slug>.md`。索引缺失/为空则不注入。
  - 配套测试：`CodexAcpClient.test.ts` 两处 `extraRoots` 断言新增 `.claude/skills` 项；`ignoredFields` 加入 `extraRoots`（dump 会把该字段匿名化为字段名，规避 `path.join` 在 Windows 产出反斜杠导致的跨平台快照漂移）；`data/send-attachments-turn-start.json` 快照前置一条匿名化的 `skills/extraRoots/set` 事件。
- 取消/中断表现（`src/CodexAcpServer.ts`）：`cancelledPromptResponse` **不再**推送 `*Conversation interrupted*` agent chunk（早先为配合编辑器旧 `[cancelled]` 哨兵而保留，上游 #358 已删）——编辑器现在自己渲染取消：零输出取消=撤回+恢复草稿，部分输出取消=本地补 `[Request interrupted by user]` 标记，fork 再推只会孤儿化/重复。对应地，`streamThreadHistory` 对 `thread/resume` 重建出的 `status === "interrupted"` 的 turn 在其 items 末尾补一条无 messageId 的 `user_message_chunk`（文本 `[Request interrupted by user]`）——rollout 把中断落成 `<turn_aborted>` 合成 user response_item，thread/resume 不重建它；被中断 turn 的**部分输出本身不在 rollout 里，resume 无法恢复**，只能恢复中断痕迹。编辑器 resume 过滤按文本匹配该标记（零输出撤回场景跳过它）。
  - 已知：上述 3 个用真实 codex 二进制 / spy 实际值的测试在 **Windows 本机**会因 `path.join` 反斜杠失败（codex rust 端 `AbsolutePathBuf` 拒收无盘符反斜杠路径；spy 实际值带反斜杠），**Linux CI 通过**。生产环境 Windows cwd 总带盘符，`path.join` 产出合法绝对路径，不受影响。
- 探活心跳（`src/ACPSessionConnection.ts` / `src/CodexEventHandler.ts` / `src/CodexAcpClient.ts` / `src/CodexAcpServer.ts`）：turn 运行且 ACP wire 静默 ≥30s 时，先以廉价只读 RPC（`thread/loaded/list`，10s 超时）探活 app-server 核心，**只有核心应答**才向客户端转发无内容心跳。背景：编辑器的 stall 看门狗（`acp.turnStallTimeoutMs`，默认 10min）以会话活跃时间计活，而 codex app-server 协议全事件驱动、无任何周期心跳，长静默 exec / collab 子 agent 等待 / 慢非流式调用会被误判 wedge 杀进程；核心真卡死时探活失败不发心跳，看门狗检出能力不受损。**载体是自定义通知 `_universe/liveness_ping`（params `{sessionId}`）**：ACP SDK 分发 `session/update` 前用 zod 校验 SessionUpdate union，塞私有变体（早期实现的写法）会被整体拒绝、根本到不了客户端 handler（"Error handling notification / Invalid params"）；扩展方法走 extNotification 钩子才是 SDK 合法通道，编辑器据此重置静默窗口。配套测试 `src/__tests__/liveness-probe.test.ts`（fake timers）。
- MCP 启动结果上报（`src/ACPSessionConnection.ts` 常量 / `src/CodexAcpServer.ts` `publishMcpStartupStatus`）：上游只对启动**失败/取消**发 tool_call 卡片，ready 的 server 完全静默——编辑器 MCP 面板把配置里的 server 播种为 `pending` 后永远等不到确认（claude 侧走 SDK system-init 透传，codex 无等价物）。fork 在 startup 结果就绪时追发自定义通知 `_universe/mcp_server_status`（params `{sessionId, servers: [{name, status}]}`，status = `connected`/`failed`/`cancelled`），编辑器 `onExtNotification` 接住后 `applyMcpServerSnapshot` 翻面板状态。配套测试 `load-session.test.ts`「forwards the MCP startup outcome…」。
- 恢复时图片重放顺序（`src/CodexAcpServer.ts` `createUserMessageUpdates` / `userInputToContentBlocks`）：live prompt 的 wire 顺序是图片在前文本在后（`buildPromptItems` 保序），但 `thread/resume` 重建的 `userMessage.content` 把 text input 排在 image input 前——verbatim 重放会让恢复出的消息把图片渲染在用户文本之后。修复：`createUserMessageUpdates` 用稳定排序把 image/localImage 输入的 chunk 提到 text 之前（`userInputReplayOrder`）；`userInputToContentBlocks` 的 `image` case 对 `data:` URL（`buildPromptItems` 给粘贴图存的形态）经 `parseImageDataUrl` 还原为真正的 ACP `image` block（`{type:'image', data, mimeType}`），使恢复后的图片走与 live 一致的 ImageRow 渲染而非文本内联链接；http(s) URL 与 localImage 仍降级为文本链接。配套测试 `load-session.test.ts`「replays image inputs ahead of text」；`data/load-session-history.json` 快照中 user chunk 顺序随之变为 image 链接在前。
- 历史回放 `request_user_input` 提问卡片（`src/ResponseItemHistoryFallback.ts`）：live 的交互式提问走 `elicitation/create`，rollout 里只留下 `function_call`/`function_call_output`（name=`request_user_input`）一对 response_item，而 `thread/resume` 不重建该 item——走通用工具渲染只会得到标题为 `request_user_input` 的空壳卡片（问题/选项/答案埋在 raw JSON 里不显示）。修复：fallback 对该 name 特判，`tool_call` 的 title 用问题文本（多问时用 "Input requested"，对齐 live `buildUserInputRequest` 的 message 规则）、content 带问题+选项列表；`tool_call_update` 渲染成与 claude fork AskUserQuestion 回放一致的 `> 问题` + `**答案**：…`（无答案显示 `（跳过）`）文本，answers 负载解析失败时回退通用 rawOutput 路径。配套测试 `response-item-history-fallback.test.ts` 三个用例 + `load-session.test.ts`「replays a request_user_input rollout pair…」。
- live `request_user_input` 留痕 + 答案折叠（`src/CodexElicitationHandler.ts`）：
  - **live 留痕**：app-server 从不把 request_user_input 暴露为 thread item，elicitation 卡片一 settle 提问就从客户端 timeline 消失。`handleUserInput` 在回答（含 decline/cancel/自动超时，均记 `（跳过）`）后调 `publishUserInputCard` 补发与回放完全相同的 `tool_call`+`tool_call_update` 对——渲染函数直接从 `ResponseItemHistoryFallback.ts` export 复用（`createUserInputToolCallEvent` / `createUserInputAnswerUpdate` / `UserInputQuestion`），保证 live 与历史回放卡片一致；两者不会同时出现（回放是新 attach 从 rollout 重建整条 timeline）。客户端不支持 form elicitation 时不发（从未提问）。
  - **答案折叠**：`convertUserInputResponse` 原来对 isOther 问题用 `other ?? 选项`，用户既选选项又填 `__other` 备注时选中项被整体吞掉（模型也收不到）。现经 `mergeUserInputAnswer` 折叠为 `<选项>（补充：<备注>）` 单条 answer；仅选项/仅备注时各自原样。对齐 claude fork AskUserQuestion 的 answer+annotations 语义（codex 的 `ToolRequestUserInputAnswer` 只有 `answers: string[]`，无 annotations 通道，故拼接进单字符串）。配套测试 `elicitation-events.test.ts`「folds a typed Other note onto the selected option…」「keeps a free-form Other answer…」「publishes a question card to the session timeline…」。
- mid-turn 普通 `session/prompt` 转 steering（`src/CodexAcpServer.ts` `prompt()` 早退分支 + 新增 `promptViaSteering`）：turn 运行中 client 再发一条普通 prompt（universe-editor 编辑器的 mid-turn steering 方式）时，原正常路径会清掉 `currentTurnId` 并发第二个 `turn/start`——app-server 把输入并入运行中的 turn，新 turn id 永远等不到 `turn/completed`，`awaitTurnCompleted`（裸 promise 无超时）永不 resolve，client 会话永远卡在 running。修复：检测到 `activePrompts` 里有运行中 prompt 时改走 `executeOrQueueSteeringRequest`（SteeringQueue 串行 → `turn/steer` 注入或兜底开新 turn），再 await 对应 activePrompt 的 `completion` 后回 `{stopReason:"end_turn"}`（对齐 claude fork mid-turn prompt 的 settle 语义）；`failed` 抛 RequestError，校验类 RequestError（如纯文本模型收图片）原样上传。递归安全：`startNewTurnFromSteering` 调 `this.prompt()` 前已 await 前一 prompt 的 completion。配套测试 `steer-events.test.ts`「session/prompt during an active turn」三个用例。
- 官方订阅额度用量（`src/CodexAppServerClient.ts` / `src/AcpExtensions.ts` / `src/CodexAcpServer.ts`）：编辑器输入框的用量指示器要在 ChatGPT 登录下显示额度窗口百分比，而不是内部网关的人民币月度开销。新增两个 client→agent ext-method——`universe-editor/subscription_usage`（读 `account/rateLimits/read`，原样透传 `rateLimits`/`rateLimitsByLimitId`，归一化交给编辑器侧，避免两个 fork 各写一份漂移）与 `universe-editor/consume_reset_credit`（`account/rateLimitResetCredit/consume`，省略 `creditId` 由后端挑下一张；`idempotencyKey` 必填且非空——空 key 会让后端每次重试都多扣一张额度）。**关键坑**：`RateLimitResetCreditsSummary.availableCount` 是 ts-rs 对 Rust u64 的产物即 `bigint`，`JSON.stringify` 遇 bigint 直接抛 `TypeError` 会带崩整条 JSON-RPC 响应——handler 返回前必须 `String(...)`，编辑器侧 `Number()` 还原。两个 case 都套 `runWithProcessCheck`；读取失败降级为 `supported:false` 而非报错（编辑器据此隐藏指示器）。配套测试 `src/__tests__/subscriptionUsage.test.ts`。
- 历史回放字节预算（**新增** `src/ReplayBudget.ts` / `src/ReplayFileRead.ts`；接线在 `src/CodexAcpServer.ts` `streamThreadHistory` → 新增 `streamCappedHistoryUpdates`、`src/CodexToolCallMapper.ts` `readFileContent`、`src/ResponseItemHistoryFallback.ts` `createResponseItemHistoryFallbackUpdates`）：`streamThreadHistory` 原本把整条 thread（`thread/read includeTurns:true`）+ 整份 rollout 全量物化成 `UpdateSessionEvent[]` 逐条下发，**无累计预算、无单条截断**——一个长构建型会话（数百次 commandExecution 各带完整输出 + fileChange 的 diff 是整文件内容）每次 resume 都重发整个语料库，实测把编辑器 renderer 打到 4.4GB OOM（main 侧 heap 同步涨到 1GB，因为它要 JSON 编码 + 结构化克隆每一个字节，renderer 自己的 256MB ingestion 预算救不了）。claude fork 早有等价上限（`acp-agent.ts` 的 `MAIN_REPLAY_MESSAGE_CAP_BYTES`/`MAIN_REPLAY_TOTAL_CAP_BYTES`），本组改动是 codex 侧对齐：
  - `ReplayBudget.ts`：`capReplayUpdate(update, maxFieldBytes=1MB)` **递归遍历 update 的所有字符串字段**做截断（**刻意不按 item 类型 switch**——任何 thread item 类型新加重字段当天即被覆盖，不会静默绕过），返回截断后字节数供累计记账；`REPLAY_TOTAL_CAP_BYTES=96MB`。`streamCappedHistoryUpdates` 逐条 `capReplayUpdate` + 累计，超限时 logger 记录并发一条 `agent_message_chunk` 说明后 return（**从头发、超限停 = 丢较新的尾部**，与 claude fork 同向；不 fail 整个 resume，会话仍带较早历史打开）。
  - `ReplayFileRead.ts`：`readFileWithinCap(path, maxBytes, onOversize?)` **stat 先判再读**（超限根本不 materialise，而不是读完再截）。两个调用点：`readFileContent`（回放重建 diff 时重读磁盘文件全文，`REPLAY_FILE_READ_CAP_BYTES=8MB`，超限跳该 diff 卡）、rollout fallback 的整文件读（`REPLAY_ROLLOUT_READ_CAP_BYTES=64MB`）。
  - 配套测试 `src/__tests__/ReplayBudget.test.ts`（5 例：小 update 保持引用同一性 / 命令输出在 text block 与 rawOutput **两份**都被截断 / diff 双侧截断 / 巨型 payload 记账受 cap 约束 / 循环引用不爆栈）+ `src/__tests__/ReplayFileRead.test.ts`（3 例）。
  - **踩坑**：`file-change-events.test.ts` 的 `vi.mock('node:fs/promises')` 原先只桩了 `readFile`，新增的 `stat` 调用打到真实 fs 导致 4 个既有用例失败——已补 `stat` 桩（按 mock 内容长度报 size）。以后在回放路径新增任何 fs 调用都要同步补桩。

rebase/merge 上游后，逐一核对这些改动是否仍在、是否需随上游 API 调整。

## 配置 upstream remote

本地 clone 默认只有 `origin`（fork）。remote 是本地状态、不随仓库传播，须每个 clone 各自配一次。在**父项目根目录**跑：

```bash
node scripts/setup-vendor-remotes.mjs   # 一键为两个 fork 配 upstream
```

或手动：`git -C vendor/codex-acp remote add upstream https://github.com/agentclientprotocol/codex-acp.git`。配完 `git -C vendor/codex-acp remote -v` 应含 `upstream`。

## 构建与父项目的衔接

- 本仓库**不在** universe-editor 的 pnpm workspace 内，用自带 npm 工具链独立构建。
- 改完 fork 源码或拉取上游后，在**父项目根目录**跑 `pnpm agent:build`（= npm ci + 本仓库 build + prune 生产依赖），生成 `dist/` 与 `node_modules/`。也可在本目录直接 `npm run build` 仅重建 `dist/index.js`。
- `dist/` 与 `node_modules/` 均 `.gitignore`，不进 fork 提交；但父项目打包（`electron-builder.yml` 的 `extraResources`）会带上构建产物。
- dev 与发布同一套启动：父项目 main 进程用 Electron 自带 node（`ELECTRON_RUN_AS_NODE`）跑 `dist/index.js`，不依赖系统 node/npx。

## 升级 Codex 原生二进制

`@openai/codex` 是本仓库 dependency，App Server 协议类型由它生成。升级步骤（详见 `readme-dev.md` 末节）：

1. 改 `package.json` 里 `@openai/codex` 版本。
2. `npm run generate-types` 重新生成 `src/app-server/`（生成代码，勿手改）。
3. `npm run typecheck && npm run test` 确认无类型错误 / 测试失败。

注意：父项目另有 `apps/editor/.../codexBinary` 维护一个独立下载的 codex 二进制版本号，升级时两边需对齐。

## 调试 / 受控实验

- Codex 内部 trace 日志：`~/.codex/logs_2.sqlite`（表 `logs`，用 Node `node:sqlite` 只读打开）；`RUST_LOG=trace` 让 codex 把详细 trace 打到 stderr。
- 复现协议层问题的最小手段：`spawn` 出的 `codex app-server` 是 newline-delimited JSON-RPC over stdio，手动发 `initialize` → `thread/start{cwd,config:{}}` 即可测会话创建耗时；用 PowerShell `Get-CimInstance Win32_Process` 观察它 spawn 的子进程（如 git）。
- 已知坑：Windows 上 `thread/start` 在 **cwd 为 git 仓库**时会被 codex 原生二进制内部一个挂起的 `git rev-parse --git-dir` 子进程拖慢 ~4.5s（与仓库大小、skills、网络均无关）。这是**原生二进制的 bug，adapter 改不了**——勿在 fork 源码里加 workaround，应走升级二进制 / 上游报 bug。

## 其它

- 制作相关功能时，记得同步更新本文档
