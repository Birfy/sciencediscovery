# L1 contract scenarios

Replay a scripted list of HTTP requests against a backend, record what comes back
(normalised), and compare a run against a stored baseline. It checks the **interface**,
not the agent: no browser and no model. Its purpose is issue 84's L1 layer, so that a
route can move from the legacy API to the adapter and any change in what a client sees
is caught.

    node test/contract/run.mjs --coverage                       which of the 259 interface rows have a case
    node test/contract/run.mjs --record out.json                record against $E2E_BASE_URL with $E2E_API_TOKEN
    node test/contract/run.mjs --compare test/contract/baselines/legacy.json
    node --test test/contract/*.test.mjs                        the tooling's own tests

## Files

| File | What |
|---|---|
| `routes.json` | The interface inventory, parsed from issue 84 (259 rows, handling per row). Not hand-edited: regenerate from the issue if it changes. |
| `cases/*.json` | Scenarios. A step lists `covers: ["GET /api/projects"]` (the row's method and path exactly as in `routes.json`), a `request`, optional `capture` (`{"id": "$.id"}`, used later as `{{id}}`), `expectStatus`, `stream` for SSE, and `always: true` for cleanup that must run after a failure. Every case deletes what it creates. |
| `baselines/legacy.json` | What the legacy API answered, recorded with `--record`. **Read-only for agents**: changing it to make a comparison pass needs a human review. |
| `normalize.mjs` | Ids become `<uuid:N>` (numbered by first appearance), times, digests, workspace ids and the sandbox-specific environment name become placeholders. |

## Rules

- A row is covered when some step names it in `covers`, or its handling is `not-migrated`.
  `--coverage` exits non-zero if a case names a row that is not in the inventory (a typo).
- Recording twice on the same backend must produce identical files; if it does not, fix the
  normaliser, not the baseline.
- The baseline is recorded on the legacy API with no model configured. Cases that need a
  model, a runner or an external service are separate scenarios and say so.
