import fs from "node:fs";
import path from "node:path";

const PATH_KEYS = ["file_path", "path", "target_path", "destination", "filename"];
const PATH_ARRAY_KEYS = ["files", "referenced_image_paths"];
const PATCH_LINE_SPLIT_RE = /\r?\n|\\+(?:r\\+n|n)/;
const PATCH_FILE_LINE_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/;
const SKILL_PATH_RE = /(^|[^A-Za-z0-9._~@%+=:,/\\-])((?:\/|\.\.?\/)?[A-Za-z0-9._~@+=:,/\\-]+\/SKILL\.md)(?![A-Za-z0-9._~@%+=:,/\\-])/g;
const MAX_RESOURCE_ACCESSES = 128;
const MAX_EMBEDDED_COMMAND_CHARS = 256 * 1024;
const MAX_SHELL_WRAPPER_DEPTH = 4;
const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const HEREDOC_START_RE = /(^|[^<])<<(-?)[ \t]*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/g;

export function extractResourceAccesses(input = {}) {
  const toolName = String(input.tool_name ?? "");
  const lowerName = toolName.toLowerCase();
  const argumentsValue = input.arguments ?? null;
  const record = argumentObject(argumentsValue);
  const rawInput = typeof argumentsValue === "string" ? argumentsValue : null;
  const effectiveCwd = typeof record.workdir === "string" && path.posix.isAbsolute(record.workdir)
    ? record.workdir
    : input.cwd;
  const accesses = new Map();

  function add(rawPath, operation, evidence, coverage = "exact", cwd = effectiveCwd) {
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
    for (const valuePath of shellReadPaths(command, effectiveCwd)) {
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

export function shellReadPaths(command, cwd = null) {
  return shellReadPathsAtDepth(command, cwd, 0);
}

function shellReadPathsAtDepth(command, cwd, depth) {
  if (typeof command !== "string" || !command.trim()) return [];
  const values = [];
  let activeCwd = cwd;
  for (const line of shellCommandLines(command)) {
    for (const segment of commandSegments(shellTokens(line))) {
      const prepared = commandTokens(segment);
      if (prepared.length === 0) continue;
      const name = path.posix.basename(prepared[0]);
      const args = prepared.slice(1);
      const nested = shellCommandPayload(name, args);
      if (nested !== null) {
        if (depth < MAX_SHELL_WRAPPER_DEPTH) {
          values.push(...shellReadPathsAtDepth(nested, activeCwd, depth + 1));
        }
        continue;
      }
      if (name === "cd") {
        const target = args.find((item) => !item.startsWith("-"));
        activeCwd = target ? normalizeLiteralPath(target, activeCwd) : null;
        continue;
      }
      const candidates = [];
      if (["cat", "head", "tail", "wc", "nl"].includes(name)) {
        candidates.push(...simpleFileOperands(name, args));
      } else if (name === "sed") {
        candidates.push(...sedFileOperands(args));
      } else if (["rg", "grep"].includes(name)) {
        candidates.push(...searchFileOperands(args, activeCwd));
      } else if (name === "git" && ["show", "diff"].includes(args[0])) {
        const separator = args.indexOf("--");
        if (separator >= 0) {
          candidates.push(...args.slice(separator + 1)
            .filter((value) => looksLikeFilePath(value, activeCwd)));
        }
      }
      for (let index = 0; index < segment.length - 1; index += 1) {
        if (segment[index] === "<" && isLiteralFileOperand(segment[index + 1])) {
          candidates.push(segment[index + 1]);
        }
      }
      for (const candidate of candidates) {
        const normalized = normalizeLiteralPath(candidate, activeCwd);
        if (normalized) values.push(normalized);
      }
    }
  }
  return distinct(values);
}

function shellCommandPayload(name, args) {
  if (!SHELL_WRAPPERS.has(name)) return null;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--") return null;
    const commandFlag = token === "-c" ||
      (/^-[^-]+$/.test(token) && token.slice(1).includes("c"));
    if (!commandFlag) continue;
    const payload = args[index + 1];
    return typeof payload === "string" && payload.length <= MAX_EMBEDDED_COMMAND_CHARS
      ? payload
      : null;
  }
  return null;
}

function simpleFileOperands(name, args) {
  const values = [];
  const consumes = new Set(
    name === "head" || name === "tail"
      ? ["-n", "--lines", "-c", "--bytes"]
      : name === "nl"
        ? [
            "-b", "--body-numbering", "-d", "--section-delimiter",
            "-f", "--footer-numbering", "-h", "--header-numbering",
            "-i", "--line-increment", "-l", "--join-blank-lines",
            "-n", "--number-format", "-s", "--number-separator",
            "-v", "--starting-line-number", "-w", "--number-width",
          ]
        : [],
  );
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
    if (token === "") continue;
    if (token === "--") {
      const remaining = args.slice(index + 1);
      if (!scriptSeen && remaining.length > 0) remaining.shift();
      values.push(...remaining);
      break;
    }
    if (["-e", "--expression"].includes(token)) { scriptSeen = true; index += 1; continue; }
    if (token.startsWith("--expression=") || (token.startsWith("-e") && token !== "-e")) {
      scriptSeen = true;
      continue;
    }
    if (["-f", "--file"].includes(token)) { index += 1; if (args[index]) values.push(args[index]); continue; }
    if (token.startsWith("--file=")) { values.push(token.slice("--file=".length)); continue; }
    if (token === "-i" && args[index + 1] === "") { index += 1; continue; }
    if (token.startsWith("-")) continue;
    if (!scriptSeen) { scriptSeen = true; continue; }
    values.push(token);
  }
  return values;
}

function searchFileOperands(args, cwd) {
  const valueOptions = new Set([
    "-g", "--glob", "-t", "--type", "-T", "--type-not", "-m", "--max-count",
    "-A", "--after-context", "-B", "--before-context", "-C", "--context", "-e", "--regexp",
  ]);
  const positional = [];
  let explicitPattern = false;
  let options = true;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (options && token === "--") { options = false; continue; }
    if (options && valueOptions.has(token)) {
      if (["-e", "--regexp"].includes(token)) explicitPattern = true;
      index += 1;
      continue;
    }
    if (options && token.startsWith("-")) continue;
    positional.push(token);
  }
  if (positional.length === 0 || (!explicitPattern && positional.length <= 1)) return [];
  return (explicitPattern ? positional : positional.slice(1))
    .filter((value) => looksLikeFilePath(value, cwd));
}

