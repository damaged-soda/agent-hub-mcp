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

- `provider`: `claude`, `codex`, `kimi`, or `opencode`;
- `native_session_id`: provider id, or `null` until a provider reports one;
- `sequence`, `kind`, `occurred_at`, and provider-neutral `data`;
- provenance with a stage and source;
- an optional `event_ref` on provider-native transcript events;
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

## Stable session references

Every discovered native session has a canonical `session_ref`; every event read through a source
with an established session id has an `event_ref` below that session:

```text
agenthub://session/v1/<provider>/<native-session-id>
agenthub://session/v1/<provider>/<native-session-id>/event/e1_<digest>
```

`provider` is canonical `claude|codex|kimi|opencode`; the session id is percent-encoded; `digest` is a
43-character unpadded base64url SHA-256. The URI has no machine, file path, query, fragment, or
registry key. Machine placement remains resolver configuration, while session identity remains
`provider + native_session_id`.

The frozen `e1` digest binds length-prefixed protocol version, provider, native session id, a
SHA-256 of the provider record's recursively key-sorted JSON form, that exact record body's
zero-based duplicate occurrence, the event selector, and that selector's zero-based occurrence
inside the record. A tool event selector uses `kind + tool_call_id`; a message uses `kind + role`;
other events use `kind`. Event `sequence`, transcript path, archive location, UI layout, content
profile, and machine identity are deliberately excluded.

The reference identifies the target native record/event, not the projection's accumulated context.
Resolution recomputes the current event projection and effective context from the transcript; if a
preceding context record changes while the target record remains byte-equivalent, the target
reference remains valid but derived fields such as absolute `resource_accesses` may change. Pure
`projectNativeTranscript` calls with no inferable or supplied session id omit `event_ref`.

Consequences:

- appending records, moving a transcript into an archive, changing inspect/metadata profile, or
  adding a different projected event does not change an existing reference;
- changing the referenced native evidence changes the digest, so resolution reports a stale
  reference instead of drifting to a similar event;
- identical provider records are disambiguated by their occurrence among identical bodies without
  making unrelated record order part of identity.

`agent-session resolve REF` is the parsing and resolution authority. A session reference returns
identity and metadata without eagerly reading transcript bodies. An event reference additionally
returns bounded `inspect` projections for the exact target, the paired tool call/result when
available, and the effective context at that event. Resolution never persists a reference registry
or body cache. The bundled Skill must pass the opaque reference to this command rather than
reimplement URI parsing.

When one provider/session id has multiple native source files, readers hash every candidate. Exact
copies resolve through a deterministic active-first/path order and report `duplicate_source_count`;
conflicting bodies are ambiguous and fail loud instead of selecting by mtime or directory order.

## Adapter facets and read API

Live JSONL normalization centralizes session-ref extraction and progress summaries already used by
Agent Hub. The separate transcript facet understands provider-native Claude Code, Codex, Kimi Code,
and OpenCode evidence without making Agent Hub the session owner. OpenCode discovery and inspect
query its provider-native database through `sqlite3 -readonly -json`; only root sessions
(`parent_id IS NULL`) enter the directory, and reasoning parts are never projected. Internal schema
drift fails the explicit OpenCode request and appears in aggregate list `source_errors` without
hiding healthy providers.

The daemon-free `agent-session` CLI is the stable read surface:

```text
agent-session list [--provider ...] [--limit ...]
agent-session inspect --provider ... --session-id ...
  [--profile metadata|inspect] [--after ...] [--limit ...]
agent-session resolve 'agenthub://session/v1/...'
agent-session serve [--host 127.0.0.1] [--port 8765]
  [--public-origin https://cockpit.example.ts.net] [--base-path /agent-session]
```

`list` derives identity from provider-native stores. Its nullable, bounded `title` is copied only
from provider-written title metadata (Codex's session index, Claude's `ai-title`, a Kimi title
explicitly marked custom, or OpenCode's root session row); it never derives a fallback from prompt
text or launches a model call.
Kimi's automatic title mirrors the prompt and is deliberately excluded. A native title can still
summarize a sensitive topic, so the list remains part of the private inspector surface.
`inspect` uses normalized event sequence cursors, defaults to `metadata`, and requires an explicit
`--profile inspect` to return transcript bodies. None of these commands accepts arbitrary source
paths or mutates provider/session state.
`resolve` accepts exactly one canonical session or event reference. Only the event form returns the
bounded body-bearing diagnostic package described above. Neither reference contains transcript body
or grants network access.

`serve` exposes the same list/inspect contract as a loopback-only JSON API for Cockpit. It does not
add a database or background coordinator. Responses are `no-store`, cross-origin browser requests
are rejected, the root returns a versioned service description, and `/healthz` is side-effect free.
An optional exact HTTPS `public-origin` may admit Host/Origin values from a trusted reverse proxy;
the process still refuses non-literal loopback bind addresses.
An optional `base-path` moves the service description, liveness endpoint, and API under one path
prefix without changing the native session roots, content profiles, or authorization boundary.
The server does not authenticate API clients, and the content profile is not a server-side gate.
Deployments MUST supply authorization at the private reverse proxy/network layer and MUST NOT
publish the session API through Funnel or another public tunnel. Bind addresses are restricted to the
literal `127.0.0.1` and `::1`; `localhost` is deliberately rejected.

Stable evolution rules:

1. Keep the schema and provider fixtures stable and versioned.
2. Keep shared live-event semantics behind this module without changing Agent Hub run behavior.
3. Keep transcript discovery/read adapters side-effect free as the local inspector boundary.
4. Cockpit validates its Python scanner against the same conformance fixtures before deciding
   whether to consume a core-generated metadata JSONL stream.

These rules avoid adding a Node subprocess dependency to Cockpit's production Python scanner before
the shared contract has proven equivalent on real provider fixtures.
