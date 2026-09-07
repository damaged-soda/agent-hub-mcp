"""agent-session 质料装配的整体故事：真实骨架 + 合成 session server。

需要 spine 检出（环境变量 SPINE_REPO，或同级目录 ../spine）。
真实 agent-session 由 PATH 前置的合成体顶替：只替换业务本体，装配
（argv、宿主 HOME、PATH、信号）全走正式路径。
"""
import importlib.util
import json
import os
import pwd
import shutil
import socket
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
        shutil.copy(MATERIAL / "tests" / "fixtures" / "agent-session",
                    stub_bin / "agent-session")
        (stub_bin / "agent-session").chmod(0o755)
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
        stage = self.base / "stage"
        stage.mkdir(exist_ok=True)
        for name in ("material.json", "serve.py"):
            shutil.copy(MATERIAL / name, stage / name)
        return stage

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
        # 装配 = 旧 cockpit-agent-session 包装脚本的纯迁移
        self.assertEqual(record["argv"], [
            "serve", "--host", "127.0.0.1", "--port", str(port),
            "--public-origin", "http://origin.test",
            "--base-path", "/agent-session"])
        self.assertEqual(record["home"], pwd.getpwuid(os.getuid()).pw_dir)
        self.assertIn("/opt/homebrew/bin", record["path"])
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


if __name__ == "__main__":
    unittest.main()
