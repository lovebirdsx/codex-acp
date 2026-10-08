# cases-replay.md — 恢复/回放/取消表现改动的完整叙事

对应 `CLAUDE.md`「fork 已有的本地改动」中带「详见本文档」的回放类条目，保留完整 bug 叙事与设计约束，供 rebase 冲突时参考。

## 取消/中断表现

（`src/CodexAcpServer.ts`）

`cancelledPromptResponse` **不再**推送 `*Conversation interrupted*` agent chunk（早先为配合编辑器旧 `[cancelled]` 哨兵而保留，上游 #358 已删）——编辑器现在自己渲染取消：零输出取消=撤回+恢复草稿，部分输出取消=本地补 `[Request interrupted by user]` 标记，fork 再推只会孤儿化/重复。对应地，`streamThreadHistory` 对 `thread/resume` 重建出的 `status === "interrupted"` 的 turn 在其 items 末尾补一条无 messageId 的 `user_message_chunk`（文本 `[Request interrupted by user]`）——rollout 把中断落成 `<turn_aborted>` 合成 user response_item，thread/resume 不重建它；被中断 turn 的**部分输出本身不在 rollout 里，resume 无法恢复**，只能恢复中断痕迹。编辑器 resume 过滤按文本匹配该标记（零输出撤回场景跳过它）。

已知：上述 3 个用真实 codex 二进制 / spy 实际值的测试在 **Windows 本机**会因 `path.join` 反斜杠失败（codex rust 端 `AbsolutePathBuf` 拒收无盘符反斜杠路径；spy 实际值带反斜杠），**Linux CI 通过**。生产环境 Windows cwd 总带盘符，`path.join` 产出合法绝对路径，不受影响。

## 恢复时图片重放顺序

（`src/CodexAcpServer.ts` `createUserMessageUpdates` / `userInputToContentBlocks`）

live prompt 的 wire 顺序是图片在前文本在后（`buildPromptItems` 保序），但 `thread/resume` 重建的 `userMessage.content` 把 text input 排在 image input 前——verbatim 重放会让恢复出的消息把图片渲染在用户文本之后。修复：`createUserMessageUpdates` 用稳定排序把 image/localImage 输入的 chunk 提到 text 之前（`userInputReplayOrder`）；`userInputToContentBlocks` 的 `image` case 对 `data:` URL（`buildPromptItems` 给粘贴图存的形态）经 `parseImageDataUrl` 还原为真正的 ACP `image` block（`{type:'image', data, mimeType}`），使恢复后的图片走与 live 一致的 ImageRow 渲染而非文本内联链接；http(s) URL 与 localImage 仍降级为文本链接。配套测试 `load-session.test.ts`「replays image inputs ahead of text」；`data/load-session-history.json` 快照中 user chunk 顺序随之变为 image 链接在前。

## 历史回放 `request_user_input` 提问卡片

（`src/RequestUserInputReplay.ts` + `src/ReplayFileRead.ts`；接线在 `src/CodexAcpServer.ts` `streamThreadHistory` → `streamHistoryItem` / `streamRemainingUserInputCards`）

live 侧的提问卡片（见下节）必须能在恢复会话里重放，但 typed-item 历史里**既没有 request 的 questions 也没有答案**：`thread/turns/list` + `thread/items/list` 不重建 elicitation，`functionCallOutput` 项也被上游跳过（用真实 app-server 探针确认过 typed items 里完全没有这对调用）。旧 fork 的 `ResponseItemHistoryFallback.ts` 对 `function_call`（name=`request_user_input`）特判重建卡片；上游 typed-item 重构把整个模块（连同其中被判定多余的 shell 解析）删掉了，回放半边随之丢失。

保留方式：**只补回这一对**，不恢复旧的整份 rollout shell 解析（`d4c3c9d`/`39aa2b4`/`d933b3f` 三个 shell 补丁保持删除）。`RequestUserInputReplay.ts` 从 rollout JSONL（`Thread.path`，`thread/resume` 返回）里扫出 `function_call`/`function_call_output` 对，按两个存储共享的锚点插回 typed 流：

