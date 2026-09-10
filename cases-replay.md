# cases-replay.md — 恢复/回放/取消表现改动的完整叙事

对应 `CLAUDE.md`「fork 已有的本地改动」中带「详见本文档」的回放类条目，保留完整 bug 叙事与设计约束，供 rebase 冲突时参考。

## 取消/中断表现

（`src/CodexAcpServer.ts`）

`cancelledPromptResponse` **不再**推送 `*Conversation interrupted*` agent chunk（早先为配合编辑器旧 `[cancelled]` 哨兵而保留，上游 #358 已删）——编辑器现在自己渲染取消：零输出取消=撤回+恢复草稿，部分输出取消=本地补 `[Request interrupted by user]` 标记，fork 再推只会孤儿化/重复。对应地，`streamThreadHistory` 对 `thread/resume` 重建出的 `status === "interrupted"` 的 turn 在其 items 末尾补一条无 messageId 的 `user_message_chunk`（文本 `[Request interrupted by user]`）——rollout 把中断落成 `<turn_aborted>` 合成 user response_item，thread/resume 不重建它；被中断 turn 的**部分输出本身不在 rollout 里，resume 无法恢复**，只能恢复中断痕迹。编辑器 resume 过滤按文本匹配该标记（零输出撤回场景跳过它）。

已知：上述 3 个用真实 codex 二进制 / spy 实际值的测试在 **Windows 本机**会因 `path.join` 反斜杠失败（codex rust 端 `AbsolutePathBuf` 拒收无盘符反斜杠路径；spy 实际值带反斜杠），**Linux CI 通过**。生产环境 Windows cwd 总带盘符，`path.join` 产出合法绝对路径，不受影响。

## 恢复时图片重放顺序

（`src/CodexAcpServer.ts` `createUserMessageUpdates` / `userInputToContentBlocks`）

live prompt 的 wire 顺序是图片在前文本在后（`buildPromptItems` 保序），但 `thread/resume` 重建的 `userMessage.content` 把 text input 排在 image input 前——verbatim 重放会让恢复出的消息把图片渲染在用户文本之后。修复：`createUserMessageUpdates` 用稳定排序把 image/localImage 输入的 chunk 提到 text 之前（`userInputReplayOrder`）；`userInputToContentBlocks` 的 `image` case 对 `data:` URL（`buildPromptItems` 给粘贴图存的形态）经 `parseImageDataUrl` 还原为真正的 ACP `image` block（`{type:'image', data, mimeType}`），使恢复后的图片走与 live 一致的 ImageRow 渲染而非文本内联链接；http(s) URL 与 localImage 仍降级为文本链接。配套测试 `load-session.test.ts`「replays image inputs ahead of text」；`data/load-session-history.json` 快照中 user chunk 顺序随之变为 image 链接在前。

## 历史回放 `request_user_input` 提问卡片（已废弃）

旧 fork 在 `ResponseItemHistoryFallback.ts` 里对 `function_call`（name=`request_user_input`）特判，从 rollout JSONL 重建提问卡片。上游 typed-item 历史重构后该模块整个删除，回放只读 `thread/turns/list` + `thread/items/list` 的 typed items——其中既无 request 的 questions 也无答案（`functionCallOutput` 项连上游都直接跳过），**恢复会话不再显示历史提问卡片**，该能力无法保留。

## live `request_user_input` 留痕 + 答案折叠

（`src/CodexElicitationHandler.ts`）

- **live 留痕**：app-server 从不把 request_user_input 暴露为 thread item，elicitation 卡片一 settle 提问就从客户端 timeline 消失。`handleUserInput` 在回答（含 decline/cancel/自动超时，均记 `（跳过）`）后调 `publishUserInputCard` 补发 `tool_call`+`tool_call_update` 对，把问题、选项与答案留在会话时间线里；渲染函数（`createUserInputToolCallEvent` / `createUserInputAnswerUpdate` / `UserInputQuestion`）原在 `ResponseItemHistoryFallback.ts`，该模块随上游 typed-item 重构删除后移入 `RequestUserInputHistory.ts`；sessionId 取 `params.threadId`（子 agent 路由会把它改写成 ACP session id）。客户端不支持 form elicitation 时不发（从未提问）。配套测试 `elicitation-events.test.ts`「publishes a question card to the session timeline…」。
- **答案折叠已上游化**：旧 fork 把 isOther 问题里用户既选选项又填备注的答案折叠成 `<选项>（补充：<备注>）` 单条 answer（`mergeUserInputAnswer`）。上游 #570/#577 采用自己的 AIR 约定（`None of the above` + `user_note: <文本>` 两条 answer），fork 的折叠实现已删除、跟随上游。

## 历史回放字节预算

（`src/ReplayBudget.ts`；接线在 `src/CodexAcpServer.ts` `streamThreadHistory` → `streamCappedHistoryUpdate` / `streamHistoryItem`）

回放把整条 thread 物化成 `session/update` 逐条下发，**无累计预算、无单条截断**——长构建型会话（数百次 commandExecution 各带完整输出 + fileChange 的 diff 是整文件内容）每次 resume 都重发整个语料库，实测把编辑器 renderer 打到 4.4GB OOM（main 侧 heap 同步涨到 1GB，因为它要 JSON 编码 + 结构化克隆每一个字节，renderer 自己的 256MB ingestion 预算救不了）。claude fork 早有等价上限（`acp-agent.ts` 的 `MAIN_REPLAY_MESSAGE_CAP_BYTES`/`MAIN_REPLAY_TOTAL_CAP_BYTES`），本组改动是 codex 侧对齐：

- `ReplayBudget.ts`：`capReplayUpdate(update, maxFieldBytes=1MB)` **递归遍历 update 的所有字符串字段**做截断（**刻意不按 item 类型 switch**——任何 thread item 类型新加重字段当天即被覆盖，不会静默绕过），返回截断后字节数供累计记账；`REPLAY_TOTAL_CAP_BYTES=96MB`。`streamCappedHistoryUpdate` 逐条 `capReplayUpdate` + 累计，超限时 logger 记录并发一条 `agent_message_chunk` 说明后令 `streamHistoryItem` 返回 false，两条回放路径（legacy 循环与 `streamNativeThreadHistory` 的嵌套子会话）都据此提前 return（**从头发、超限停 = 丢较新的尾部**，与 claude fork 同向；不 fail 整个 resume，会话仍带较早历史打开）。预算对象 `ReplayBudgetState` 由 `streamThreadHistory` 创建，嵌套子会话共用同一份。
- 配套测试 `src/__tests__/ReplayBudget.test.ts`（5 例：小 update 保持引用同一性 / 命令输出在 text block 与 rawOutput **两份**都被截断 / diff 双侧截断 / 巨型 payload 记账受 cap 约束 / 循环引用不爆栈）。
- **上游已吸收的部分**：旧 fork 另有 `ReplayFileRead.ts`（`readFileWithinCap` stat 先判再读）守两个磁盘读——回放重建 diff 时读文件全文、rollout fallback 读整份 JSONL。typed-item 重构后回放不再读磁盘（diff 由 codex 的 `FileUpdateChange.diff` 重建，上游 `FileChangeReporter` 自带 `fitsDiffLimit` 尺寸闸），该模块与其测试一并删除；旧 `file-change-events.test.ts` 的 fs 桩踩坑随之失效。
