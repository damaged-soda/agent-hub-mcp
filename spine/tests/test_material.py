"""agent-session 质料装配的整体故事：真实骨架 + 真实 build + 合成 node。

需要 spine 检出（环境变量 SPINE_REPO，默认 ~/work/personal/spine）与已自举的
spine 运行时（SPINE_RUNTIME，默认 ~/.spine/runtime；build 用它的 npm 解析依赖）。
包由正式的 build 脚本暂存；PATH 前置的合成 node 顶替真实 node，只替换业务本体，
装配（argv、安装目录、宿主 HOME、信号）全走正式路径。
"""
import argparse
import importlib.util
import json
import os
import pwd
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path

MATERIAL = Path(__file__).resolve().parents[1]  # 本仓的 spine/ 质料目录
# 本仓在 meta 域，spine 骨架检出在 personal 域；SPINE_REPO 可覆盖
SPINE = Path(os.environ.get(
    "SPINE_REPO", Path.home() / "work" / "personal" / "spine")).resolve()


def load_rig():
    if not (SPINE / "tests" / "rig.py").is_file():
        raise AssertionError("spine not found at %s (set SPINE_REPO)" % SPINE)
    spec = importlib.util.spec_from_file_location("spine_rig", SPINE / "tests" / "rig.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build(out):
    """经正式 build 脚本暂存一份包目录。"""
    subprocess.run([str(MATERIAL / "build"), str(out)], check=True,
                   capture_output=True, text=True, timeout=300)
    return Path(out)


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class AgentSessionStoryTest(unittest.TestCase):
    def setUp(self):
        rig_module = load_rig()
        base = Path(tempfile.mkdtemp(prefix="spine-as-"))
        stub_bin = base / "bin"
        stub_bin.mkdir()
        shutil.copy(MATERIAL / "tests" / "fixtures" / "node", stub_bin / "node")
        (stub_bin / "node").chmod(0o755)
        self.record_path = stub_bin / "record.json"
        self.saved_path = os.environ["PATH"]
        os.environ["PATH"] = "%s%s%s" % (stub_bin, os.pathsep, self.saved_path)
        self.rig = rig_module.Rig(base)
        self.base = base

        def cleanup():
            stragglers = self.rig.close()
            os.environ["PATH"] = self.saved_path
            shutil.rmtree(base, ignore_errors=True)
            self.assertEqual(stragglers, [], "processes leaked past close")

        self.addCleanup(cleanup)

    def stage(self):
        return build(self.base / "stage")

    def test_assembly_story(self):
        rig = self.rig
        port = free_port()
        rig.spine_ok(
            "publish", str(self.stage()), "--node", "host=rig",
            "--program-arg", "serve=--port", "--program-arg", "serve=%d" % port,
            "--program-arg", "serve=--public-origin",
            "--program-arg", "serve=http://origin.test")
        rig.wait(lambda: (rig.statuses()["rig"]["materials"]
                          .get("agent-session", {}).get("programs", {})
                          .get("serve") or {}).get("state") == "running",
                 message="serve not running")
        record = rig.wait(
            lambda: json.loads(self.record_path.read_text())
            if self.record_path.exists() else None, message="server not invoked")
        # server 从包内启动：入口在节点安装目录下，工作目录就是安装目录
        entry = Path(record["argv"][0])
        install = (self.base / "rig" / "install").resolve()  # macOS 的 /var 是 /private/var 的别名
        self.assertEqual(entry.parents[1].parent, install, entry)
        self.assertEqual(entry.relative_to(entry.parents[1]),
                         Path("src") / "session-cli.js")
        self.assertEqual(Path(record["cwd"]), entry.parents[1])
        self.assertTrue((entry.parents[1] / "node_modules" / "zod").is_dir(),
                        "production dependencies missing from the package")
        self.assertEqual(record["argv"][1:], [
            "serve", "--host", "127.0.0.1", "--port", str(port),
            "--public-origin", "http://origin.test",
            "--base-path", "/agent-session"])
        self.assertEqual(record["home"], pwd.getpwuid(os.getuid()).pw_dir)
        # 服务在指定回环端口应答
        with urllib.request.urlopen(
                "http://127.0.0.1:%d/agent-session/healthz" % port,
                timeout=5) as response:
            self.assertEqual(response.status, 200)
        # 回环内部服务：不自述 endpoints
        self.assertIsNone(
            rig.statuses()["rig"]["materials"]["agent-session"]["endpoints"])
        # withdraw：服务停、现场回收
        rig.spine_ok("withdraw", "agent-session")
        rig.wait(lambda: "agent-session"
                 not in rig.statuses()["rig"].get("materials", {}),
                 message="withdraw did not recycle")


class BuildTest(unittest.TestCase):
    """build 的产物是一份确定性的 spine 包：同一检出两次暂存摘要相同，且在包上限之内。"""

    def test_build_is_deterministic_and_fits(self):
        sys.path.insert(0, str(SPINE))
        from spine.package import build as package_build
        base = Path(tempfile.mkdtemp(prefix="spine-as-build-"))
        self.addCleanup(shutil.rmtree, base, True)
        first, _ = package_build(build(base / "one"))
        second, sha = package_build(build(base / "two"))
        self.assertEqual(package_build(build(base / "one"))[1], sha)
        self.assertEqual(len(first), len(second))
        for name in ("src/session-cli.js", "src/session-server.js", "serve.py",
                     "material.json", "package-lock.json",
                     "node_modules/@modelcontextprotocol/sdk/package.json"):
            self.assertTrue((base / "one" / name).is_file(), name)
        self.assertFalse((base / "one" / "node_modules" / "vitest").exists(),
                         "dev dependencies leaked into the package")


class ServeArgvTest(unittest.TestCase):
    """旧驾驶舱域名退役后 public-origin 缺省不透传：只有装配显式给出才进 argv。"""

    def setUp(self):
        spec = importlib.util.spec_from_file_location(
            "serve_material", MATERIAL / "serve.py")
        self.serve = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.serve)

    def argv(self, **overrides):
        args = dict(host="127.0.0.1", port="8088", public_origin=None,
                    base_path="/agent-session")
        args.update(overrides)
        return self.serve.server_argv(argparse.Namespace(**args))

    def test_default_omits_public_origin(self):
        self.assertEqual(self.argv(), [
            "node", str(MATERIAL / "src" / "session-cli.js"), "serve",
            "--host", "127.0.0.1", "--port", "8088",
            "--base-path", "/agent-session"])

    def test_explicit_public_origin_passes_through(self):
        self.assertEqual(self.argv(public_origin="https://origin.test"), [
            "node", str(MATERIAL / "src" / "session-cli.js"), "serve",
            "--host", "127.0.0.1", "--port", "8088",
            "--public-origin", "https://origin.test",
            "--base-path", "/agent-session"])


if __name__ == "__main__":
    unittest.main()