- 锚点键：tool item id == rollout `call_id`（`call:<id>`）；user item `clientId` == rollout `event_msg.user_message.client_id`（`user:<id>`，真实 app-server 探针验证相等）；agent message 用**有界文本键**（`agent:<len>:<前 256 字符>`），空文本不成锚。
- 顺序：锚点按 rollout 出现顺序入数组 + 出现次数索引 + 游标，重复键（两条同文 agent message）按顺序消费，避免错位。
- 重放位置：typed 流走到「卡片之后第一个锚点」对应的 item 时先发卡片（`takeBefore`），否则在历史末尾兜底（`takeRemaining`）。
- 两个截断守卫（typed 流不是完整 rollout 的情况）：rewind 只截掉较新的 turn、rollout 仍保留——兜底时只发「其 turn 的开头 user message 确实被重放过」的卡片；resume 边界让 typed 流从中间开始——窗口打开时丢弃**结束于第一个重放 item 之前**的卡片（那段历史在上一次读取时已发过）。
- 渲染与 live 完全一致：复用 `RequestUserInputHistory.ts` 的 `createUserInputToolCallEvent` / `createUserInputAnswerUpdate`（同一对 `tool_call`+`tool_call_update`），并走同一份回放字节预算 `streamCappedHistoryUpdate`。
- 失败绝不致命：rollout 缺失/超限/读不出（`readFileWithinCap`，stat 先判 + `REPLAY_ROLLOUT_READ_CAP_BYTES=64MB`）只丢卡片，不 fail 会话。

配套测试：`RequestUserInputReplay.test.ts`（锚点/顺序/重复键/rewind/边界/坏行）、`ReplayFileRead.test.ts`（超限不读）、`load-session.test.ts`「replays a request_user_input rollout pair…」（legacy 全链路：卡片在 commentary 与 final answer 之间、答案文本 `**答案**：6`、恰好一对 update）、「replays the question card on the paginated history the editor reads」、「drops the question cards of the turns a rewind removed from the thread」、「loads a session whose rollout cannot be read, without the question cards」（先补测试证实回退：无接线时前三个用例失败）。

## live `request_user_input` 留痕 + 答案折叠

（`src/CodexElicitationHandler.ts`）

- **live 留痕**：app-server 从不把 request_user_input 暴露为 thread item，elicitation 卡片一 settle 提问就从客户端 timeline 消失。`handleUserInput` 在回答（含 decline/cancel/自动超时，均记 `（跳过）`）后调 `publishUserInputCard` 补发 `tool_call`+`tool_call_update` 对，把问题、选项与答案留在会话时间线里；渲染函数（`createUserInputToolCallEvent` / `createUserInputAnswerUpdate` / `UserInputQuestion`）现居 `RequestUserInputHistory.ts`（live 与回放共用）；sessionId 取 `params.threadId`（子 agent 路由会把它改写成 ACP session id）。客户端不支持 form elicitation 时不发（从未提问）。配套测试 `elicitation-events.test.ts`「publishes a question card to the session timeline…」。
- **答案折叠：AIR 走上游约定，非 AIR 保留 fork 折叠**：上游 #570/#577 把 note 字段从 `__other` 改名 `_note`，并用 `None of the above` + `user_note: <文本>` 两条 answer 表达「选了 Other 并补充」。fork 的 `mergeUserInputAnswer` 曾把这个折叠成 `<选项>（补充：<备注>）` 单条 answer。现状：**AIR 客户端（`airClient`）保持上游原样**（`None of the above` / `user_note:` 两条，不破上游用法）；**非 AIR 客户端（编辑器）用 fork 的折叠**——isOther 问题的选项里仍额外提供 `None of the above`（编辑器没有「自由回答」输入框，靠它表达选「其他」），选中它 + 备注 → 只发备注文本；选了具体选项 + 备注 → `<选项>（补充：<备注>）`。`_note` 字段名沿用上游新命名。live 与回放共用同一渲染，恢复会话折叠结果一致。

## 官方 Codex app 迁成 paginated 后的 `session/load`（已上游化）

旧世界：codex 0.146 起会把官方 app 打开过的 rollout 迁成 paginated history，`thread/resume` 成功但 `thread/read(includeTurns=true)` 直接拒绝；当时 fork 生成类型停留在 0.145（没有 `thread/turns/list`），只能在 resume 后捕获该错误、放弃 turns，让 `streamThreadHistory` 从 rollout JSONL 兜底重放（`includeAllItems`），并且在空 turns 时绕开 `mergeHistoryUpdates`、空 fallback 时大声失败，禁止打开空白会话。

