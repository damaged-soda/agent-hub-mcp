# 用例设计

围绕维护意图设计用例，而不是围绕当前仓库布局。即使重构移动了文件、symbol 和行号，题目也应
继续公平有效。

## 选择题型

如果假设是新结构能帮助 agent 找到某项行为的生产权威，用 `source-location/v1`。它只测定位与
解释，对修改质量的证明力较弱。

如果假设是新结构能让真实修改更简单或更安全，优先用 suite schema v3；case 的答案契约仍写
`workspace-patch/v1`。外部 verifier 可以检查行为与意外修改范围，但必须位于所有 agent 可读
路径之外，并通过交互输入。受控重构的 v3 suite 必须在根启用
`verifier_preflight: "subject-reject-known-good-pass/v2"`，同时声明 `toolchain_requirements`。
suite v2 / preflight v1 保留为兼容路径，其 verifier 仍在 sandbox 外执行，不应与 v3 结果混作
同一安全边界下的对照。

同一评测集不得混用两种答案 schema。两者都有价值时，分别建立只含问题的评测集，各自独立运行
成对实验。

## 编写不依赖布局的题目

好题目用维护者自然使用的语言描述可观察意图，不规定搜索策略，不点名预期文件或 symbol，也不
暴露能把任务退化为直接文本搜索的唯一字面量。

优先选择必须沿真实控制流或数据流，从公共入口追到决策权威代码的问题。答案应当能从仓库正常
证据中得出，不能依赖人为埋入的注释或只为 benchmark 服务的标记。

遇到以下情况应放弃或重写用例：

- 题目指定了要检查的命令、目录、文件或中间 symbol；
- 题目中的某个短语只有一个文本匹配，而且该匹配本身就是答案；
- 题目依赖行号、函数名或变量名保持不变；
- 多个实现都满足题意，但仓库没有权威契约，标准答案却只接受其中一个；
- candidate 改变了题目要求的行为，而不只是组织方式；
- 用例存在的唯一目的，是奖励预设的新结构。

## 覆盖结构假设

小型 benchmark 只有覆盖不同维护形态时才更有价值。根据重构目标，可以考虑：

- 从外部入口追踪到持有某个非显然决策的组件；
- 完成应当局限在单一职责边界内的局部行为修改；
- 完成一个跨边界修改，而新结构的目标正是降低这种协调成本；
- 保留相邻的负例，避免 agent 通过静默删减行为获得更小 diff。

不要规定固定题数。每道题都必须有影响决策的独立理由；删除重复或含糊的题目，不要为了数量填充
评测集。

## 声明可执行能力

schema v3 用 `command-smoke/v1` 把 patch task 与 verifier 依赖的命令变成 suite 契约。例如：

```json
{
  "schema_version": 3,
  "suite_id": "refactor-patch",
  "verifier_preflight": "subject-reject-known-good-pass/v2",
  "toolchain_requirements": {
    "kind": "command-smoke/v1",
    "commands": [
      { "name": "node", "argv": ["-e", "process.exit(0)"] },
      { "name": "git", "argv": ["init", "-b", "main", "."] }
    ]
  },
  "cases": [
    {
      "id": "change-behavior",
      "prompt": "Change the requested behavior and run the repository test entrypoint.",
      "answer_schema": "workspace-patch/v1"
    }
  ]
}
```

每个 `name` 必须存在于 evaluator 提供的 sealed `eval-toolchain-capsule/v1` 命令映射中；argv 应在
隔离 scratch 目录内离线、确定性地验证该任务真正需要的工作模式，而不只是证明文件可执行。
若 child、repository test entrypoint 或 verifier 会调用其它命令、解释器或关键子模式，也应把它们
纳入 capsule 与 requirements。Agent Hub 不会扫描脚本或进程树来推导依赖闭包，也不会从宿主
`PATH` 补齐、下载或回退缺失工具；因此一个通过的 smoke 只证明声明的能力可用，不证明任意动态
插件、绝对路径子进程或输入相关依赖必然可用。
overlay `PATH` 只进入 sandbox child，不会 prepend 给 Codex 父进程；否则 Codex 启动期探测可能在
sandbox 外执行 capsule 命令，该运行不得作为受控评测。

