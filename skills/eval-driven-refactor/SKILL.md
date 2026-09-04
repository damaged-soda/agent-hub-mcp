---
name: eval-driven-refactor
description: 使用 Agent Hub 为仓库结构重构设计、运行和解读受控的前后对照评测。适用于判断代码重组能否改善 agent 的定位或修改效率；不用于普通单次评测、纯正确性测试或 PR review。
---

# 评测驱动重构

用仓库自有的 Agent Hub 评测用例，把结构重构变成可验证的实验。本 Skill 持有实验方法，
不定义新的 Agent Hub 比较 API；具体 CLI 与隔离契约以 `agent-hub` Skill 为准。

## 守住权威边界

- 待评测仓库可以用 `.agenthub/evals.json` 提供只含问题与公开 preflight policy 的样例；评测者
  持有本次运行使用的 suite，它可以位于被测 worktree 外且无需提交。
- Agent Hub 只针对一个不可变 commit 运行并判定一份评测集，私有保存原始结果。
- 评测者通过交互输入源码位置标准答案，或外部 patch verifier 与 known-good control。
  标准答案、verifier 身份、control identity、固定答案注释等 oracle 质料不得进入待评测仓库。
- 结果比较在当前任务或消费产品中完成；不得把跨 commit 排名、长期 benchmark 状态或对仓库
  质量的结论塞入 Agent Hub 内核。
- 发起评测不等于授权重构、生产部署或访问目标工作区之外的路径；继续遵守仓库自身的审批与
  交付规则。

## 测量前先定义实验

先写清结构假设，以及实验要支持什么决策。在查看候选结果之前选定语义等价的任务，避免根据
重构结果反向调题。可以复制仓库样例并在评测者侧修改或类推，再把选定 suite 同时用于两侧。
记录 baseline 与 candidate commit，以及必须保持一致的 agent、model、effort、timeout、评测集
digest、CLI 版本和隔离策略。
代码修改题优先使用 suite schema v3：预先选定同一个 evaluator-owned
`eval-toolchain-capsule/v1`，并把两侧结果中的 `toolchain.content_digest`、
`capability_plan.contract_digest` 列为硬性控制变量。这个 capsule 必须通过绝对 manifest 路径提供，
位于被测 worktree 及其 Git common dir 外，并在运行前用权限位密封；Agent Hub 不会从宿主发现、复制、下载或回退任何
工具。

`source-location` suite v1 仍是定位题的当前协议；patch suite v2、
`python-runtime-capsule/v1` 与 result v1-v4 仍保持原有语义，供既有 patch 实验兼容使用。

新的受控重构代码修改 suite 必须启用
`verifier_preflight: "subject-reject-known-good-pass/v2"`，并用 `toolchain_requirements` 声明
会实际消费的命令及 smoke argv。在启动任何模型前，先由独立视角审阅
verifier，并以至少一个代表性 partial-bad mutation 确认它会拒绝关键的半成品；再准备每题
clean、committed、same-repository、descends-from-subject 的 known-good worktree。Agent Hub
先在最终 `workspace-write/v2` capability profile 中执行所有声明 smoke，再让同一 Codex sandbox
capability plan 下的 verifier 拒绝 untouched subject、接受 known-good。内建 preflight 不能证明
断言完整、subject 是因预期理由失败，或任意动态依赖已经形成静态闭包。

编写或修改用例时读取 [references/case-design.md](references/case-design.md)。定位题和代码修改题
必须分属不同评测集，因为对应的 Agent Hub schema 不能混用。

## 运行成对评测

分别用干净 worktree 检出不可变的 baseline 与 candidate commit。在两个 worktree 根目录以相同
配置运行同一评测集：

```sh
agenthub eval toolchain manifest \
  --directory /absolute/path/to/toolchain \
  --json '{"toolchain_id":"repo-tools","root":"root","commands":{"git":"bin/git","node":"bin/node","python3":"bin/python3"}}'
chmod -R a-w /absolute/path/to/toolchain
agenthub eval toolchain status --toolchain /absolute/path/to/toolchain/manifest.json
agenthub eval run --agent codex --cwd "$PWD" \
  --suite /absolute/path/to/evals.json \
  --model gpt-5.6-sol --effort medium \
  --toolchain /absolute/path/to/toolchain/manifest.json
```