上游 typed-item 重构后这整套兜底已删除：`loadSession` 直接按 `historyMode` 分支——paginated 走 `thread/turns/list` + `thread/items/list`（游标来自 resume 的 `itemsBackwardsCursor`），legacy 走一次 `threadReadWithHistory`（`src/CodexAcpClient.ts`）；JSONL fallback、`skippedPaginatedThreadRead`、`isPaginatedThreadReadError` 与对应的三个 load-session 用例一并删除。回放仍读 rollout JSONL，但**只为 `request_user_input` 提问卡片**（见上文，`RequestUserInputReplay.ts`），其它历史一律来自 typed items。

## 历史回放字节预算

（`src/ReplayBudget.ts`；接线在 `src/CodexAcpServer.ts` `streamThreadHistory` → `streamCappedHistoryUpdate` / `streamHistoryItem`）

回放把整条 thread 物化成 `session/update` 逐条下发，**无累计预算、无单条截断**——长构建型会话（数百次 commandExecution 各带完整输出 + fileChange 的 diff 是整文件内容）每次 resume 都重发整个语料库，实测把编辑器 renderer 打到 4.4GB OOM（main 侧 heap 同步涨到 1GB，因为它要 JSON 编码 + 结构化克隆每一个字节，renderer 自己的 256MB ingestion 预算救不了）。claude fork 早有等价上限（`acp-agent.ts` 的 `MAIN_REPLAY_MESSAGE_CAP_BYTES`/`MAIN_REPLAY_TOTAL_CAP_BYTES`），本组改动是 codex 侧对齐：

- `ReplayBudget.ts`：`capReplayUpdate(update, maxFieldBytes=1MB)` **递归遍历 update 的所有字符串字段**做截断（**刻意不按 item 类型 switch**——任何 thread item 类型新加重字段当天即被覆盖，不会静默绕过），返回截断后字节数供累计记账；`REPLAY_TOTAL_CAP_BYTES=96MB`。`streamCappedHistoryUpdate` 逐条 `capReplayUpdate` + 累计，超限时 logger 记录并发一条 `agent_message_chunk` 说明后令 `streamHistoryItem` 返回 false，两条回放路径（legacy 循环与 `streamNativeThreadHistory` 的嵌套子会话）都据此提前 return（**从头发、超限停 = 丢较新的尾部**，与 claude fork 同向；不 fail 整个 resume，会话仍带较早历史打开）。预算对象 `ReplayBudgetState` 由 `streamThreadHistory` 创建，嵌套子会话共用同一份。
- 配套测试 `src/__tests__/ReplayBudget.test.ts`（5 例：小 update 保持引用同一性 / 命令输出在 text block 与 rawOutput **两份**都被截断 / diff 双侧截断 / 巨型 payload 记账受 cap 约束 / 循环引用不爆栈）。
- **ReplayFileRead.ts（保留）**：`readFileWithinCap`（stat 先判再读，`REPLAY_ROLLOUT_READ_CAP_BYTES=64MB`）现只守提问卡片那一次 rollout 读取——超限文件绝不物化，只丢卡片。旧 fork 守的两个磁盘读（回放重建 diff 读文件全文、rollout fallback 读整份 JSONL）里，前者已随 typed-item 重构消失（diff 由 codex 的 `FileUpdateChange.diff` 重建，上游 `FileChangeReporter` 自带 `fitsDiffLimit` 尺寸闸）；配套测试 `src/__tests__/ReplayFileRead.test.ts`。

## 非原生子 Agent 回放

（`src/CodexAcpServer.ts` `streamThreadHistory` 的 legacy else 分支 + 新增私有 `streamLegacyChildHistory`；取数 `src/CodexAcpClient.ts` `readSessionTurnItems`）

**问题**：能力位 `subagent-transcript` 的客户端（编辑器）resume 时，子 agent 的工具卡与文本必须回到它父卡里，否则「live 有、resume 丢」。原生子会话 client 走 `streamNativeThreadHistory`（`subagent_spawned` + 独立 sessionId），非原生 client 原来只扁平回放 `subAgentActivity` 卡。

**做法**：legacy else 分支的叶子循环遇到 `item.type === "subAgentActivity" && item.kind === "started" && !isRootAgentPath(item.agentPath)` 时，先把父卡 `streamHistoryItem` 出去，再 `await this.streamLegacyChildHistory(...)` 回放该子线程**本次世代**的工作。世代计数按 `agentThreadId` 累加（`generations` map），取数与原生路径**同一个** `readSessionTurnItems(agentThreadId, generation - 1)`——`started` 次数 = 世代 = turn 序号（子线程的每一代是它的一个 turn，实测与 `native-subagent-session` / `load-session` fixture 一致），不新增 RPC 封装；只有**直接子线程**被读，孙线程天然不可达（一层深度与 live 一致）。

