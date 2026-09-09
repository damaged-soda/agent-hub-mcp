#!/usr/bin/env python3
"""agent-session 服务质料：spine 是唯一保活者，本程序 exec 成包内的 Agent Hub
session server。

包由 spine/build 暂存：本仓 src、package.json、package-lock.json、生产依赖，加本文件
与 material.json。摘要覆盖 Agent Hub 的真实代码，升级 = 合 PR → build → publish，
节点按摘要变化停旧起新。node 来自 spine 钉版本的运行时，已在程序 PATH 前置。
个人域接线：宿主 HOME（provider 原生会话库按它定位）、回环 8088。消费者：
spine-session 页的同源转发与 spine-agent 的 collect，均在本机。无对外地址，
不自述 endpoints；旧驾驶舱域名已退役，缺省不设 public-origin，服务只认回环
Host/Origin。--nats 收下不用（心跳由骨架代发）。
"""
import argparse
import os
import pwd
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent  # 安装目录：包内 src 与 node_modules 都在这里


def server_argv(args):
    """装配 session server 的 argv：public-origin 仅在装配显式给出时透传。"""
    argv = ["node", str(HERE / "src" / "session-cli.js"), "serve",
            "--host", args.host, "--port", args.port]
    if args.public_origin:
        argv += ["--public-origin", args.public_origin]
    argv += ["--base-path", args.base_path]
    return argv


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--nats", required=True, help="骨架统一传入；本程序不连中枢")
    parser.add_argument("--host", default="127.0.0.1",
                        help="只绑回环；跨机消费走 spine-session 的同源转发")
    parser.add_argument("--port", default="8088")
    parser.add_argument("--public-origin", default=None,
                        help="可信反代的精确 HTTPS Origin；缺省不设，只认回环 Host/Origin")
    parser.add_argument("--base-path", default="/agent-session")
    args = parser.parse_args()
    # 骨架把 HOME 指到质料状态目录；session server 按宿主家目录读各 provider
    # 的原生会话库（~/.claude、~/.codex …）
    os.environ["HOME"] = pwd.getpwuid(os.getuid()).pw_dir
    argv = server_argv(args)
    os.execvp(argv[0], argv)


if __name__ == "__main__":
    sys.exit(main())
