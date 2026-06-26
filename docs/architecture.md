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

- MCP 为非交互执行设置必要参数，例如 Claude Code 的 `-p` 和 `--output-format json`。
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
  },
  "timeout_ms": 600000,
  "poll_interval_ms": 1000
}
```

规则：

- 默认 `timeout_ms` 为 600000。
- 最大 `timeout_ms` 为 3600000。
- 默认 `poll_interval_ms` 为 1000。
- 终态包括 `completed`、`failed`、`cancelled`、`unknown`。
- 超时仍在运行时返回 `status: "running"` 和 `timed_out: true`。

### cancel_agent_run

取消 Agent Hub 创建的本地 run。

规则：

- 读取 `state.json` 中的 `pgid`。
- 对进程组发送 SIGTERM。
- grace period 为 10 秒。
- 进程组仍存在时发送 SIGKILL。
- 状态写为 `cancelled`。

### run_agent

便捷工具，等价于 `dispatch_to_agent` 后立刻 `wait_agent_run`。

默认等待 10 分钟。超时时返回 running 快照，调用方可以继续调用 `wait_agent_run`。

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

### stdout.log / stderr.log

Runner 分别捕获 CLI stdout 和 stderr。

stdout 是 result 的来源。stderr 是诊断日志来源。

### result.txt / result.json

`result.txt` 是 MCP `content[0].text` 的来源。

`result.json` 保存 adapter 解析后的结构化输出。对 Claude Code 第一版，它保存
`claude -p --output-format json` 的完整 JSON。

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

对 Claude Code 第一版，stdout 必须是 JSON；adapter 从 JSON 的 `result` 字段写入
`result.txt`，并把完整 JSON 写入 `result.json`。

## Claude Code Adapter

第一版 Claude Code adapter 使用 direct print mode。

基础命令：

```text
claude -p --input-format text --output-format json
```

执行规则：

- prompt 通过 stdin 传入，内容来自 `input.txt`。
- 新会话时 Agent Hub 生成 UUID，并传入 `--session-id <uuid>`。
- continuation 时传入 `--resume <native_session_id>`。
- `metadata.claude.model` 映射到 `--model`。
- `metadata.claude.effort` 映射到 `--effort`。
- `metadata.claude.agent` 映射到 `--agent`。
- `metadata.claude.add_dirs` 映射到重复的 `--add-dir`。
- `metadata.claude.permission_mode` 映射到 `--permission-mode`。

`dispatch_to_agent` 返回的 `cli_session_ref.native_session_id` 是本次传给 Claude 的
session UUID。Runner 完成后，终态 `cli_session_ref.native_session_id` 使用 Claude
JSON 的 `session_id` 字段。

Claude stdout JSON 处理规则：

- 完整 stdout 写入 `stdout.log`。
- JSON 对象写入 `result.json`。
- JSON `result` 字段写入 `result.txt`。
- JSON `session_id` 字段写回终态 `state.json`。
- JSON `is_error` 为 true 时状态为 `failed`。
- JSON 缺少字符串类型的 `result` 或 `session_id` 时状态为 `failed`。
- JSON 解析失败时状态为 `failed`。

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
