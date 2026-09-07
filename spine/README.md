# spine 质料：agent-session 的 personal 域接线

`serve` 程序 exec 成本仓安装的 `agent-session serve`（回环 8088），由
personal 域的 spine 骨架看护（唯一保活者）——与已退役的 cockpit-agent-session
包装脚本同构（纯迁移）。会话解析与投影、二进制安装与升级（`npm run
install:local`）仍归本仓；本目录只持运行接线，是本仓里唯一的 personal 域
部署内容，不进 npm 包（package.json files 白名单外）。

- 宿主 HOME 还原（provider 原生会话库按它定位）；homebrew PATH 追加而非前置。
- `--public-origin` 暂沿用旧驾驶舱域名（消费者全走回环不受影响；将来新域名
  反代要换参数重新 publish，否则 Host/Origin 校验 403）。
- 回环内部服务不自述 endpoints；已知残余：sqlite3 缺失时不再启动即失败，
  接受为 OpenCode provider 局部降级（汇总带 source_errors 可见）。

生产：`~/.spine/runtime/bin/spine publish ~/work/meta/agent-hub-mcp/spine \
--nats nats://100.109.38.77:4222 --node host=macmini`（默认参数即旧接线）。
切换先 `launchctl bootout gui/$UID/com.leavan.cockpit-agent-session` 防双跑。

测试：`spine/tests/run`（需要 Python 3.12、nats-server 与 spine 检出，默认
`~/work/personal/spine`，`SPINE_REPO` 可覆盖）；真实 server 由 PATH 顶替的
合成体替换，不读生产状态。
