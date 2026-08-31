# Agent Hub MCP Architecture

## 目标

Agent Hub 是一个本地 agent CLI bridge。主入口是短生命周期 `agenthub` CLI；可选 MCP
server 复用同一核心 API。两种入口都把请求映射成本机 agent CLI 的一次非交互执行，
并用本机文件保存 run 状态、日志和结果。

核心目标：

- CLI/MCP 入口保持薄封装，只负责 CLI 启动、状态记录、查询、等待和取消。
- 普通 run 的用户输入原样传给目标 CLI；Discussion turn 使用独立的版本化 coordinator prompt。
- 每次执行都有独立 run 目录，状态和结果保存在本机专用目录。
- run 终态后默认保留 7 天。
- 多轮对话复用 CLI 自身的 session/resume 能力。
- 提供 blocking wait tool，让调用方一次等待 run 结束。

### 无 daemon 执行模型

`agenthub dispatch` 在调用者现场启动 detached runner；runner 从现场继承非密策略、Keychain
上下文与**整体的会话轴状态**（`NS` / `NS_UNDO` / `PATH`），置 `NS_REBIND=1`，再以
`/bin/zsh -c 'exec …'` 把 agent CLI 起在 run 的 cwd——`~/.zshenv` 的 glue 先卸掉继承的
域再按 cwd 绑定（charter 汇聚段），hub 对域一无所知。dispatch 进程随后退出；runner、run store 和跨进程锁保证后续 `query`、`wait`、`cancel`
命令可以由全新的 CLI 进程继续。容器根（Claude/Codex/Kimi/OpenCode）为机器级单根。

Discussion 使用同样原则，但其五阶段 coordinator 需要持续推进。因此
`agenthub discussion dispatch` 启动一个 detached Discussion worker；query/wait/cancel
会为非终态记录按需触发恢复，Discussion lease 保证只有一个 worker 真正取得控制权。
streamable HTTP daemon 仍可作为可选 coordinator，但不再是 Discussion 的唯一入口。

## 架构原则

### 原生透传

Agent Hub 接收调用方传入的 `prompt`、`cwd`、`agent_id`、`cli_session_ref` 和
adapter metadata。Adapter 只把这些字段映射成目标 CLI 的 argv、stdin 和环境。

普通 run 的 Prompt 处理规则：

- `prompt` 字符串按调用方提供的内容传给 CLI。
- Agent Hub 不在 prompt 前后拼接任何文本。
- Agent Hub 不通过 prompt 要求目标 agent 写 result file。
- Agent Hub 将 prompt 原文写入 `input.txt`，runner 再把 `input.txt` 内容通过 stdin
  传给 CLI。例外：kimi `-p` 只接受 argv prompt（不读 stdin），kimi adapter 从
  `request.json` 的 `prompt` 字段拼 argv，`input.txt` 仍照常保存。OpenCode 必须只读
  stdin；它会合并 argv prompt 与 stdin，同时传两份会造成重复和引号变形。

CLI 参数处理规则：

- MCP 为非交互执行设置必要参数，例如 Claude Code 的 `-p` 和 `--output-format stream-json`。
- 其他 CLI 行为参数来自 adapter metadata 或 CLI 默认配置。
- `command.json` 记录 adapter 视角的 `argv` 与实际 spawn 的 `launcher`（`/bin/zsh -c 'exec "$0" "$@"' …`，agent 经 zsh 出生），便于复现。

### 统一 metadata 层

`metadata` 顶层提供一组跨 adapter 的统一字段，adapter 负责翻译成各自 CLI 的原生参数；
`metadata.claude.*` / `metadata.codex.*` / `metadata["kimi-code"].*` / `metadata.opencode.*` 命名空间是原生逃生通道，
同名语义字段以命名空间为准：

| 统一字段 | 含义 | claude-code 映射 | codex 映射 | kimi-code 映射 | opencode 映射 |
|---|---|---|---|---|---|
| `model` | 模型名（按目标 CLI 的命名） | `--model` | `--model` | `-m` | `--model` |
| `permission` | `read-only` / `auto`（默认）/ `full` | `plan` / `auto` / `bypassPermissions` | `read-only` / `workspace-write`+联网 / `danger-full-access` | 仅接受 `auto`（内建 auto 审批） | 仅接受 `auto`，映射到 `--auto` |
| `add_dirs` | 额外可写目录（经 `security.js` 校验） | `--add-dir` | `--add-dir` | `--add-dir` | 非空即拒绝（无原生边界） |

effort 不在统一层：各 CLI 的取值集合不同且随版本演进，Agent Hub 不枚举合法值，
一律原样透传，由目标 CLI 自行接受或报错（报错按正常失败路径透传）。它只出现在
adapter 命名空间（`metadata.claude.effort` / `metadata.codex.effort` /
`metadata["kimi-code"].effort` / `metadata.opencode.effort`），未提供时回退对应的
`AGENT_HUB_*_EFFORT` 环境变量。
codex 侧仅有 `[A-Za-z0-9_-]+` 字符集校验——这是 `-c` TOML 值的注入防护，不是取值假设；
kimi 侧走子进程环境变量 `KIMI_MODEL_THINKING_EFFORT`，无注入面，不做校验。