function looksLikeFilePath(value, cwd) {
  if (typeof value !== "string" || value === "." || value === ".." || value.endsWith("/")) {
    return false;
  }
  const normalized = normalizeLiteralPath(value, cwd);
  if (!normalized) return false;
  try {
    return fs.statSync(normalized).isFile();
  } catch {
    return /\.[A-Za-z0-9_-]{1,16}$/.test(path.posix.basename(value));
  }
}

function isLiteralFileOperand(value) {
  return typeof value === "string" && value.trim() && value !== "-" && !value.includes("://") &&
    !/[\0\r\n$*?\[\]{}@]/.test(value) && !/^\d+$/.test(value) &&
    !value.startsWith(">") && !value.startsWith("<") && !value.startsWith("&") &&
    !value.startsWith("(") && !value.startsWith("~");
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
    if (decoded) strings.push(decoded.slice(0, MAX_EMBEDDED_COMMAND_CHARS));
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
      const triple = value.slice(index, index + 3);
      if (triple === "<<<") { tokens.push(triple); index += 2; continue; }
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

function* shellCommandLines(value) {
  const pending = [];
  let suppressRemainder = false;
  for (const line of value.split(/\r?\n/)) {
    if (pending.length > 0) {
      const [delimiter, stripTabs] = pending[0];
      if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) pending.shift();
      continue;
    }
    if (suppressRemainder) continue;
    const matches = [...line.matchAll(HEREDOC_START_RE)];
    if (line.replaceAll("<<<", "").includes("<<") && matches.length === 0) {
      suppressRemainder = true;
    }
    for (const match of matches) {
      pending.push([match[3] ?? match[4] ?? match[5], match[2] === "-"]);
    }
    yield line;
  }
}

function commandSegments(tokens) {
  const segments = [];
  let current = [];
  for (const token of tokens) {
    if ([";", "|", "||", "&&", "&"].includes(token)) {
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
    if (/^(?:[<>]+&?|&>>?)$/.test(segment[index])) {
      if (/^\d+$/.test(values.at(-1) ?? "")) values.pop();
      index += 1;
      continue;
    }
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
