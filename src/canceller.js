#!/usr/bin/env node

const pgid = Number.parseInt(process.argv[2], 10);
const graceMs = Number.parseInt(process.argv[3] ?? "10000", 10);

if (!Number.isInteger(pgid) || pgid <= 0) {
  process.exit(0);
}

signalProcessGroup(pgid, "SIGTERM");

setTimeout(() => {
  if (isProcessGroupAlive(pgid)) {
    signalProcessGroup(pgid, "SIGKILL");
  }
  process.exit(0);
}, graceMs);

function signalProcessGroup(targetPgid, signal) {
  try {
    process.kill(-targetPgid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      process.exitCode = 1;
    }
  }
}

function isProcessGroupAlive(targetPgid) {
  try {
    process.kill(-targetPgid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
