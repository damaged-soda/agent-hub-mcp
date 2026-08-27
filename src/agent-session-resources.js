import path from "node:path";

const PATH_KEYS = ["file_path", "path", "target_path", "destination", "filename"];
const PATH_ARRAY_KEYS = ["files", "referenced_image_paths"];
const PATCH_LINE_SPLIT_RE = /\r?\n|\\r\\n|\\n/;
const PATCH_FILE_LINE_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/;
const SKILL_PATH_RE = /(^|[^A-Za-z0-9._~@%+=:,/\\-])((?:\/|\.\.?\/)?[A-Za-z0-9._~@%+=:,/\\-]+\/SKILL\.md)(?![A-Za-z0-9._~@%+=:,/\\-])/g;
const MAX_RESOURCE_ACCESSES = 128;

export function extractResourceAccesses(input = {}) {
  const toolName = String(input.tool_name ?? "");
  const lowerName = toolName.toLowerCase();
  const argumentsValue = input.arguments ?? null;
  const record = argumentObject(argumentsValue);
  const rawInput = typeof argumentsValue === "string" ? argumentsValue : null;
  const accesses = new Map();

  function add(rawPath, operation, evidence, coverage = "exact", cwd = input.cwd) {
    const normalized = normalizeLiteralPath(rawPath, cwd);
    if (!normalized || !["read", "write"].includes(operation)) return;
    const key = `${operation}\0${normalized}`;
    const priority = { "shell-explicit-operand": 1, "skill-path-literal": 2,
      "patch-header": 3, "structured-path": 4 };
    const previous = accesses.get(key);
    if (previous && priority[previous.evidence] >= priority[evidence]) return;
    accesses.set(key, {
      operation,
      path: normalized,
      resource_kind: path.posix.basename(normalized) === "SKILL.md" ? "skill" : "file",
      evidence,
      coverage,
    });
  }

  const toolKind = classifyTool(toolName);
  const operation = toolKind === "read" || lowerName === "view_image" ? "read" :
    toolKind === "edit" ? "write" : null;
  if (operation) {
    for (const key of PATH_KEYS) add(record[key], operation, "structured-path");
    for (const key of PATH_ARRAY_KEYS) {
      if (!Array.isArray(record[key])) continue;
      for (const value of record[key]) add(value, operation, "structured-path");
    }
  }

  const patchTexts = [rawInput, typeof record.patch === "string" ? record.patch : null]
    .filter(Boolean);
  const patchPaths = new Set();
  for (const value of patchTexts) {
    for (const valuePath of patchTargetPaths(value)) {
      patchPaths.add(valuePath);
      add(valuePath, "write", "patch-header");
    }
  }

  const commandSources = [];
  for (const key of ["cmd", "command", "code"]) {
    if (typeof record[key] === "string") commandSources.push(record[key]);
  }
  if (rawInput) commandSources.push(...embeddedCommandStrings(rawInput));
  for (const command of distinct(commandSources)) {
    for (const valuePath of explicitSkillPaths(command)) {
      if (!patchPaths.has(valuePath)) add(valuePath, "read", "skill-path-literal", "high-confidence");
    }
    for (const valuePath of shellReadPaths(command)) {
      if (!patchPaths.has(valuePath)) add(valuePath, "read", "shell-explicit-operand", "high-confidence");
    }
  }

  return [...accesses.values()]
    .sort((left, right) => left.operation.localeCompare(right.operation) || left.path.localeCompare(right.path))
    .slice(0, MAX_RESOURCE_ACCESSES);
}

export function patchTargetPaths(value) {
  if (typeof value !== "string" || !value.includes("*** Begin Patch")) return [];
  const values = [];
  for (const line of value.split(PATCH_LINE_SPLIT_RE)) {
    const match = PATCH_FILE_LINE_RE.exec(line.trim());
    const candidate = match?.[1] ?? match?.[2];
    if (candidate) values.push(candidate.trim());
  }
  return distinct(values);
}

export function explicitSkillPaths(value) {
  if (typeof value !== "string") return [];
  const values = [];
  for (const match of value.matchAll(SKILL_PATH_RE)) values.push(match[2]);
  return distinct(values);
}

export function shellReadPaths(command) {
  if (typeof command !== "string" || !command.trim()) return [];
  const tokens = shellTokens(command);
  const values = [];
  for (const segment of commandSegments(tokens)) {
    const prepared = commandTokens(segment);
    if (prepared.length === 0) continue;
    const name = path.posix.basename(prepared[0]);
    const args = prepared.slice(1);
    if (["cat", "head", "tail", "wc"].includes(name)) {
      values.push(...simpleFileOperands(name, args));
    } else if (name === "sed") {
      values.push(...sedFileOperands(args));
    } else if (["rg", "grep"].includes(name)) {
      values.push(...searchFileOperands(args));
    } else if (name === "git" && ["show", "diff"].includes(args[0])) {
      const separator = args.indexOf("--");
      if (separator >= 0) values.push(...args.slice(separator + 1));
    }
    for (let index = 0; index < segment.length - 1; index += 1) {
      if (segment[index] === "<") values.push(segment[index + 1]);
    }
  }
  return distinct(values.filter(isLiteralFileOperand));
}

