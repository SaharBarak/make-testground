// Global fetch interceptor: routes api.airtable.com + api.lemlist.com to the
// in-memory state so repo scripts (feeder, reachouts-sync) run UNMODIFIED.
// Install BEFORE dynamically importing a script. Unknown hosts throw — a test
// must never silently hit the real network.
import { table, searchRecords, newId, normalizeFields, fieldsById } from "./state.mjs";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function installFakeFetch(state, { realFetchAllow = [] } = {}) {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;

    if (url.hostname === "api.airtable.com") return airtable(state, url, method, body);
    if (url.hostname === "api.lemlist.com") return lemlist(state, url, method, body);
    if (realFetchAllow.some((h) => url.hostname === h)) return real(input, init);
    throw new Error(`fake-fetch: unmocked host ${url.hostname} (${method} ${url.pathname})`);
  };
  return () => { globalThis.fetch = real; };
}

// ---------------- Airtable REST surface used by the repo ----------------
function airtable(state, url, method, body) {
  // /v0/{base}/{table}[/{rec}]
  const [, v0, _base, tableId, recId] = url.pathname.split("/");
  if (v0 !== "v0") return json({ error: "bad path" }, 404);
  const tbl = table(state, tableId);

  if (method === "GET" && !recId) {
    const formula = url.searchParams.get("filterByFormula");
    const max = Number(url.searchParams.get("maxRecords") ?? Infinity);
    const recs = searchRecords(state, tableId, formula, max);
    // fields[] narrowing — keep simple: return full fields (scripts tolerate extras)
    if (url.searchParams.get("returnFieldsByFieldId") === "true")
      return json({ records: recs.map((r) => ({ ...r, fields: fieldsById(tableId, r.fields) })) });
    return json({ records: recs });
  }
  if (method === "GET" && recId) {
    const rec = tbl.get(recId);
    return rec ? json(rec) : json({ error: "NOT_FOUND" }, 404);
  }
  if (method === "PATCH" && recId) {
    const rec = tbl.get(recId);
    if (!rec) return json({ error: "NOT_FOUND" }, 404);
    Object.assign(rec.fields, normalizeFields(tableId, body.fields));
    state.log.push({ op: "airtable.patch", tableId, recId, fields: body.fields });
    return json(rec);
  }
  if (method === "PATCH" && !recId) { // batch
    const out = [];
    for (const r of body.records) {
      const rec = tbl.get(r.id);
      if (rec) { Object.assign(rec.fields, normalizeFields(tableId, r.fields)); out.push(rec); }
      state.log.push({ op: "airtable.patch", tableId, recId: r.id, fields: r.fields });
    }
    return json({ records: out });
  }
  if (method === "POST") {
    const records = (body.records ?? [{ fields: body.fields }]).map((r) => {
      const rec = { id: newId("rec"), createdTime: new Date().toISOString(), fields: normalizeFields(tableId, r.fields) };
      tbl.set(rec.id, rec);
      state.log.push({ op: "airtable.create", tableId, recId: rec.id, fields: r.fields });
      return rec;
    });
    return json(body.records ? { records } : records[0]);
  }
  if (method === "DELETE") {
    const ids = url.searchParams.getAll("records[]");
    for (const id of ids.length ? ids : [recId]) { tbl.delete(id); state.log.push({ op: "airtable.delete", tableId, recId: id }); }
    return json({ records: ids.map((id) => ({ id, deleted: true })) });
  }
  return json({ error: "unsupported" }, 400);
}

// ---------------- lemlist REST surface used by the repo ----------------
function lemlist(state, url, method, body) {
  const L = state.lemlist;
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]

  // POST /api/campaigns/{cid}/leads/{email}
  if (method === "POST" && parts[1] === "campaigns" && parts[3] === "leads") {
    const cid = parts[2], email = decodeURIComponent(parts[4]).toLowerCase();
    if (!L.campaigns.has(cid)) L.campaigns.set(cid, new Map());
    const camp = L.campaigns.get(cid);
    if (camp.has(email)) return json({ error: "Lead already in the campaign" }, 400);
    const lead = { _id: newId("lea_"), email, ...body };
    camp.set(email, lead);
    state.log.push({ op: "lemlist.addLead", cid, email, body });
    return json(lead);
  }
  // DELETE /api/campaigns/{cid}/leads/{key}[?action=remove]
  if (method === "DELETE" && parts[1] === "campaigns" && parts[3] === "leads") {
    const cid = parts[2], key = decodeURIComponent(parts[4]).toLowerCase();
    const camp = L.campaigns.get(cid);
    if (!camp?.has(key)) return json({ error: "Lead email invalid or lead already unsubscribed" }, 404);
    camp.delete(key);
    state.log.push({ op: "lemlist.removeLead", cid, email: key });
    return json({ ok: true });
  }
  // GET /api/activities?type=&limit=&offset=  (newest first)
  if (method === "GET" && parts[1] === "activities") {
    const type = url.searchParams.get("type");
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    let acts = L.activities.filter((a) => !type || a.type === type);
    if (L.brokenOffset) return json(acts.slice(0, limit)); // simulate stuck pagination
    return json(acts.slice(offset, offset + limit));
  }
  // GET /api/campaigns/{cid}/export/leads
  if (method === "GET" && parts[3] === "export") {
    const camp = L.campaigns.get(parts[2]) ?? new Map();
    return json([...camp.values()]);
  }
  // GET /api/hooks
  if (method === "GET" && parts[1] === "hooks") return json(L.hooks);
  return json({ error: `lemlist: unsupported ${method} ${url.pathname}` }, 400);
}