以上命令针对推荐的 schema v3 patch suite。`eval toolchain status` 会检查 manifest、平台、
命令映射、内容 digest 与 `eval run` 同样的 seal：manifest 所在目录、manifest 与整个 capsule
tree 都不得有写权限位，普通文件也不得通过硬链接共享 inode。capsule 由评测者预先构建并持有，
`eval run` 没有 install、host discovery、download 或 fallback 路径。
`eval toolchain manifest` 只为评测者已经组装好的 root 计算权威 digest 并写 manifest；它
同样不发现、安装、复制或 seal 工具。先运行它，再去掉整个专用 capsule 目录的写位。

`--model` 和 `--effort` 必须显式传入；Agent Hub 不接受默认值。`--suite` 选择评测者本次固定的
问题快照，`--timeout-ms` 只在实验预先指定时传入。两侧的 suite、model、effort、timeout、
toolchain content digest 与 capability contract digest 必须完全一致。分别为两个 commit 输入当时
正确的标准答案：重构可能合理地移动权威路径、symbol 或
定义行，只要任务语义没有变化。代码修改题两侧必须使用语义相同的 verifier 与 preflight
policy；按 TTY 提示为每个 case 输入 verifier 和 known-good worktree。Agent Hub 会先完成整套
toolchain smoke 和双向 verifier preflight，再启动第一条 agent run。成功的 v3 patch 结果应为
schema v5、grader `workspace-patch/v3`，包含已通过的 `eval-capability-plan/v1`；结果只保存 capability
与 preflight 的 opaque binding，subject `cwd`、artifact storage path、known-good 的 path、commit、
内容与 verifier 输出均不得出现。

评测者可以在一组成对运行开始前修改或类推样例问题。若两侧的 suite 或 question digest 不同，
就把它们视为探索性新用例，只做定性观察，不计算成对效率收益。

`eval run` 要求 stdin 和 stderr 连接真实终端或 PTY。标准答案只能由评测者提供，不能交给被测
agent。当前环境若无法维持交互 PTY，就准备好成对 worktree 和命令，请人类在终端执行，不要从
非交互工具 shell 强行调用 Eval。

不要增加独立答案文件、可复用 receipt 或仓库 prepare 阶段；toolchain provisioning 是独立的环境
前置条件，verifier preflight 则留在同一个前台 `eval run` 的交互内存中。不要恢复旧 agent
会话、启用 memory、暴露额外目录或放宽隔离。Agent Hub 的 eval profile 已用关闭 memory 与
subagent 的全新会话执行。worktree 不干净、评测集或
配置不一致、隔离不受支持、标准答案、verifier 或 preflight policy 语义不等价时，停止并点明
两次运行不可比较。preflight 失败时不应存在 agent run 或 Eval artifact；不要把 untouched
subject 的预期失败单独当作校准完成。

schema v3 的 control verifier、final verifier 与 child 都消费同一个版本化 capability plan，并受
Codex sandbox、无网络、capsule-only `PATH` 和确定性任务环境约束。这个保证只覆盖 suite 声明且
smoke 成功的命令；shebang 解释器、动态插件、绝对路径子进程或其它间接依赖不会被静态推导，
仍须由用例作者纳入 capsule 与 smoke。它也不是 hostile-code sandbox 的形式化证明。兼容的
schema v2 verifier 仍按旧契约在 sandbox 外以前台用户权限执行，可能访问文件、网络并运行 control
或 agent 产生的代码；不要把旧结果与 v5 当成同一安全边界下的对照。

## 解读结果，而不只看分数

比较前读取 [references/interpretation.md](references/interpretation.md)。先应用正确性门槛，再逐个
比较配对用例；指标无法解释结果时，检查背后的会话。一次成对运行只能作为方向性证据，不能当作
统计证明。

最终结论只取三种之一：

- **支持重构：** 正确性保持不变，预期的定位或修改负担下降，且没有以范围或复杂度退化为代价。
- **不支持重构：** 正确性退化，或预期收益没有出现。
- **无法判断：** 控制变量不一致、结果相互冲突，或观测差异很可能只是噪声。

逐题报告证据、实质性混杂因素和下一项最小决策。只复跑有歧义或影响重大的用例，不要把探索闭环
膨胀成无边界的 benchmark 工程。
