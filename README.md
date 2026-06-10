# make-testground

**Local test harness for [Make.com](https://www.make.com) (Integromat) scenarios.**
Run your real blueprint JSON offline, against in-memory mocks, in milliseconds — no Make account, no network, no burned operations.

```
✔ REGRESSION: already-pushed lead is NOT re-selected (0.5ms)
✔ dedup: same person via LinkedIn http/https variant is blocked (0.4ms)
✔ LLM 'skip' decision blocks the push (0.3ms)
```

## Why

Make has no local runtime. The only way to test a scenario is "Run once" against
live systems — real Airtable rows, real emails, real API quota. When a scenario
guards something irreversible (cold outreach, payments, CRM writes), that's
testing in production.

We built this after a dedup bug caused a campaign to re-contact people it had
already messaged. The fix was easy; *proving* it stays fixed wasn't — until the
scenario's blueprint could run locally against seeded state. There was nothing
on GitHub that interprets Make blueprints, so we wrote one.

## What it does

- **Interprets real blueprint JSON** — the same file Make's API returns
  (`GET /scenarios/{id}/blueprint`) or the editor exports. Modules execute in
  flow order with Make semantics: searches fan out bundles, routers branch,
  filters gate.
- **Evaluates IML expressions** — `{{1.Email}}`, ``{{20.`Lemlist Campaign ID`}}``,
  `{{ifempty(lower(first(split(...))); emptystring)}}`, comparisons, concatenation.
- **Evaluates Make filters** — `text:contain:ci`, `number:equal`, `exist`, OR-groups.
- **Mocks Airtable** — in-memory tables with a real `filterByFormula` evaluator
  (`AND/OR/LOWER/FIND/ARRAYJOIN/REGEX_REPLACE/…`), field-id ↔ field-name
  translation per table, `returnFieldsByFieldId` support.
- **Mocks lemlist** — campaign leads, activities with pagination (including a
  `brokenOffset` mode that simulates the real API ignoring `offset`).
- **Intercepts `fetch`** — companion scripts that call `api.airtable.com` /
  `api.lemlist.com` directly run **unmodified** against the same in-memory state.
  Any unmocked host throws: a test can never silently hit the real network.
- **Forces explicit stubs for LLM / Apollo modules** — there is deliberately no
  default handler for `openai-gpt-3:*` or `apollo:*`. Every assumption about an
  external brain is written down in the test.

## Quick start

```bash
git clone https://github.com/SaharBarak/make-testground
cd make-testground
npm test          # runs the example suite with node:test — zero dependencies
```

Test your own scenario:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { runBlueprint, createState, seedRecord, registerTableFields } from "make-testground";

// 1. pull your blueprint:  GET {MAKE_API}/scenarios/{id}/blueprint
const bp = JSON.parse(readFileSync("fixtures/my-scenario.json", "utf8"));

// 2. teach the mock your Airtable schema (blueprints write by field id)
registerTableFields("tblXXXXXXXXXXXXXX", { fldAaa: "Email", fldBbb: "Status" });

test("already-contacted lead is not re-pushed", async () => {
  const state = createState();
  seedRecord(state, "tblXXXXXXXXXXXXXX", { Email: "a@b.io", Status: "Contacted" });

  await runBlueprint(bp, {
    state,
    trigger: { email: "a@b.io" },                      // webhook payload, if any
    stubs: { 14: () => ({ result: '{"decision":"send"}' }) },  // LLM module
  });

  assert.equal(state.log.filter((l) => l.op === "lemlist.addLead").length, 0);
});
```

`state.log` records every mutation (`airtable.create`, `airtable.patch`,
`lemlist.addLead`, …) — assert on what the flow *did*, not just final state.

### Testing companion scripts

Many Make setups have sidecar scripts hitting the same APIs. Run them unmodified:

```js
import { installFakeFetch, createState, seedRecord } from "make-testground";

const state = createState();
seedRecord(state, "tblXXX", { Email: "a@b.io", Status: "New" });

installFakeFetch(state);                 // global fetch now routes to the mock
process.argv = ["node", "feeder", "--apply"];
await import("./scripts/my-feeder.mjs"); // script runs for real, against fakes
```

## Module coverage

| Module | Behavior |
|---|---|
| `airtable:ActionSearchRecords` | real formula evaluation, fan-out, `__IMTLENGTH__` |
| `airtable:ActionGetRecord` / `CreateRecord` / `UpdateRecords` | in-memory CRUD with field-id translation |
| `lemlist:addALeadInACampaign` | duplicate detection, `deduplicate` flag |
| `gateway:CustomWebHook` | injects `trigger` payload |
| `util:SetVariables`, `json:ParseJSON`, `builtin:BasicFeeder` / `BasicAggregator` / `BasicRouter` | Make semantics |
| `http:ActionSendData` | swallowed (log sinks) |
| `openai-gpt-3:*`, `apollo:*`, anything else | **must be stubbed** — by design |

Add handlers in `src/runner/modules.mjs`; one function per module type.

## Honest limitations

- **Subset, not spec.** IML, formulas, and modules cover what real-world lead-gen
  scenarios use. Unknown functions/operators throw loudly rather than guess.
- **Not an emulator.** Scheduling, retries, incomplete-execution DLQs, data
  stores, and Make's exact zero-bundle edge cases are out of scope.
- **Fixtures are yours.** Blueprint pulls can embed connection ids — the
  `.gitignore` keeps `fixtures/` out of git by default.

## Architecture

```
blueprint.json ─▶ interpreter ─▶ module handlers ─▶ in-memory state ─▶ assertions
                     │                                    ▲
                IML + filters                   fake-fetch (scripts under test)
```

Zero runtime dependencies. Node ≥ 20 (`node:test`).

## License

MIT © Sahar Barak
