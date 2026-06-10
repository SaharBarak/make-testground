// Example: testing a Make blueprint locally.
//   node --test examples/lead-intake.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runBlueprint, createState, seedRecord, registerTableFields } from "../src/index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const bp = JSON.parse(readFileSync(resolve(HERE, "lead-intake.blueprint.json"), "utf8"));

const LEADS = "tblLEADS0000000000";
registerTableFields(LEADS, {
  fldEmail0000000000: "Email",
  fldName00000000000: "Lead Name",
  fldStatus000000000: "Status",
});

// LLM modules have no default handler — stub them so external assumptions
// are explicit in every test.
const llmSend = { 3: () => ({ result: '{"decision":"send"}' }) };

test("new relevant lead is created", async () => {
  const state = createState();
  await runBlueprint(bp, {
    state,
    stubs: llmSend,
    trigger: { email: "ada@example.com", firstName: "Ada", lastName: "L", title: "CTO" },
  });
  const rows = [...state.airtable.get(LEADS).values()];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fields.Email, "ada@example.com");
  assert.equal(rows[0].fields.Status, "New");
});

test("duplicate email (case-insensitive) is not created twice", async () => {
  const state = createState();
  seedRecord(state, LEADS, { Email: "ADA@example.com", Status: "Contacted" });
  await runBlueprint(bp, {
    state,
    stubs: llmSend,
    trigger: { email: "ada@example.com", firstName: "Ada", lastName: "L", title: "CTO" },
  });
  assert.equal([...state.airtable.get(LEADS).values()].length, 1, "dedup filter must block");
});

test("LLM 'skip' decision blocks creation", async () => {
  const state = createState();
  await runBlueprint(bp, {
    state,
    stubs: { 3: () => ({ result: '{"decision":"skip"}' }) },
    trigger: { email: "spam@example.com", firstName: "S", lastName: "P", title: "Intern" },
  });
  assert.equal([...(state.airtable.get(LEADS)?.values() ?? [])].length, 0);
});
