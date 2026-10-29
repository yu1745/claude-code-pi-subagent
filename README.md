# pi-subagent

Claude Code 的一个 mod：**让原生子代理用 [pi](https://pi.dev) 跑第三方模型**（DeepSeek、GLM、Qwen、MiniMax、Gemini、GPT…），主代理（Claude）当监督者。

子代理仍是 Claude Code 自己的原生子代理：出现在 ↓ 任务列表里、原生完成通知、原生 worktree 隔离、TaskStop、SendMessage 续接都照常可用。mod 只做一件事——拦下这个子代理的模型请求，不发给 Claude，而是交给一个 `pi --mode rpc` 进程去跑，再把 pi 的最终答案作为"模型回复"交回引擎。

- **模型范围**：子代理只能用你在 pi 里配置的 scoped models（`enabledModels`，即 `/scoped-models`），清单连同上下文长度、思考、图片能力一起写进 Agent 工具描述，主代理据此挑模型；清单外的模型直接拒绝。不指定时用 pi 的 `defaultModel`。
- **`@default`**：`subagent_type: "general-purpose@default"` 明确表示“用 pi 当前的默认模型”（每次启动时重新读 pi 的 `defaultModel`，不是会话开始时的快照），可再接思考强度 `@default:high`。Agent 工具描述里告诉主代理：用户没点名模型时就用 `@default`，不必每次手动交代模型。
- **运行中纠偏**：子代理运行时 `SendMessage` 给它，会变成 pi 的 RPC `steer`，在它当前这批工具调用结束后读到。
- **续接**：子代理结束后 `SendMessage` 走原生续接，接着同一个 pi 会话（mod 重载、会话重开后也能续）。
- **停止**：原生 `TaskStop` 会连同 pi 的整个进程树一起停掉。
- **监督**（第三方模型可能不稳定）：
  - `mcp__pi-subagent__subagent_activity`：读子代理最近的公开活动（文字、工具调用与结果、模型报错和重试），支持游标翻页和单条详情。
  - `mcp__pi-subagent__watch_subagent`：每隔 N 秒把子代理新增的活动推给主代理；主代理正忙时攒到这一轮结束再一次送达（不插进进行中的一轮，那样会改写历史前缀、让下一轮的 prompt cache 整体重建），空闲时直接唤醒它。
- **worktree 隔离**（`isolation: "worktree"`）：引擎默认从 `origin/main` 建 worktree，而不是主会话当前分支。mod 在 pi 第一次启动前，若 worktree 干净，就把它 `reset --hard` 到主会话当前的 HEAD 提交（主会话的仓库在 Agent 调用时记下；主仓里未提交的改动不会带进去）；做不到时（有改动、reset 失败）如实告诉 pi。续接时不再 reset。pi 会被告知 worktree 路径和“别碰主仓、改完在该分支上提交”，答案末尾带 `[worktree · 路径 · branch 分支]`。找不到该 worktree（例如引擎已把无改动的 worktree 清掉）时拒绝运行，**不会回落到别的目录**，答案里说明原因（续接时建议另起一个子代理）。Claude 自己跑的子代理仍用引擎原生的 worktree（基于 origin/main）。
- **长命令不会被判卡死**：pi 跑一条编译/测试可能几分钟没有任何输出，而引擎对 600 秒没有进展的子代理会判卡死。启动 pi 的包装脚本每 20 秒往 stderr 打一行心跳，pi 有工具在跑时，mod 把它转成一个空的 `thinking` 块交给引擎（只显示、不记录）。pi 没有工具在跑却一直不出声（模型挂住）时不发心跳，照旧 600 秒后被判卡死。
- **只读类型**：`Explore`、`Plan`、`claude-code-guide` 只给 pi `read,grep,find,ls` 四个工具，改不了文件。
- **pi 过程可见**：从 ↓ 打开一个 pi 子代理时，提示框上方的区域实时显示它的模型、状态和最近几步（文字、工具调用与结果、报错和重试），正常颜色；切回主对话就收起。每一步也写进子代理自己的对话记录（模型不读），ctrl+o 能看到完整记录（引擎画成暗色）。
- **真实用量**：答案末尾附一行 pi 报告的真实 token 用量（原生通知里的 token 数由引擎自己估算，不准）。

## 用法

`model` 参数是 Claude Code 固定的枚举（只能填 Claude 模型），所以第三方模型写在 `subagent_type` 的 `@` 后缀里：

| 想要 | 写法 |
|---|---|
| pi 的默认模型 | `subagent_type: "general-purpose@default"`（或省略 `@`） |
| 指定模型 | `subagent_type: "Explore@codebuddy/deepseek-v4.1-flash"` |
| 指定思考强度 | `subagent_type: "general-purpose@minimax-cn/MiniMax-M3.1-Flash-Preview:high"`，或加 `effort: "high"` |
| 改用 Claude | 填 `model: "haiku"`（或 sonnet / opus / fable），或 `subagent_type: "general-purpose@claude"` |

模型名可省略价格倍率后缀、不区分大小写，唯一时可只写模型名。`fork` 和 `isolation: "remote"` 始终由 Claude 跑。

平时不用手写：主代理会从工具描述里的清单挑模型，你只要说"这个用 codebuddy 的 deepseek"。

## 要求

| 依赖 | 说明 |
|---|---|
| Claude Code | 需支持 Claude Mods（function hooks）；在 2.1.302 上开发和验证 |
| pi | 在 PATH 里；按 pi 1.2.x 的 RPC 命令和 JSON 事件格式编写，其他版本启动时会提示 |
| pi 的 scoped models | `~/.pi/agent/settings.json`（或项目的 `.pi/settings.json`）里的 `enabledModels`；为空时不限制模型 |

子代理会话存放在 `~/.pi/claude-subagents/`。

## 安装

在 Claude Code 的终端会话里输入：

```
/plugin install pi-subagent --marketplace yu1745/claude-code-pi-subagent
```

提示 `Add marketplace?` 时输入 `y`，再选择安装范围（user 即对所有会话生效）。

在 shell 里：

```bash
claude plugin install pi-subagent --marketplace yu1745/claude-code-pi-subagent
```

桌面应用里：点输入框旁的 +，选 Plugins → Add marketplace，填 `yu1745/claude-code-pi-subagent`，再 Add plugin。

### 本地开发 / 试用

```bash
git clone https://github.com/yu1745/claude-code-pi-subagent.git
claude --plugin-dir ./claude-code-pi-subagent
claude plugin test ./claude-code-pi-subagent    # 单元测试 + 引擎级集成测试
```

## 已知限制

- 原生完成通知里的 `subagent_tokens` 由引擎自己计算，不反映 pi 的真实用量；真实用量看答案末尾那一行或 `subagent_activity`。
- 主代理空闲时，watch 通知需要以插件提示的形式单独开一轮来唤醒它（在对话记录里折叠成一行，ctrl+o 展开）。
- `fork`（要继承 Claude 的上下文）和 `remote`（云端运行）无法用 pi。

## 许可

MIT