同一对照实验必须使用完全相同的 suite 与 capsule digest。capsule manifest 要用绝对路径传给
`--toolchain` 并位于 subject worktree 及其 Git common dir 外；child 可读的 capsule root 不得与任何 oracle 重叠。运行前移除
manifest 所在目录、manifest 及整个 capsule tree 的所有写权限位。不要把 token、答案、verifier
或 known-good 内容打包进 child 可读 capsule。
评测者组装完 root 后，使用 `agenthub eval toolchain manifest --directory ... --json ...` 让
Agent Hub 的权威 writer 生成精确 digest；再 seal 并运行 `eval toolchain status`。这个命令不会
替评测者发现、安装或复制工具。

## 在模型运行前校准 verifier

为每个 patch case 准备一个 clean、committed、same-repository、descends-from-subject 的
known-good worktree，并在
`eval run` 的 TTY 中与 verifier 一起提供。Agent Hub 会在 disposable copy 上先要求 verifier
拒绝 untouched subject，再接受 known-good；所有 case 都通过后才 dispatch。不要用任意
known-bad fixture 代替当前 subject，也不要把“当前 baseline 如预期失败”单独当成校准成功：
always-fail verifier 或缺依赖同样会给出非零退出。

schema v3 会更早在最终 `workspace-write/v2` profile 中执行所有声明 smoke；随后 control verifier、
final verifier 与 child 都由 Codex sandbox 执行，并消费同一 capability plan。任何 smoke 或 control
失败都会在第一条模型 run 之前终止，而且不产生普通 run 或 Eval artifact。

verifier 与 known-good 的输入路径和 realpath 都必须位于 subject 与 child 可读 toolchain
capability 之外；一旦重叠，`unsafe_eval_oracle` 会终止整条命令而非允许重输，因为后续 prompt
无法撤回已经授予的可读范围。

双向 preflight 只能排除最粗的 always-pass、always-fail 和环境不通，不能证明 verifier 覆盖题目
语义。冻结前仍须让独立 reviewer 对照自然语言意图审阅断言，并对至少一个会保留关键缺陷的
partial-bad mutation 运行 verifier；它必须失败。known-good、mutation patch、verifier 路径与
正文都是评测者持有的 oracle，不得写入 suite 或被测 worktree。

v3 的 verifier 虽受 Codex sandbox、无网络、capsule-only `PATH`、私有 HOME/temp 与 disposable
worktree 约束，仍可能执行仓库或 agent 产生的代码；这不是对 hostile code 的形式化安全证明。
只使用可信、最好幂等的 verifier。兼容的 schema v2 verifier 仍以前台用户权限运行，具有旧契约下
更宽的宿主文件系统与网络权限。

## 标准答案不得进入评测集

仓库可以提供只含题目、公开答案 schema 与公开 preflight policy 的样例，但评测者持有运行时
suite，并可在被测 worktree 之外修改或类推。定位题要分别检查每个 commit，并在运行时输入当时的 `path`、`symbol` 和
`definition_line`。答案在 baseline 与 candidate 之间移动是正常现象，本身不构成失败。

受控比较必须让两侧使用相同的规范化问题与 digest。根据某一侧结构单独改写的问题属于探索性
新用例，不能把结果差异归因于重构。

代码修改题使用外部可执行 verifier，且两个 commit 上的断言、preflight policy 与 known-good
行为语义必须等价。它可以注入隐藏测试并调用仓库正常测试入口，但除非文件布局本身就是用户需求，
否则不得断言预设布局。两侧 v5 结果的 opaque preflight binding 会因 subject 不同而不同；比较
时要求相同 suite、question、verifier、toolchain、capability contract、policy 与执行配置，不要求
preflight binding 本身相同。历史 v4 比较继续使用其原有 runtime 契约。
