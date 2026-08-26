# Agent Session Core

`src/agent-session-core.js` defines the provider-neutral, read-only projection contract shared by
Agent Hub execution adapters, a future local session inspector, and telemetry consumers. It does
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
- provenance with a stage and source.

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
  context for an explicit local inspection request. Thinking blocks are never projected.
- `metadata`: removes message text, tool arguments/results, result/error text, and private plugin
  paths while retaining byte counts and structural metadata.

`metadata` is a safe common baseline, not a replacement for Cockpit's stricter source projection.
Cockpit may retain fewer fields and remains responsible for its own fail-loud redaction tests.

## Adapter facets and read API

Live JSONL normalization centralizes session-ref extraction and progress summaries already used by
Agent Hub. The separate transcript facet understands provider-native Claude Code, Codex, and Kimi
Code evidence without making Agent Hub the session owner.

The daemon-free `agent-session` CLI is the stable read surface:

```text
agent-session list [--provider ...] [--limit ...]
agent-session inspect --provider ... --session-id ...
  [--profile metadata|inspect] [--after ...] [--limit ...]
```

`list` derives identity from provider-native stores. `inspect` uses normalized event sequence
cursors, defaults to `metadata`, and requires an explicit `--profile inspect` to return transcript
bodies. Neither command accepts arbitrary source paths or mutates provider/session state.

Migration order:

1. Keep the schema and provider fixtures stable and versioned.
2. Move shared live-event semantics behind this module without changing Agent Hub run behavior.
3. Keep transcript discovery/read adapters side-effect free and use them as the local inspector
   boundary.
4. Let Cockpit validate its Python scanner against the same conformance fixtures before deciding
   whether to consume a core-generated metadata JSONL stream.

This order avoids adding a Node subprocess dependency to Cockpit's production Python scanner before
the shared contract has proven equivalent on real provider fixtures.