function simpleFileOperands(name, args) {
  const values = [];
  const consumes = new Set(name === "head" || name === "tail" ? ["-n", "--lines", "-c", "--bytes"] : []);
  let options = true;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (options && token === "--") { options = false; continue; }
    if (options && consumes.has(token)) { index += 1; continue; }
    if (options && token.startsWith("-")) continue;
    values.push(token);
  }
  return values;
}

function sedFileOperands(args) {
  const values = [];
  let scriptSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--") {
      const remaining = args.slice(index + 1);
      if (!scriptSeen && remaining.length > 0) remaining.shift();
      values.push(...remaining);
      break;
    }
    if (["-e", "--expression"].includes(token)) { scriptSeen = true; index += 1; continue; }
    if (["-f", "--file"].includes(token)) { index += 1; if (args[index]) values.push(args[index]); continue; }
    if (token.startsWith("-")) continue;
    if (!scriptSeen) { scriptSeen = true; continue; }
    values.push(token);
  }
  return values;
}

function searchFileOperands(args) {
  const valueOptions = new Set([
    "-g", "--glob", "-t", "--type", "-T", "--type-not", "-m", "--max-count",
    "-A", "--after-context", "-B", "--before-context", "-C", "--context", "-e", "--regexp",
  ]);
  const positional = [];
  let options = true;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (options && token === "--") { options = false; continue; }
    if (options && valueOptions.has(token)) { index += 1; continue; }
    if (options && token.startsWith("-")) continue;
    positional.push(token);
  }
  if (positional.length <= 1) return [];
  return positional.slice(1).filter(looksLikeFilePath);
}

function looksLikeFilePath(value) {
  return typeof value === "string" && value !== "." && value !== ".." &&
    (value.includes("/") || /\.[A-Za-z0-9_-]{1,16}$/.test(value));
}

function isLiteralFileOperand(value) {
  return typeof value === "string" && value.trim() && value !== "-" && !value.includes("://") &&
    !/[\0\r\n$*?\[\]{}]/.test(value) && !value.startsWith(">");
}

function normalizeLiteralPath(value, cwd) {
  if (!isLiteralFileOperand(value)) return null;
  const trimmed = value.trim();
  if (path.posix.isAbsolute(trimmed)) return path.posix.normalize(trimmed);
  if (typeof cwd === "string" && path.posix.isAbsolute(cwd)) return path.posix.resolve(cwd, trimmed);
  return path.posix.normalize(trimmed);
}

function argumentObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function embeddedCommandStrings(value) {
  if (typeof value !== "string") return [];
  const strings = [];
  const pattern = /(?:["']?(?:cmd|command)["']?)\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g;
  for (const match of value.matchAll(pattern)) {
    const decoded = decodeJsString(match[1]);
    if (decoded) strings.push(decoded);
  }
  return strings;
}

function decodeJsString(value) {
  if (value.startsWith('"')) {
    try { return JSON.parse(value); } catch { return null; }
  }
  const body = value.slice(1, -1);
  return body.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")
    .replace(/\\(['`\\])/g, "$1");
}

function shellTokens(value) {
  const tokens = [];
  let token = "";
  let quote = null;
  const flush = () => { if (token) tokens.push(token); token = ""; };
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < value.length) token += value[++index];
      else token += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "\\" && index + 1 < value.length) { token += value[++index]; continue; }
    if (/\s/.test(char)) { flush(); if (char === "\n") tokens.push(";"); continue; }
    if ([";", "|", "&", "<", ">"].includes(char)) {
      flush();
      const pair = value.slice(index, index + 2);
      if (["&&", "||", ">>", "<<"].includes(pair)) { tokens.push(pair); index += 1; }
      else tokens.push(char);
      continue;
    }
    token += char;
  }
  flush();
  return tokens;
}

function commandSegments(tokens) {
  const segments = [];
  let current = [];
  for (const token of tokens) {
    if ([";", "|", "||", "&&"].includes(token)) {
      if (current.length) segments.push(current);
      current = [];
    } else current.push(token);
  }
  if (current.length) segments.push(current);
  return segments;
}

function commandTokens(segment) {
  const values = [];
  for (let index = 0; index < segment.length; index += 1) {
    if (["<", ">", ">>", "<<"].includes(segment[index])) { index += 1; continue; }
    values.push(segment[index]);
  }
  while (values.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(values[0])) values.shift();
  if (path.posix.basename(values[0] ?? "") === "env") {
    values.shift();
    while (values.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(values[0]) || values[0].startsWith("-"))) values.shift();
  }
  return values;
}

function classifyTool(name) {
  const value = String(name ?? "").toLowerCase();
  if (/bash|shell|exec|command/.test(value)) return "shell";
  if (/edit|write|patch|file_change/.test(value)) return "edit";
  if (/read|fetch/.test(value)) return "read";
  return "other";
}

function distinct(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}
