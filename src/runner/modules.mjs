// Module handlers — each receives { mod, mapped (IML-rendered mapper), bundles, ctx }
// and returns: a bundle object, an array of bundles (fan-out), or undefined.
// LLM + Apollo modules have NO default handler: tests must stub them so every
// assumption about external behavior is explicit.
import { searchRecords, table, newId, normalizeFields } from "../mocks/state.mjs";

export const handlers = {
  // ---- Airtable ----
  "airtable:ActionSearchRecords": ({ mapped, ctx }) => {
    const recs = searchRecords(ctx.state, mapped.table, mapped.formula, Number(mapped.maxRecords ?? Infinity));
    // Make flattens record fields into the bundle + id; array output fans out.
    // __IMTLENGTH__ lets downstream filters count results even when 0 —
    // Make exposes it on the aggregated result; we attach it to each bundle
    // and, when empty, emit one empty bundle carrying length 0.
    if (!recs.length) return [{ __IMTLENGTH__: 0 }];
    return recs.map((r) => ({ id: r.id, __IMTLENGTH__: recs.length, ...r.fields }));
  },
  "airtable:ActionGetRecord": ({ mapped, ctx }) => {
    const rec = mapped.id ? table(ctx.state, mapped.table).get(mapped.id) : null;
    // tolerate zero-result upstream (id renders empty) — Make carries an empty bundle
    if (!rec) return {};
    return { id: rec.id, ...rec.fields };
  },
  "airtable:ActionCreateRecord": ({ mapped, ctx }) => {
    const rec = { id: newId("rec"), createdTime: new Date().toISOString(), fields: normalizeFields(mapped.table, mapped.record) };
    table(ctx.state, mapped.table).set(rec.id, rec);
    ctx.state.log.push({ op: "airtable.create", tableId: mapped.table, recId: rec.id, fields: rec.fields });
    return { id: rec.id, ...rec.fields };
  },
  "airtable:ActionUpdateRecords": ({ mapped, ctx }) => {
    const rec = table(ctx.state, mapped.table).get(mapped.id);
    if (!rec) throw new Error(`airtable update: ${mapped.id} not in ${mapped.table}`);
    Object.assign(rec.fields, normalizeFields(mapped.table, mapped.record));
    ctx.state.log.push({ op: "airtable.patch", tableId: mapped.table, recId: mapped.id, fields: normalizeFields(mapped.table, mapped.record) });
    return { id: rec.id, ...rec.fields };
  },

  // ---- lemlist ----
  "lemlist:addALeadInACampaign": ({ mapped, ctx }) => {
    const cid = mapped.campaign ?? mapped.campaignId;
    const email = String(mapped.email ?? "").toLowerCase();
    const L = ctx.state.lemlist;
    if (!L.campaigns.has(cid)) L.campaigns.set(cid, new Map());
    const camp = L.campaigns.get(cid);
    if (camp.has(email)) {
      if (mapped.deduplicate) return { email, deduplicated: true }; // module's own dedupe: no error
      throw new Error(`lemlist: Lead already in the campaign (${email} @ ${cid})`);
    }
    const lead = { _id: newId("lea_"), ...mapped, email };
    camp.set(email, lead);
    ctx.state.log.push({ op: "lemlist.addLead", cid, email, body: mapped });
    return lead;
  },

  // ---- utility / plumbing ----
  "util:SetVariables": ({ mapped }) => {
    const out = {};
    for (const v of mapped.variables ?? []) out[v.name] = v.value;
    return out;
  },
  "json:ParseJSON": ({ mapped }) => JSON.parse(mapped.json),
  "builtin:BasicFeeder": ({ mapped }) => {
    const arr = mapped.array ?? [];
    return Array.isArray(arr) ? arr.map((x) => (typeof x === "object" ? x : { value: x })) : [arr];
  },
  "builtin:BasicAggregator": () => ({}),
  "gateway:CustomWebHook": ({ ctx }) => ctx.trigger ?? {},
  "gateway:CustomMailHook": ({ ctx }) => ctx.trigger ?? {},
  "http:ActionSendData": () => ({ statusCode: 200 }), // grafana/loki etc — swallow
};
