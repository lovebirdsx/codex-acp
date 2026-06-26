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
- session 费用计算相关改动（`src/CodexAcpServer.ts`、`src/CodexEventHandler.ts`）：上报 per-model USD 用量到 `_meta`，供父项目算人民币开销。

rebase/merge 上游后，逐一核对这些改动是否仍在、是否需随上游 API 调整。

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
