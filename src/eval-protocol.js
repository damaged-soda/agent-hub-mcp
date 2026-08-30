import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./adapter-utils.js";

export const EVAL_SUITE_RELATIVE_PATH = ".agenthub/evals.json";
export const EVAL_SUITE_SCHEMA_VERSION = 1;
export const SOURCE_LOCATION_SCHEMA = "source-location/v1";
export const SOURCE_LOCATION_GRADER_VERSION = "source-location/v1";
export const EVAL_EXECUTION_PROFILE = "workspace-readonly/v1";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_CASES = 100;
const MAX_PROMPT_BYTES = 64 * 1024;

export async function loadEvalSuite(cwd, suitePath = undefined) {
  const workspace = await realDirectory(cwd, "eval cwd");
  const candidate = path.resolve(workspace, suitePath ?? EVAL_SUITE_RELATIVE_PATH);
  const suiteFile = await realFile(candidate, "eval suite");
  if (!isInside(suiteFile, workspace)) {
    throw evalError("invalid_eval_suite", "Eval suite must be inside the evaluated workspace");
  }

  let document;
  try {
    document = JSON.parse(await fsp.readFile(suiteFile, "utf8"));
  } catch (error) {
    throw evalError(
      "invalid_eval_suite",
      `Eval suite is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const suite = normalizeSuite(document);
  return {
    ...suite,
    path: suiteFile,
    relative_path: slashPath(path.relative(workspace, suiteFile)),
    digest: canonicalHash(suite),
  };
}

export function normalizeSuite(value) {
  if (!plainObject(value)) {
    throw evalError("invalid_eval_suite", "Eval suite must be a JSON object");
  }
  if (value.schema_version !== EVAL_SUITE_SCHEMA_VERSION) {
    throw evalError(
      "invalid_eval_suite",
      `Eval suite schema_version must be ${EVAL_SUITE_SCHEMA_VERSION}`,
    );
  }
  const suiteId = identifier(value.suite_id, "suite_id");
  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    throw evalError("invalid_eval_suite", "Eval suite cases must be a non-empty array");
  }
  if (value.cases.length > MAX_CASES) {
    throw evalError("invalid_eval_suite", `Eval suite may contain at most ${MAX_CASES} cases`);
  }
  const seen = new Set();
  const cases = value.cases.map((item, index) => {
    if (!plainObject(item)) {
      throw evalError("invalid_eval_suite", `cases[${index}] must be an object`);
    }
    const id = identifier(item.id, `cases[${index}].id`);
    if (seen.has(id)) {
      throw evalError("invalid_eval_suite", `Duplicate eval case id: ${id}`);
    }
    seen.add(id);
    if (typeof item.prompt !== "string" || item.prompt.trim() === "") {
      throw evalError("invalid_eval_suite", `cases[${index}].prompt must be non-empty`);
    }
    if (Buffer.byteLength(item.prompt, "utf8") > MAX_PROMPT_BYTES) {
      throw evalError(
        "invalid_eval_suite",
        `cases[${index}].prompt exceeds ${MAX_PROMPT_BYTES} bytes`,
      );
    }
    if (item.answer_schema !== SOURCE_LOCATION_SCHEMA) {
      throw evalError(
        "invalid_eval_suite",
        `cases[${index}].answer_schema must be ${SOURCE_LOCATION_SCHEMA}`,
      );
    }
    const unknown = Object.keys(item).filter(
      (key) => !new Set(["id", "prompt", "answer_schema"]).has(key),
    );
    if (unknown.length > 0) {
      throw evalError(
        "invalid_eval_suite",
        `cases[${index}] contains unsupported fields: ${unknown.sort().join(", ")}`,
      );
    }
    const normalized = {
      id,
      prompt: item.prompt.trim(),
      answer_schema: SOURCE_LOCATION_SCHEMA,
    };
    return {
      ...normalized,
      question_digest: canonicalHash(normalized),
    };
  });
  const unknown = Object.keys(value).filter(
    (key) => !new Set(["schema_version", "suite_id", "cases"]).has(key),
  );
  if (unknown.length > 0) {
    throw evalError(
      "invalid_eval_suite",
      `Eval suite contains unsupported fields: ${unknown.sort().join(", ")}`,
    );
  }
  return {
    schema_version: EVAL_SUITE_SCHEMA_VERSION,
    suite_id: suiteId,
    cases,
  };
}

export async function normalizeExpectedSourceLocation(value, cwd) {
  const normalized = normalizeSourceLocationShape(value, "standard answer");
  const workspace = await realDirectory(cwd, "eval cwd");
  const candidate = path.resolve(workspace, normalized.path);
  if (!isInside(candidate, workspace)) {
    throw evalError("invalid_eval_answer", "Standard answer path must stay inside the workspace");
  }
  const source = await realFile(candidate, "standard answer path").catch((error) => {
    throw evalError("invalid_eval_answer", error.message);
  });
  if (!isInside(source, workspace)) {
    throw evalError("invalid_eval_answer", "Standard answer path resolves outside the workspace");
  }
  const text = await fsp.readFile(source, "utf8");
  const lineCount = text === ""
    ? 0
    : (text.match(/\n/g)?.length ?? 0) + (text.endsWith("\n") ? 0 : 1);
  if (normalized.definition_line > lineCount) {
    throw evalError(
      "invalid_eval_answer",
      `Standard answer definition_line exceeds the file's ${lineCount} lines`,
    );
  }
  return {
    ...normalized,
    path: slashPath(path.relative(workspace, source)),
  };
}