错误码同样统一：模型侧失败（Claude `is_error`、Codex `turn.failed`、kimi stderr 的
`failed to run prompt`、OpenCode JSON `error` event）一律记为 `agent_error`；`cli_exit_nonzero`、
`stdout_parse_failed` 等 hub 层错误码本就与 adapter 无关。原生细节保留在
`error.message` 与 `result.txt`。

### Run 归 Agent Hub

Run 是 Agent Hub 管理的一次 CLI 执行。每次 `dispatch_to_agent` 都创建一个新的
run。

Run 负责：

- 当前状态。
- 本机进程信息。
- stdout、stderr、result 和 metadata 文件。
- 查询、等待和取消。
- 终态后的 TTL 清理。

Run 由 `run_ref` 标识：

```json
{
  "run_id": "01J..."
}
```

### Session 归 CLI

CLI session 是目标 agent CLI 自己的对话上下文。

Session 负责：

- 多轮追问的上下文延续。
- transcript、上下文压缩和模型侧会话状态。

Agent Hub 保存 opaque `cli_session_ref`，并在 continuation 时传回目标 CLI。

```json
{
  "agent_id": "claude-code",
  "native_session_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

新 run 和 CLI session 是两个独立 ID。一次追问会创建新的 `run_id`，同时复用已有
`native_session_id`。

Session ID 的产生方式由 adapter 决定：

- Claude Code：Agent Hub 生成 UUID 并通过 `--session-id` 传入，dispatch 响应立即返回
  `cli_session_ref`。
- Codex：thread id 由 Codex 自己分配并通过第一条 `thread.started` 事件上报。新会话的
  dispatch 响应 `cli_session_ref` 为 `null`；runner 观察到 `thread.started` 后写回
  `state.json`，终态快照携带可用于 continuation 的 `cli_session_ref`。
- Kimi Code：session id 由 kimi 自己分配，通过 stdout 事件流末尾的
  `session.resume_hint` meta 事件上报。新会话的 dispatch 响应 `cli_session_ref` 为
  `null`；终态快照携带可用于 continuation 的 `cli_session_ref`。与 Codex 不同，kimi
  只在结束时上报，因此取消的 run 没有可 resume 的 session ref。
- OpenCode：session id 由 OpenCode 自己分配，并出现在每条 JSON 事件的 `sessionID`。
  dispatch 响应先返回 `null`；runner 从首事件写回，因此取消的 run 也可保留 ref。

## CLI Commands 与 MCP Tools

### list_agents

返回当前可用的 CLI adapter。

Adapter 出现在列表中的条件：

- CLI binary 可执行。
- direct non-interactive 命令可用。
- Adapter 能把一次 CLI 退出转换为明确的 `completed` 或 `failed`。

`list_agents` 还会 best-effort 探测每个可用 adapter 的可选模型，并返回统一的
`models` 数组与 `model_discovery` 状态。调用方可传可选的绝对路径 `cwd`；它只是探测模型目录时的工作目录（缓存键为
`cwd` + 配置根 / base URL），不选择任何 namespace。未传时使用 MCP server 的当前目录。

- Claude Code：以 stream-json 启动无持久化、无工具会话，发送 SDK control
  `list_models` 请求；这与交互式 `/model` picker 使用同一份账号、provider 和策略目录。
- Codex：读取 `codex debug models`，只保留 `visibility: "list"` 的条目；原始目录中的
  instructions 等内部字段不会进入 MCP 响应或持久化 artifact。
- Kimi Code：读取 `kimi provider list --json`，只保留 `models` 下的安全模型字段；
  `providers` 中的 API key、base URL 等配置不会进入响应。
- OpenCode：读取 `opencode models` 的 `provider/model` 行；凭证存储不会进入 stdout、
  响应或持久化 artifact。

探测并行执行，按 `cwd` + 配置根 / base URL 缓存 30 秒，单个命令通常限时 5 秒（OpenCode 10 秒）、输出限
8 MiB。模型探测失败只会得到空 `models` 和 `model_discovery.status: "unavailable"`，
不会改变 adapter 自身的 `available` 状态。

### review routing

PR review 是 CLI-only 的窄控制面，不扩张普通 dispatch 或 MCP schema：

- `review status` 把内建默认值、用户覆盖和 Agent 模型目录投影成一份状态。目录按
  `cwd` 与非 secret 配置身份写入跨进程私有缓存：5 分钟内直接读取；5 分钟至 24 小时
  立即返回旧值并启动 detached 单飞刷新；无缓存或超过 24 小时时才同步发现。刷新失败
  保留上一份目录并退避 60 秒，状态通过顶层 `catalog_cache` 显式报告；
- `review set` 只接受三个已知 requester、不同于 requester 的在线 reviewer，以及 reviewer
  当前 live 目录内的精确 model ID；写回采用进程锁和原子 rename，并用现场目录回填缓存；
- `review dispatch` 在每次派发前重新读取并用 live 目录校验有效路由，再把 model 作为统一
  metadata 调 `dispatch_to_agent`，响应仍是普通 run ref；现场目录同时回填缓存。

内建默认值保持原有交叉审习惯：Codex → Claude Code `default`；Claude Code、Kimi Code →
Codex `gpt-5.6-sol`。OpenCode 可作为 reviewer，但在机器级指令发现链接入前不作为
requester。文件只存与默认值不同的覆盖，位于
`${XDG_CONFIG_HOME:-~/.config}/agent-hub-mcp/review-routing.json`（可由
`AGENT_HUB_REVIEW_CONFIG` 覆盖）；它是用户偏好状态，不是 run artifact。配置损坏、reviewer
下线或 model 从目录消失均 fail loud，不自动回退，也不允许 self-review。Cockpit 只能经
`review status/set` 消费这份单写者状态。

目录缓存默认位于 `${XDG_CACHE_HOME:-~/.cache}/agent-hub-mcp/agent-catalog/`，可由
`AGENT_HUB_CATALOG_CACHE_DIR` 覆盖。cache key 是 `cwd` 与已知非 secret 配置身份的 SHA-256；
文件只保存已经对外返回的规范化 catalog、观测时间和有界刷新错误，不保存 key 原文、环境值、
credential 或 provider 原始响应。目录为 `0700`、文件为 `0600`，更新使用原子 rename。
缓存只改变 status 的等待语义；set/dispatch 的 live 校验继续承担正确性边界。

### repository eval

Eval 是 CLI-only 的前台监督控制面，不进入普通 MCP run schema，也不改变普通 run 的
prompt 原样透传约束。`agenthub eval run` 从评测者选择的 suite 读取问题；suite 可位于被测
worktree 外且无需提交，supervisor 启动时一次性规范化并固定 digest。被测 worktree 自身仍须
干净并由一个不可变 commit 定义。Eval 在 TTY 中先收齐当前 commit 的人工标准答案，然后为
每个 case 创建一个普通 Agent Hub run。supervisor 只把“当前问题 + 固定结构化输出契约”交给
run，不向 child 暴露 suite 路径；标准答案只留在 supervisor 内存，完成后只保留 digest。
model 与 effort 必须由调用者显式指定，不读取 catalog 推荐值或环境默认值。

每个 case 的普通 run 带内部 `execution_profile=workspace-readonly/v1`。该字段不在普通 CLI
或 MCP 输入暴露，只由 Eval supervisor 构造；runner 把它交给 Codex adapter，后者使用
Codex permission profile，而不是旧 `--sandbox`：`:minimal` 提供运行时只读面，
`:workspace_roots` 只读开放当前 worktree，`.git` 显式 deny，独立 scratch 显式 write，
command network 关闭。同时使用 ephemeral session、忽略用户 config/rules、关闭 memory 与
subagent。profile 路径在普通 run 建立前 realpath 校验，scratch 必须与 cwd 分离且 output
schema 必须位于 scratch 内。

suite schema v1 只接受 `source-location/v1` 并做
`path + symbol + definition_line` 精确匹配。schema v2 的 `workspace-patch/v1` 为每个 case
从 subject commit 创建 disposable detached worktree，使用同一套 fail-closed profile 但仅把
该副本改为可写；worktree add 显式覆盖到私有空 `core.hooksPath`，不触发仓库 checkout hook；
人工提供的外置 self-contained executable verifier 在 agent 退出后才由前台 supervisor
复制到 Eval 私有状态根下、从未授予 agent 的新目录并执行，原路径、正文与输出均不进入
agent run；输出只 drain 不持久化，也不以大小影响评分。patch eval 另把前台探测到的 system Python
runtime root 只读开放给 agent，使仓库测试不必扩大到用户目录；patch 正文不进入 eval result，
普通 run 仍按既有 TTL 保留 provider-native tool transcript。Agent Hub 持有一次 eval 的执行与
判分事实，不做跨 commit 比较；完整契约见 [evals.md](evals.md)。

### dispatch_to_agent

启动一次 run 并立即返回。

请求：

```json
{
  "agent_id": "claude-code",
  "prompt": "Review the current diff.",
  "cwd": "/Users/example/project",
  "cli_session_ref": null,
  "metadata": {
    "claude": {
      "model": "sonnet",
      "effort": "medium"
    }
  }
}
```

响应：

```json
{
  "status": "accepted",
  "run_ref": {
    "run_id": "01J..."
  },
  "cli_session_ref": {
    "agent_id": "claude-code",
    "native_session_id": "550e8400-e29b-41d4-a716-446655440000"
  },
  "poll_after_ms": 1000
}
```

### query_agent_run

读取一次 run 状态并返回当前快照。

终态响应：

```json
{
  "status": "completed",
  "content": [
    {
      "type": "text",
      "text": "Final answer from the CLI."
    }
  ],
  "run_ref": {
    "run_id": "01J..."
  },
  "cli_session_ref": {
    "agent_id": "claude-code",
    "native_session_id": "550e8400-e29b-41d4-a716-446655440000"
  },
  "artifacts": [
    {
      "type": "log",
      "title": "stderr",
      "path": "stderr.log"
    }
  ]
}
```

运行中响应：

```json
{
  "status": "running",
  "run_ref": {
    "run_id": "01J..."
  },
  "log_tail": {
    "type": "text",
    "text": "recent stderr/stdout tail"
  },
  "poll_after_ms": 1000
}
```

### wait_agent_run

阻塞等待 run 进入终态，然后返回和 `query_agent_run` 相同的结果结构。

请求：

```json
{
  "run_ref": {
    "run_id": "01J..."
  }
}
```

规则：

- MCP tool 输入只暴露 `run_ref`。
- server 默认等待窗口为 600000 ms。
- 默认内部轮询间隔为 1000 ms。
- 内部 `waitAgentRun` 保留 `timeout_ms` / `poll_interval_ms` override，供 `run_agent` 和测试复用。
- 终态包括 `completed`、`failed`、`cancelled`、`unknown`。
- 超时仍在运行时返回 `status: "running"` 和 `timed_out: true`，调用方应继续轮询，
  不应仅因为一次等待超时而取消 run。

### cancel_agent_run

取消 Agent Hub 创建的本地 run。

规则：

- 读取 `state.json` 中的 `pgid`。
- 对进程组发送 SIGTERM。
- grace period 为 10 秒。
- 进程组仍存在时发送 SIGKILL。
- 状态写为 `cancelled`。

### run_agent

短任务便捷工具，等价于 `dispatch_to_agent` 后立刻 `wait_agent_run`。

默认等待 30 秒。超时时返回 running 快照，调用方可以继续调用 `wait_agent_run`。
长任务应直接使用 `dispatch_to_agent` 后调用 `wait_agent_run`。如果 MCP client 的
tool timeout 先到期，后台 run 仍然继续，调用方应保留 `run_ref` 后续查询或等待。

## Run 生命周期

状态机：

```text
queued -> starting -> running -> completed
                            -> failed
                            -> cancelled
                            -> unknown
