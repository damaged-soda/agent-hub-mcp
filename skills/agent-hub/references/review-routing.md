# Inspect, discover, and change Review routing

Use this workflow when the user asks to view Review configuration, explore candidate reviewers or
models, or change a Review route. Use the existing CLI; the quota page remains a read-only display.

## Read the current configuration

```sh
agenthub review status
```

Report `routes`: requester → reviewer → configured model, plus `source` (default or override).
Status only reads the routing file and merges defaults. It does not probe providers, resolve model
aliases, or assess availability. A request to “看一下当前路由” ends here unless more was requested.

## Discover options on demand

When the user asks what is installed, which models can be selected, or requests a probe, run:

```sh
agenthub agents --cwd /absolute/path/to/the/users/workspace
```

Use the workspace relevant to the user's request because provider configuration can depend on cwd.
Summarize the relevant `agents[].agent_id`, `models[].id` and optional `resolved_id`; keep the exact
model ID for a later selection. For missing providers or failed model discovery, report
`unavailable_agents[].unavailable_reason` or `model_discovery.reason`. A model listed in a catalog
is not proof that an actual review will succeed. This discovery does not start a review or change
its route; do not turn it into a periodic check or launch a test review without a request to do so.

## Save the user's selection

Identify the requester whose route should change, the reviewer, and the exact configured model.
Use the user's choices and conversation context; ask only for fields that remain ambiguous. A named
reviewer for one ordinary task is not authorization to change the persistent Review route.

When the user has specified the change, execute it without asking for the same approval again:

```sh
agenthub review set --requester REQUESTER --reviewer REVIEWER --model MODEL
agenthub review status
```

`REQUESTER`, `REVIEWER`, and `MODEL` are placeholders for the selected values. Set changes one
requester's route, not every route. It validates known agent IDs, forbids self-review, and requires
a non-empty model; it intentionally does not require a live provider or a catalog match. If the
user supplies an exact target, discovery is optional. Preserve explicitly chosen models even if
absent from discovery, explain that execution is unverified, and never substitute a fallback.

Verify the effective requester/reviewer/model in the returned configuration and summarize the
change. A route equal to the built-in default is stored without an override. Do not hand-edit the
routing file. Configuration changes affect future routed reviews; do not cancel or restart existing
runs. To actually dispatch a review, follow [reviews.md](reviews.md) under its separate trigger rules.
