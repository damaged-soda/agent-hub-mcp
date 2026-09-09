# spine 质料：agent-session 的 personal 域接线

`serve` 程序 exec 成包内的 `node src/session-cli.js serve`（回环 8088），由 personal
域的 spine 骨架看护（唯一保活者）。包由 [`build`](build) 暂存：本检出的 `src`、
`package.json`、`package-lock.json`、按 lockfile 装的生产依赖，加 `serve.py` 与
`material.json`，在旁边的临时目录建好后整目录换到位，失败不碰既有产物。包摘要覆盖
Agent Hub 的真实代码：升级 = 合 PR → build → publish，
节点按摘要变化停旧起新；同一检出重复 build 得到同一摘要，publish 幂等。node 来自
spine 钉版本的运行时（Node 24），build 也用它自带的 npm 解析依赖。
包内服务另提供只读路由配置接口 `GET /agent-session/api/review-routing`，复用
`reviewStatus()` 读取配置与默认值，不探测 reviewer 或模型，也不写缓存；额度页直接
调用此接口，源码与依赖随本包一起发布。
`npm run install:local` 只服务 `agenthub` / `agent-session` 两个 CLI，不再是 server 的
部署路径。本目录是本仓里唯一的 personal 域部署内容，不进 npm 包（package.json
files 白名单外）。

- 宿主 HOME 还原（provider 原生会话库按它定位）；PATH 原样沿用骨架给的。
- `--public-origin` 缺省不设：旧驾驶舱域名已于 2026-09-08 退役，服务只认回环
  Host/Origin（消费者全在本机不受影响）。将来若有可信反代域名，随 publish 用
  `--program-arg serve=--public-origin --program-arg serve=https://…` 传入，
  否则经反代的请求会被 Host/Origin 校验 403。
- 回环内部服务不自述 endpoints。宿主依赖无必需项，不声明 `requires`：OpenCode
  provider 经 `sqlite3` 命令行读库，缺失时该 provider 局部降级（汇总带 source_errors
  可见），不作为启动前提。

生产（在 macmini 上，运行时须已按 spine 的 `bin/spine-bootstrap` 自举到含 Node 的版本）：

```sh
~/work/meta/agent-hub-mcp/spine/build && \
~/.spine/runtime/bin/spine publish ~/work/meta/agent-hub-mcp/spine/stage \
    --nats nats://100.109.38.77:4222 --node host=macmini
```

默认参数即当前接线。build 打的是检出的工作树，发布前确认它在想发的提交上；同一输出目录
不支持并发 build，rm 与 mv 之间有窗口，已知残余。

测试：`spine/tests/run`（需要 Python 3.12、nats-server、spine 检出与已自举的运行时，
默认 `~/work/personal/spine` 与 `~/.spine/runtime`，`SPINE_REPO` / `SPINE_RUNTIME`
可覆盖）；包由正式 build 脚本真跑 `npm ci` 暂存，真实 node 由 PATH 顶替的合成体替换，
不读生产状态。