```

状态含义：

- `queued`：run 目录已创建，runner 尚未启动。
- `starting`：runner 已启动，CLI 子进程尚未开始。
- `running`：CLI 子进程正在执行。
- `completed`：CLI exit code 为 0，result 已写入。
- `failed`：CLI exit code 非 0、输出解析失败或 runner 异常。
- `cancelled`：取消请求已终止本地进程组。
- `unknown`：状态文件损坏，或本机进程状态无法可靠确认。

## 文件布局

默认 run 根目录：

```text
$XDG_CACHE_HOME/agent-hub-mcp/runs
```

`XDG_CACHE_HOME` 未设置时：

```text
~/.cache/agent-hub-mcp/runs
```

环境变量覆盖：

```text
AGENT_HUB_RUN_DIR=/path/to/runs
AGENT_HUB_RUN_TTL_SECONDS=604800
```

每个 run 一个独立目录：

```text
runs/
  01J.../
    state.json
    request.json
    command.json
    input.txt
    stdout.log
    stderr.log
    result.txt
    result.json
```

目录权限为 `0700`。

### state.json

运行中示例：

```json
{
  "schema_version": 1,
  "run_id": "01J...",
  "agent_id": "claude-code",
  "status": "running",
  "pid": 12345,
  "pgid": 12345,
  "cwd": "/Users/example/project",
  "created_at": "2026-06-27T10:00:00Z",
  "started_at": "2026-06-27T10:00:01Z",
  "updated_at": "2026-06-27T10:00:02Z",
  "expires_at": "2026-07-04T10:00:00Z"
}
```

终态示例：

```json
{
  "schema_version": 1,
  "run_id": "01J...",
  "agent_id": "claude-code",
  "status": "completed",
  "exit_code": 0,
  "result_path": "result.txt",
  "started_at": "2026-06-27T10:00:01Z",
  "completed_at": "2026-06-27T10:03:12Z",
  "updated_at": "2026-06-27T10:03:12Z",
  "expires_at": "2026-07-04T10:03:12Z"
}
```

### request.json

保存原始 MCP 请求字段：

- `agent_id`
- `cwd`
- `prompt`
- `metadata`
- `cli_session_ref`
- `created_at`

完整 prompt 同时保存到 `input.txt`；stdin 驱动的 CLI 从 `input.txt` 读取，kimi adapter
从 `request.json` 的 `prompt` 字段拼 `-p` argv。

### input.txt

保存调用方传入的原始 prompt。Runner 把该文件内容通过 stdin 传给 CLI（kimi 不读
stdin，该文件对它只作存档）。

### command.json

保存实际执行信息：

- adapter id
- argv
- cwd
- selected environment keys
- runner pid

`command.json` 不保存 auth token 值。

## 环境变量转发

Runner 不把 MCP server 的完整环境原样传给目标 CLI。`src/env.js` 维护默认 allowlist，
覆盖 Claude auth、云厂商 auth、终端行为、`PATH`、用户目录和 XDG 目录等运行所需键。

调用方可以通过 `AGENT_HUB_FORWARD_ENV` 追加转发键名，格式为逗号分隔：

```text
AGENT_HUB_FORWARD_ENV=FOO_TOKEN,BAR_PROFILE
```

这些变量值会传给目标 CLI，但 `command.json` 只记录经过敏感关键字过滤后的 env key，
不记录 env value；值为 `undefined` 的已清除键也不记为“存在”。

### stdout.log / stderr.log / events.jsonl

Runner 分别捕获 CLI stdout 和 stderr。

stdout 是 result 的来源。stderr 是诊断日志来源。对 JSONL 事件流输出（Claude Code 与
kimi 的 `stream-json`、Codex 的 `--json`、OpenCode 的 `--format json`），runner 还会把
同一事件流写入 `events.jsonl`。running snapshot 当前只投影 Claude/Kimi/Codex 的
`progress_events`；OpenCode 原始事件保留为 artifact，live projection 另行演进。

### result.txt / result.json

`result.txt` 是 MCP `content[0].text` 的来源。

`result.json` 保存 adapter 解析后的结构化输出。对 Claude Code 默认
`stream-json` 输出，它保存最终 `result` event；完整事件流保存在 `events.jsonl`。

## 文件写入规则

所有 JSON 状态文件使用原子写入：

1. 写入同目录临时文件。
2. `fsync` 文件。
3. `rename` 到目标路径。

日志文件可以 append 写入。终态 `state.json` 必须在 result 文件写入完成后更新。

## 结果语义

Agent Hub 返回 CLI 的最终输出，不通过 prompt 建立额外结果通道。

第一版结果规则：

- exit code 为 0 时，adapter 从 stdout 生成 result。
- exit code 非 0 时，run 状态为 `failed`。
- stdout 解析失败时，run 状态为 `failed`。
- stderr 只作为 artifact 和 log tail。

对纯文本 CLI，`result.txt` 等于 stdout 去掉末尾空白后的文本。

对 Claude Code adapter，stdout 默认为 JSONL 事件流；adapter 从最终 `result` event
写入 `result.txt` 和 `result.json`。兼容模式下可以通过
`metadata.claude.output_format: "json"` 使用旧的单 JSON 输出。

对 Codex adapter，stdout 是 `codex exec --json` 的 JSONL 事件流；adapter 从最后一条
`agent_message` item 写入 `result.txt` 和 `result.json`。

对 Kimi Code adapter，stdout 是 `kimi -p --output-format stream-json` 的 JSONL 事件流；
adapter 从最后一条带 `content` 的 `assistant` 事件写入 `result.txt` 和 `result.json`。

对 OpenCode adapter，stdout 是 `opencode run --format json` 的 JSONL 事件流；adapter
从最后一条 `text` event 写入 `result.txt` 和 `result.json`。

## Claude Code Adapter

第一版 Claude Code adapter 使用 direct print mode。

基础命令：

```text
claude -p --input-format text --output-format stream-json --verbose
```

执行规则：

- prompt 通过 stdin 传入，内容来自 `input.txt`。
- 新会话时 Agent Hub 生成 UUID，并传入 `--session-id <uuid>`。
- continuation 时传入 `--resume <native_session_id>`。
- `metadata.claude.model`（或统一的 `metadata.model`）映射到 `--model`；未提供时回退到服务端环境变量 `AGENT_HUB_CLAUDE_MODEL`，都未设置时不传 `--model`（此时 Claude CLI 使用本地保存的默认模型）。
- `metadata.claude.effort` 映射到 `--effort`；未提供时回退到服务端环境变量
  `AGENT_HUB_CLAUDE_EFFORT`，都未设置时不传 `--effort`。
- `metadata.claude.agent` 映射到 `--agent`。
- `metadata.claude.add_dirs`（或统一的 `metadata.add_dirs`）映射到重复的 `--add-dir`。
- `metadata.claude.output_format` 映射到 `--output-format`，默认 `stream-json`。
- `metadata.claude.permission_mode` 映射到 `--permission-mode`，优先于统一的
  `metadata.permission`（映射：`read-only` → `plan`，`auto` → `auto`，`full` →
  `bypassPermissions`）。
- 两者都未设置时，Agent Hub 默认传入 `--permission-mode auto`。

`dispatch_to_agent` 返回的 `cli_session_ref.native_session_id` 是本次传给 Claude 的
session UUID。Runner 完成后，终态 `cli_session_ref.native_session_id` 使用 Claude
result event 或 JSON 的 `session_id` 字段。

Claude stdout 处理规则：

- 完整 stdout 写入 `stdout.log`。
- 默认 `stream-json` 输出同时写入 `events.jsonl`。
- 最终 result event 或 JSON 对象写入 `result.json`。
- `result` 字段写入 `result.txt`。
- `session_id` 字段写回终态 `state.json`。
- `is_error` 为 true 时状态为 `failed`。
- 即使 Claude 同时返回非零 exit code，仍优先解析完整的 JSON/JSONL result；若
  `is_error=true`，保留原生错误文本与错误分类并记为 `agent_error`。认证失败不可重试。
- 缺少字符串类型的 `result` 或 `session_id` 时状态为 `failed`。
- JSON/JSONL 解析失败时状态为 `failed`。

## Codex Adapter

Codex adapter 使用 `codex exec` 非交互模式。

基础命令（默认统一权限 `auto`）：

```text
codex exec --json --skip-git-repo-check --sandbox workspace-write \
  -c sandbox_workspace_write.network_access=true -
