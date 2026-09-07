#!/usr/bin/env python3
"""agent-session 服务质料：spine 是唯一保活者，本程序 exec 成 Agent Hub 的
session server。

会话解析与投影的权威是 Agent Hub（meta 域仓 agent-hub-mcp，经 npm run
install:local 安装到 homebrew PATH）；本仓只持个人域接线——与旧
cockpit-agent-session 包装脚本同构（纯迁移）：宿主 HOME（provider 原生会话
库按它定位）、homebrew PATH、回环 8088。消费者：spine-session 页的同源
转发与 spine-agent 的 collect，均在本机。无对外地址，不自述 endpoints。
--nats 收下不用（心跳由骨架代发）。
"""
import argparse
import os
import pwd
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--nats", required=True, help="骨架统一传入；本程序不连中枢")
    parser.add_argument("--host", default="127.0.0.1",
                        help="只绑回环；跨机消费走 spine-session 的同源转发")
    parser.add_argument("--port", default="8088")
    parser.add_argument("--public-origin", default="https://cockpit.tail54dd1c.ts.net",
                        help="沿用旧接线；旧驾驶舱域名退役时随 publish 换参数")
    parser.add_argument("--base-path", default="/agent-session")
    args = parser.parse_args()
    # 骨架把 HOME 指到质料状态目录；session server 按宿主家目录读各 provider
    # 的原生会话库（~/.claude、~/.codex …）
    os.environ["HOME"] = pwd.getpwuid(os.getuid()).pw_dir
    # homebrew 追加而非前置：节点 PATH 本来没有它，追加即可解析；
    # 前置会在测试里压过 PATH 顶替的合成体
    os.environ["PATH"] = (os.environ.get("PATH", "")
                          + ":/opt/homebrew/bin:/usr/local/bin")
    os.execvp("agent-session", [
        "agent-session", "serve",
        "--host", args.host,
        "--port", args.port,
        "--public-origin", args.public_origin,
        "--base-path", args.base_path,
    ])


if __name__ == "__main__":
    sys.exit(main())
