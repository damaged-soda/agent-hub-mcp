# Resolve and inspect sessions

Treat a user-supplied `agenthub://session/v1/...` value as an opaque reference. Do not parse,
rewrite, or guess its components. Resolve it through the stable read CLI:

```sh
agent-session resolve 'agenthub://session/v1/PROVIDER/SESSION_ID'
agent-session resolve 'agenthub://session/v1/PROVIDER/SESSION_ID/event/EVENT_ID'
```

Directly sending the reference authorizes inspection of its complete provider-native session. The
session form returns stable identity and metadata. The event form additionally returns a bounded
diagnostic containing the target, its paired tool call/result when present, and the effective
context at that step. Start there, then read only the additional pages needed:

```sh
agent-session inspect --provider PROVIDER --session-id SESSION_ID \
  --profile inspect --after SEQUENCE --limit 200
```

You may inspect the whole session when useful without asking again, but do not eagerly load it when
the bounded diagnostic is sufficient. If resolution reports a stale reference, report that exact
failure; do not substitute a similar event.