- 每条 update 盖 `_meta.codex.parentToolCallId = <父卡 item id>`（与 live 同一处 `stampChildParentToolCallId`），并落**根 sessionId**；item 过滤复用 `isChildTranscriptItem`（与 live 同一份白名单）。
- **协作 spawn 的子线程按全轮回放**：同一个循环遇到 `collabAgentToolCall && tool === "spawnAgent"` 时，对每个 `receiverThreadIds` 调 `streamLegacyCollaborationHistory`——从 turn 0 起逐轮 `readSessionTurnItems` 直到返回 null。**为什么是全轮**：协作线程比 spawn 活得久，`sendInput` 会给它追加 turn，那些工作同样属于这张卡（真机委派路径就是协作工具，见 cases-session.md 的同名一节）。`streamLegacyChildHistory`（世代语义）与它共用 `readChildTurnItems`（try/catch + 日志，失败/轮数用尽都返回 null）与 `streamChildTurn`（白名单 + 盖父 id + 计量），单轮行为不变。
- **两条路径不重复回放同一线程**：`replayedChildren` 集合同时挡住「同名线程的第二个 spawn 项」与「spawn 之后的 activity 项」；反向顺序（activity 先、spawn 后）则用 `generations` 做**前缀接续**——spawn 从 `generations.get(thread) ?? 0` 起回放，即跳过 activity 已回放的那几个 turn。效果是「同一子线程的每个 turn 恰好回放一次」，父卡按先到者分配。三个跳过条件：空 id、`childThreadId === sessionId`（防 `receiverThreadIds` 报根线程，live 的 `discover` 也有同一守卫）、已回放过。
- **逐轮读取是 O(K²)**（每个 index 都重做一次 `threadRead` 元数据 + 从第 0 页重扫 `threadTurnPages`）：接受的成本，协作线程通常只有个位数 turn，且长尾会被同一份 `budget` 提前结束；真要优化先取一次 turn 列表再逐轮读，但那要新增 client 方法，与「fork diff 最小」冲突。
- **复用 `streamThreadHistory` 已建的同一个 `budget`**（`ReplayBudgetState`）：单字段 1MB / 全局 96MB 与根历史共用一份，超限时 `streamCappedHistoryUpdate` 自己发提示并返回 false → 子 walker 返回 false → 根 walker `return`（丢较新的尾部，不 fail resume）。
- **必须 await，禁 fire-and-forget**：它在 `session/load` 的 `beginHistoryReplay()/endHistoryReplay()` 窗口内（claude fork 曾有子 agent 回放撑爆 renderer 5.5GB 的前例）。
- **失败只丢该子线程**：`readSessionTurnItems` 与分页读取都 `try/catch`（`SessionClosedDuringLoadError` 除外，它必须继续抛），记 `Failed to read subagent history` 日志后返回 true，会话照常打开、根历史继续回放。
- 回放的子文本来自子 turn 的 `agentMessage` **item**（「非原生（编辑器）子 Agent 留痕」一节的 live 侧则靠 `item/agentMessage/delta`）——这是 `TRANSCRIPT_ITEM_TYPES` 收录 `agentMessage` 的唯一原因，根线程渲染器对两种事件都返回 null，故 live 不重复。

**v1 已知缺口**：子线程自己的 `request_user_input` 卡片不回放（`RequestUserInputReplay` 只覆盖根 rollout）；子线程 interrupted 尾迹不补；子线程的权限卡与后台终端（`asyncTasks.recover`）不恢复——原生路径有，非原生路径没有。

**配套测试**：`src/__tests__/CodexACPAgent/load-session.test.ts`「replays the work of a sub-agent under its activity card without native subagent sessions」（两代各自的父卡 id、顺序在父卡之后、terminal activity 不重复回放、全部落根 sessionId、根消息不带父 id）与「keeps a session loadable when the history of a sub-agent cannot be read」（读失败只丢该子线程的痕迹，根历史照常）、「replays the work of a collaboration spawn under its card without native subagent sessions」（spawn 卡带 `codex.subagent`、子线程两个 turn 都归该卡且顺序在卡后、第二个 spawn 项 / `wait` 控制项 / 同名 activity 都不重复回放、根消息不带父 id）、「continues the collaboration trail after the turns an activity already replayed」（activity 先到时的前缀接续：第 1 个 turn 归 activity 卡、第 2 个归 spawn 卡，且不重复）。
