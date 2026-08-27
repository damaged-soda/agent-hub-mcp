# Agent Session Core

`src/agent-session-core.js` defines the provider-neutral, read-only projection contract shared by
Agent Hub execution adapters, the local session inspector, and telemetry consumers. It does
not own an agent process, native transcript, cache, database, retention policy, or UI.

## Authority boundary

```text
native agent CLI / app ──writes──> native session evidence
                                      │
                                      ▼
                              agent-session-core
                               pure projections
                                /     |      \
                       Agent Hub  inspector  telemetry
                       execution  no-store   metadata-only
```

- The native provider remains the writer of its session and transcript.
- Agent Hub remains the writer of run state, CLI session leases, and Discussions.
- Cockpit remains the writer of normalized source, watermarks, and the long-term SQLite archive.
- An inspector is only a reader. It must not clean up stores, repair state, launch model probes, or
  persist a second session registry.

The canonical session identity is `provider + native_session_id`. Agent Hub `run_id` and
`discussion_id` are optional associations, not part of the session key.

## Contract

The v1 event schema is `schemas/agent-session-event-v1.schema.json`. Every event has:

- `provider`: `claude`, `codex`, or `kimi`;
- `native_session_id`: provider id, or `null` until a provider reports one;
- `sequence`, `kind`, `occurred_at`, and provider-neutral `data`;
- provenance with a stage and source;
- optional `truncation` metadata on bounded inspect events.

Within schema v1, new optional fields are additive. Consumers validating a vendored schema must
update that schema before accepting producers that use newly added optional fields.

Provenance stages deliberately keep context values separate:

- `requested`: caller intent, such as Agent Hub request metadata;
- `launched`: effective command or process configuration;
- `observed`: value reported by the running provider;
- `inferred`: derived from evidence but not directly reported;
- `unknown`: the evidence does not establish a value.

Consumers must not collapse these stages into one “effective” value without showing provenance.
For example, Claude `system/init` can directly observe tools and permission mode, while Codex or
Kimi may leave the same fields unknown.

Provider conformance inputs live under `fixtures/agent-session/` and ship with the package so other
consumers can test their projections against the same raw evidence without importing Agent Hub run
state.

## Content profiles

`projectLiveStream` supports two projections:

- `inspect`: keeps visible assistant text, tool arguments, tool results, and normalized provider
  context for an explicit local inspection request. Thinking blocks are never projected. Long
  strings, arrays, objects, and nesting are bounded; truncated events carry field paths plus
  original and retained sizes/counts.
- `metadata`: removes message text, full tool arguments/results, result/error text, and private
  plugin paths while retaining byte counts, structural metadata, and normalized resource paths
  derived from explicit file operands.

`metadata` is a safe common baseline, not a replacement for Cockpit's stricter source projection.
Cockpit may retain fewer fields and remains responsible for its own fail-loud redaction tests.

Tool-call events may carry `resource_accesses[]`. Each row records `read|write`, normalized path,
`file|skill`, evidence, and coverage. The extractor only accepts structured path fields, patch
headers, explicit `SKILL.md` literals, and bounded adapters for literal operands of
`sed/cat/head/tail/wc` plus explicit file operands of `rg/grep` and `git show/diff --`. Variables,
globs, directory-wide searches, and indirect process I/O remain unknown rather than being guessed.
The access stays on the exact tool-call sequence so an inspector can audit which step touched it.
Shell write commands are intentionally outside this bounded adapter set; writes are currently
reported only from structured write tools and patch headers.

## Adapter facets and read API

Live JSONL normalization centralizes session-ref extraction and progress summaries already used by
Agent Hub. The separate transcript facet understands provider-native Claude Code, Codex, and Kimi
Code evidence without making Agent Hub the session owner.

The daemon-free `agent-session` CLI is the stable read surface:

```text
agent-session list [--provider ...] [--limit ...]
agent-session inspect --provider ... --session-id ...
  [--profile metadata|inspect] [--after ...] [--limit ...]
agent-session serve [--host 127.0.0.1] [--port 8765]
  [--public-origin https://cockpit.example.ts.net] [--base-path /agent-session]
  [--frame-origin https://preview.example.ts.net:24443]
```

`list` derives identity from provider-native stores. Its nullable, bounded `title` is copied only
from provider-written title metadata (Codex's session index, Claude's `ai-title`, or Kimi's session
state); it never derives a fallback from prompt text or launches a model call. A native title can
still summarize a sensitive topic, so the list remains part of the private inspector surface.
`inspect` uses normalized event sequence cursors, defaults to `metadata`, and requires an explicit
`--profile inspect` to return transcript bodies. Neither command accepts arbitrary source paths or
mutates provider/session state.

`serve` exposes the same list/inspect contract and the static inspector UI on loopback only. It
does not add a database or background coordinator. Responses are `no-store`, cross-origin browser
requests are rejected, and the private UI explicitly requests bounded `inspect` by default while
retaining a metadata switch.
An optional exact HTTPS `public-origin` may admit Host/Origin values from a trusted reverse proxy;
the process still refuses non-literal loopback bind addresses.
An optional `base-path` moves the complete UI/API surface under one path prefix without changing
the native session roots, content profiles, or authorization boundary. Because the parent already
shares that origin and can call the API directly, base-path mode permits only same-origin framing;
root mode remains non-embeddable.
For an explicitly authorized private preview, `frame-origin` may replace `self` with one exact HTTPS
ancestor only when a non-root base path is configured. It does not change Host/Origin admission,
enable CORS, or allow the parent to inspect the framed document.
The server does not authenticate API clients, and the UI profile is not a server-side content gate.
Deployments MUST supply authorization at the private reverse proxy/network layer and MUST NOT
publish the inspector through Funnel or another public tunnel. Bind addresses are restricted to the
literal `127.0.0.1` and `::1`; `localhost` is deliberately rejected.

Stable evolution rules:

1. Keep the schema and provider fixtures stable and versioned.
2. Keep shared live-event semantics behind this module without changing Agent Hub run behavior.
3. Keep transcript discovery/read adapters side-effect free as the local inspector boundary.
4. Cockpit validates its Python scanner against the same conformance fixtures before deciding
   whether to consume a core-generated metadata JSONL stream.

These rules avoid adding a Node subprocess dependency to Cockpit's production Python scanner before
the shared contract has proven equivalent on real provider fixtures.