export function parseSourceLocationOutput(text) {
  let value;
  try {
    value = JSON.parse(String(text ?? "").trim());
  } catch {
    throw evalError("invalid_agent_output", "Agent output is not one JSON object");
  }
  return normalizeSourceLocationShape(value, "agent output");
}

export function gradeSourceLocation(expected, actual) {
  return (
    expected.path === actual.path &&
    expected.symbol === actual.symbol &&
    expected.definition_line === actual.definition_line
  );
}

export function buildEvalPrompt(item) {
  return `${item.prompt}\n\n[Agent Hub Eval output contract]\nReturn only one JSON object with exactly these fields:\n{"path":"repository/relative/file","symbol":"qualified_symbol","definition_line":1}\nUse a repository-relative path and the 1-based line containing the symbol definition. Do not include Markdown fences or explanation.`;
}

export function answerDigest(answer) {
  return canonicalHash(answer);
}

export async function cleanWorkspaceSnapshot(cwd) {
  const workspace = await realDirectory(cwd, "eval cwd");
  const rootResult = await git(workspace, ["rev-parse", "--show-toplevel"]);
  const root = await realDirectory(rootResult.stdout.trim(), "Git worktree root");
  if (root !== workspace) {
    throw evalError("invalid_eval_workspace", "Eval cwd must be the Git worktree root");
  }
  const status = await git(workspace, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.stdout !== "") {
    throw evalError(
      "dirty_eval_workspace",
      "Eval workspace must be clean so one immutable commit defines the subject",
    );
  }
  const commitResult = await git(workspace, ["rev-parse", "HEAD"]);
  const commit = commitResult.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) {
    throw evalError("invalid_eval_workspace", "Git HEAD did not resolve to a commit hash");
  }
  return {
    root: workspace,
    commit,
    workspace_digest: canonicalHash({ kind: "git-commit", commit }),
  };
}

export function sameWorkspaceSnapshot(left, right) {
  return (
    left?.root === right?.root &&
    left?.commit === right?.commit &&
    left?.workspace_digest === right?.workspace_digest
  );
}

export function canonicalHash(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function evalError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeSourceLocationShape(value, label) {
  const errorCode = label === "agent output" ? "invalid_agent_output" : "invalid_eval_answer";
  if (!plainObject(value)) {
    throw evalError(errorCode, `${label} must be an object`);
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = ["definition_line", "path", "symbol"];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw evalError(
      errorCode,
      `${label} must contain exactly path, symbol, and definition_line`,
    );
  }
  if (typeof value.path !== "string" || value.path.trim() === "") {
    throw evalError(
      errorCode,
      `${label} path must be non-empty`,
    );
  }
  const rawPath = slashPath(value.path.trim());
  const normalizedPath = path.posix.normalize(rawPath);
  if (
    normalizedPath === "." ||
    path.posix.isAbsolute(normalizedPath) ||
    normalizedPath === ".." ||
    normalizedPath.startsWith("../")
  ) {
    throw evalError(
      errorCode,
      `${label} path must be repository-relative`,
    );
  }
  if (typeof value.symbol !== "string" || value.symbol.trim() === "") {
    throw evalError(
      errorCode,
      `${label} symbol must be non-empty`,
    );
  }
  if (!Number.isSafeInteger(value.definition_line) || value.definition_line <= 0) {
    throw evalError(
      errorCode,
      `${label} definition_line must be a positive integer`,
    );
  }
  return {
    path: normalizedPath,
    symbol: value.symbol.trim(),
    definition_line: value.definition_line,
  };
}

async function git(cwd, args) {
  const result = await runCommand("git", args, {
    cwd,
    env: process.env,
    timeoutMs: 10000,
    maxOutputBytes: 4 * 1024 * 1024,
  });
  if (result.error || result.code !== 0) {
    const detail = result.error?.message ?? result.stderr.trim() ?? `exit ${result.code}`;
    throw evalError("invalid_eval_workspace", `Git inspection failed: ${detail}`);
  }
  return result;
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw evalError(
      "invalid_eval_suite",
      `${label} must match ${ID_PATTERN.source}`,
    );
  }
  return value;
}

async function realDirectory(target, label) {
  const real = await fsp.realpath(path.resolve(target)).catch((error) => {
    throw evalError("invalid_eval_workspace", `${label} is unavailable: ${error.message}`);
  });
  const stat = await fsp.stat(real);
  if (!stat.isDirectory()) {
    throw evalError("invalid_eval_workspace", `${label} must be a directory`);
  }
  return real;
}

async function realFile(target, label) {
  const real = await fsp.realpath(path.resolve(target)).catch((error) => {
    throw evalError("invalid_eval_suite", `${label} is unavailable: ${error.message}`);
  });
  const stat = await fsp.stat(real);
  if (!stat.isFile()) {
    throw evalError("invalid_eval_suite", `${label} must be a regular file`);
  }
  return real;
}

function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function slashPath(value) {
  return value.replaceAll(path.sep, "/").replaceAll("\\", "/");
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