```

执行规则：

- prompt 通过 stdin 传入（argv 末尾的 `-`），内容来自 `input.txt`。
- 新会话不预设 session id；Codex 在第一条 `thread.started` 事件里上报 thread id。
- continuation 使用 `codex exec resume <native_session_id>`；session id 是位置参数，
  必须是 thread UUID，其他字符串在 dispatch 和命令构建两处都会被拒绝（防止
  `--last` 之类的值被解析成 codex 选项）。
- `metadata.codex.model`（或统一的 `metadata.model`）映射到 `--model`；未提供时回退到
  服务端环境变量 `AGENT_HUB_CODEX_MODEL`，都未设置时不传 `--model`。
- `metadata.codex.effort` 映射到 `-c model_reasoning_effort="<effort>"`；未提供时回退
  到服务端环境变量 `AGENT_HUB_CODEX_EFFORT`，都未设置时不传。
- 统一的 `metadata.permission` 映射到 sandbox：`read-only` → `read-only`，`auto`（默认）
  → `workspace-write` 加 `-c sandbox_workspace_write.network_access=true`（对齐 Claude
  auto 的联网能力），`full` → `danger-full-access`。
- `metadata.codex.sandbox` 是原生逃生通道，设置后优先于 `metadata.permission`，
  并保留 codex 原生语义（`workspace-write` 默认禁网）；允许值为
  `read-only`、`workspace-write`、`danger-full-access`。
- `metadata.codex.add_dirs`（或统一的 `metadata.add_dirs`）映射到重复的 `--add-dir`。
- `codex exec resume` 的 flag 集合比 `codex exec` 窄：sandbox 通过
  `-c sandbox_mode="<mode>"` 传递，add_dirs 通过
  `-c sandbox_workspace_write.writable_roots=[...]` 传递。
- 始终传 `--skip-git-repo-check`：`cwd` 已经过显式校验和 allowlist 检查。
- 不暴露 `--dangerously-bypass-approvals-and-sandbox`。

Codex stdout 处理规则：

- 完整 stdout 写入 `stdout.log`，事件流同时写入 `events.jsonl`。
- 最后一条 `item.completed` 且 `item.type` 为 `agent_message` 的事件写入
  `result.json`，其 `text` 写入 `result.txt`。
- 最后一条 `thread.started` 的 `thread_id` 写回终态 `state.json` 的
  `cli_session_ref`。
- runner 在运行中一旦观察到 `thread.started` 就把 `cli_session_ref` 写入
  `state.json`，因此取消的 run 仍保留可 resume 的 thread id。
- 出现 `turn.failed`（或 turn 未完成且有 `error` 事件）时状态为 `failed`，错误码为
  `agent_error`，错误消息取自事件。`turn.completed` 之前被重试掉的 `error`
  事件不视为失败。
- exit code 非 0 且没有失败事件时状态为 `failed`，错误码为 `cli_exit_nonzero`。
- 缺少 `agent_message` 或 `thread_id` 时状态为 `failed`，错误码为
  `stdout_parse_failed`。

## Kimi Code Adapter

Kimi Code adapter 使用 `kimi -p` 非交互模式。

基础命令：

```text
kimi -p <prompt> --output-format stream-json
```

执行规则：

- prompt 通过 `-p` argv 传入（kimi `-p` 不读 stdin），内容来自 `request.json` 的
  `prompt` 字段。
- 新会话不预设 session id；kimi 在 stdout 事件流末尾的 `session.resume_hint` meta
  事件里上报 `session_id`（形如 `session_<uuid>`）。
- continuation 使用 `kimi --session <native_session_id> -p ...`；session id 必须匹配
  `session_<uuid>` 或 `ses_<uuid>`（官方迁移器从旧 kimi-cli 迁移过来的会话）形态，
  其他字符串在 dispatch 和命令构建两处都会被拒绝（防止 `--help` 之类的值被解析成
  kimi 选项）。
- `metadata["kimi-code"].model`（或统一的 `metadata.model`）映射到 `-m`；未提供时回退到
  服务端环境变量 `AGENT_HUB_KIMI_MODEL`，都未设置时不传 `-m`。
- `metadata["kimi-code"].effort` 映射到子进程环境变量 `KIMI_MODEL_THINKING_EFFORT`；
  未提供时回退到服务端环境变量 `AGENT_HUB_KIMI_EFFORT`，都未设置时不注入。取值原样
  透传（合法值见 kimi 文档：low/medium/high/xhigh/max），非法值由 kimi 报错并走
  `agent_error` 失败路径。
- 权限不传任何 flag：`--plan` / `--auto` / `--yolo` 与 `-p` 冲突（启动即拒绝），且
  kimi `-p` 内建 auto 审批，正好对齐统一默认 `permission: "auto"`。统一
  `permission` 为 `read-only` 或 `full` 时命令构建直接报错——没有原生对应物，
  不能静默跑成别的权限级别。
- `metadata["kimi-code"].add_dirs`（或统一的 `metadata.add_dirs`）映射到重复的
  `--add-dir`。

Kimi stdout 处理规则：

- 完整 stdout 写入 `stdout.log`，事件流同时写入 `events.jsonl`。
- 最后一条带字符串 `content` 的 `assistant` 事件写入 `result.json`，其 `content`
  写入 `result.txt`。
- 事件中的 `session_id`（来自 `session.resume_hint`）写回终态 `state.json` 的
  `cli_session_ref`。该事件只在正常结束时出现，因此取消的 run 没有可 resume 的
  session ref。
- exit code 非 0 且 stderr 形如 `error: failed to run prompt: <detail>` 时状态为
  `failed`，错误码为 `agent_error`（模型侧失败：模型别名无效、provider/API 错误等），
  错误消息取自 `<detail>` 首行。
- exit code 非 0 且无该形态时状态为 `failed`，错误码为 `cli_exit_nonzero`。
- exit code 为 0 但缺少 `assistant` 消息或 `session_id` 时状态为 `failed`，错误码为
  `stdout_parse_failed`。

## OpenCode Adapter

OpenCode adapter 使用 `opencode run` 非交互模式。

基础命令：

```text
opencode run --format json --auto
```

执行规则：

- prompt 只通过 stdin 传入，内容来自 `input.txt`；不得同时添加 argv prompt，否则
  OpenCode 会把两份输入拼接，造成重复、引号变形和 argv 大小上限。
- 新会话不预设 session id；OpenCode 从首条 JSON event 起上报 `sessionID`（形如 `ses_*`）。
- continuation 使用 `--session <native_session_id>`，session id 先做形态校验。
- `metadata.opencode.model`（或统一的 `metadata.model`）映射到 `--model`，未提供时回退
  `AGENT_HUB_OPENCODE_MODEL`。
- `metadata.opencode.effort` 映射到 `--variant`，未提供时回退
  `AGENT_HUB_OPENCODE_EFFORT`；值由 provider 校验。
- `metadata.opencode.agent` 映射到 `--agent`。
- 只接受统一 `permission: "auto"` 并映射到 `--auto`。OpenCode 对 asked permission 将
  `--auto` 与 yolo 等价处理，不提供 workspace 文件系统边界；只有显式 deny 仍生效。
  `read-only` 无法跨用户自定义 agent 保证，`full` 没有独立稳定映射，二者均拒绝。
- OpenCode 不提供 add-dir 边界，非空 `add_dirs` 直接拒绝。

stdout 处理规则：

- 完整 JSONL 同时写入 `stdout.log` 与 `events.jsonl`。
- 最后一条非空 `text` event 写入 `result.json`，其 `part.text` 写入 `result.txt`。
- runner 从首条合法 `sessionID` 注册 session lease；续接可复用同一 ref。
- 顶层 `error` event 映射为 `agent_error`，消息优先取 `error.data.message`。
- 多个冲突 session id、缺少 text event 或缺少合法 session id 映射为
  `stdout_parse_failed`；无结构化错误的非零退出映射为 `cli_exit_nonzero`。

## Discussion 编排

Discussion 的主入口是 `agenthub discussion`：dispatch 创建 detached worker，后续
query/wait/cancel 可从本机持久化记录按需恢复，不要求常驻 daemon。可选 streamable HTTP
进程启动一个 process-wide `DiscussionManager`，每次 MCP HTTP 请求仍可创建短生命周期
server/transport，但共享同一个 manager。MCP stdio 只保留普通 run tools。两种 coordinator
都不会让讨论依附某次请求或 client 连接。

固定协议包含五个阶段：独立 memo、主持人验证计划、参与者 challenge、参与者 revision、
主持人 DecisionRecord。调用方在材料准备时确定完整 roster；主持人只主持，不邀请成员。
协议过程中不能追加消息，讨论完成后才能创建继承原 roster 的 follow-up。

主要模块：

| 模块 | 职责 |
|---|---|
| `discussion-manager.js` | 生命周期、阶段 deadline、并行 turn、quorum、重试、取消、恢复和 follow-up。 |
| `discussion-protocol.js` | dispatch 输入、五种结构化输出、大小和引用校验、capability 解析。 |
| `discussion-store.js` | `discussions/<id>` 事件优先持久化、投影、lease、恢复和 TTL。 |
| `discussion-materials.js` | inline/file 材料冻结、普通文件校验、hash 和 Git provenance。 |
| `discussion-prompts.js` | 版本化 coordinator prompt 和固定 JSON output contract。 |
| `discussion-render.js` | 从权威 DecisionRecord 确定性渲染 `decision.md`。 |

每场讨论的 `events.jsonl` 是提交记录，`state.json` 是可恢复投影。提交在短时 discussion
lock 内验证 lease 的 `owner_id + generation`，先 append/fsync 事件，再原子替换投影。
coordinator 每 5 秒续 lease，20 秒无心跳后另一实例才能接管。启动时扫描非终态记录、修复唯一
的残缺尾部、查询所有 active run，并通过稳定幂等键重新挂接或派发。普通 query 不执行
尾部修复，避免与活跃 writer 竞争。

每个逻辑 turn 在派发前持久化 `turn.dispatch_requested`、prompt SHA-256、request hash 和
`discussion:<discussion_id>:turn:<kind>:<member>:attempt:<n>` 幂等键。run 子系统将幂等
索引和 session registry 放在 run root 的 `.internal` 下。相同键和相同请求返回原
`run_ref`；请求变化报 `idempotency_conflict`。

Session registry 对 `agent_id + native_session_id` 保存单调 generation、active run 和
lineage claim。已知 session ID 的新 run 与所有 continuation 都必须先取得独占 lease；
Codex 在观察到 `thread.started` 后先登记 lease，再把 ref 写入公开 state。终态释放 lease。
follow-up 对 parent generation 做 compare-and-swap 认领，因此同一 CLI 历史不能形成 sibling
分叉。coordinator 关闭只停止新 turn 并释放 discussion lease，不取消已经 detached 的 run。

Discussion 的权限来自 adapter `capabilities.discussion`：preferred permission 必须是
`read-only` 或 `auto`。当前 Claude/Codex 选 read-only，Kimi/OpenCode 选 auto。请求 metadata 不能
覆盖 permission；这是尽力只读而不是强安全隔离。最终 Markdown 会披露每位成员的 effective
permission、network access 和 session mode。

终态 Discussion 默认保留 7 天。所有关联 run 写入 `retain_until`，因此普通 run TTL 不会
早于 Discussion 删除底层证据。完整协议和结构化消息定义见
[discussion-design.md](discussion-design.md)。

## 清理策略

Cleanup 在 `list_agents`、`dispatch_to_agent`、`query_agent_run`、`wait_agent_run` 和
`run_agent` 开始时执行。

规则：

- 终态 run 到达 `expires_at` 后删除整个 run 目录。
- `retain_until` 尚未到期的关联 run 不删除。
- 非终态 run 保留。
- 非终态 run 的 pid/pgid 不存在时，query/wait 把状态写为 `failed`，错误码为
  `process_missing`。
- 默认 TTL 为 604800 秒。
- `DiscussionManager` 同时清理已过 `expires_at` 的终态 Discussion；非终态 Discussion 永不由
  TTL cleaner 直接删除。

## 安全默认值

- run 根目录和每个 run 目录权限为 `0700`。
- CLI 启动使用 argv list。
- prompt 通过 stdin 传递（kimi 例外：`-p` 只接受 argv prompt）。
- `cwd` 必须显式传入。
- `AGENT_HUB_CWD_ALLOWLIST` 设置后，`cwd` 和 `metadata.*.add_dirs` 必须位于 allowlist 内。
- cancel 只作用于对应 run 的进程组。
- command metadata 记录环境变量名，不记录敏感环境变量值。

## Runner 进程组约定

`dispatch_to_agent` 通过 detached runner 启动一次 run。Runner 在启动 CLI 前记录自己的
`runner_pid` 和 `runner_pgid`，用于诊断和启动早期取消。当前 POSIX 实现中 detached
runner 是进程组 leader，因此 `runner_pgid === runner_pid`；该值以 `runner_pgid` 字段
保存，调用方不得把任意 `runner_pid` 当作进程组使用。

进入 `running` 后，runner 将目标 CLI 作为独立进程组启动，并把 `state.json` 中的
`pid`/`pgid` 更新为目标 CLI 的 pid/pgid。`cancel_agent_run` 优先向该 CLI 进程组发送
SIGTERM/SIGKILL；runner 观察 CLI 退出并在看到 `cancelled` 状态时停止写入其它终态。

当前实现面向 macOS/Linux。Node.js 在 POSIX 平台上用 `detached: true` 启动子进程时会
创建新的 session/process group，因此目标 CLI 的 pgid 等于该 child pid；runner 在公开
该 pgid 前用 `kill(-pgid, 0)` 验证进程组存在。
