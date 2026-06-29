# Agent Hub MCP Architecture

## 目标

Agent Hub MCP 是一个本地 MCP bridge。它把 MCP tool call 映射成本机 agent CLI
的一次非交互执行，并用本机文件保存 run 状态、日志和结果。

核心目标：

- MCP 层保持薄封装，只负责 CLI 启动、状态记录、查询、等待和取消。
- 用户输入原样传给目标 CLI；Agent Hub 不追加 system prompt、wrapper prompt 或结果写入提示。
- 每次执行都有独立 run 目录，状态和结果保存在本机专用目录。
- run 终态后默认保留 7 天。
- 多轮对话复用 CLI 自身的 session/resume 能力。
- 提供 blocking wait tool，让调用方一次等待 run 结束。

## 架构原则

### 原生透传

Agent Hub 接收调用方传入的 `prompt`、`cwd`、`agent_id`、`cli_session_ref` 和
adapter metadata。Adapter 只把这些字段映射成目标 CLI 的 argv、stdin 和环境。

Prompt 处理规则：

- `prompt` 字符串按调用方提供的内容传给 CLI。
- Agent Hub 不在 prompt 前后拼接任何文本。
- Agent Hub 不通过 prompt 要求目标 agent 写 result file。
- Agent Hub 将 prompt 原文写入 `input.txt`，runner 再把 `input.txt` 内容通过 stdin
  传给 CLI。

CLI 参数处理规则：

- MCP 为非交互执行设置必要参数，例如 Claude Code 的 `-p` 和 `--output-format stream-json`。
- 其他 CLI 行为参数来自 adapter metadata 或 CLI 默认配置。
- `command.json` 记录实际 argv，便于复现。

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

## MCP Tools

### list_agents

返回当前可用的 CLI adapter。

Adapter 出现在列表中的条件：

- CLI binary 可执行。
- direct non-interactive 命令可用。
- Adapter 能把一次 CLI 退出转换为明确的 `completed` 或 `failed`。

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
- `metadata`
- `cli_session_ref`
- `created_at`

完整 prompt 保存到 `input.txt`。

### input.txt

保存调用方传入的原始 prompt。Runner 把该文件内容通过 stdin 传给 CLI。

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
不记录 env value。

### stdout.log / stderr.log / events.jsonl

Runner 分别捕获 CLI stdout 和 stderr。

stdout 是 result 的来源。stderr 是诊断日志来源。对 Claude Code `stream-json`
输出，runner 还会把同一事件流写入 `events.jsonl`，供 running snapshot 生成
`progress_events`。

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
- `metadata.claude.model` 映射到 `--model`。
- `metadata.claude.effort` 映射到 `--effort`。
- `metadata.claude.agent` 映射到 `--agent`。
- `metadata.claude.add_dirs` 映射到重复的 `--add-dir`。
- `metadata.claude.output_format` 映射到 `--output-format`，默认 `stream-json`。
- `metadata.claude.permission_mode` 映射到 `--permission-mode`。
- 未设置 `metadata.claude.permission_mode` 时，Agent Hub 默认传入 `--permission-mode auto`。

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
- 缺少字符串类型的 `result` 或 `session_id` 时状态为 `failed`。
- JSON/JSONL 解析失败时状态为 `failed`。

## 清理策略

Cleanup 在 `list_agents`、`dispatch_to_agent`、`query_agent_run`、`wait_agent_run` 和
`run_agent` 开始时执行。

规则：

- 终态 run 到达 `expires_at` 后删除整个 run 目录。
- 非终态 run 保留。
- 非终态 run 的 pid/pgid 不存在时，query/wait 把状态写为 `failed`，错误码为
  `process_missing`。
- 默认 TTL 为 604800 秒。

## 安全默认值

- run 根目录和每个 run 目录权限为 `0700`。
- CLI 启动使用 argv list。
- prompt 通过 stdin 传递。
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
