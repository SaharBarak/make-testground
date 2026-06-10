// In-memory Airtable + lemlist state, shared by the fake fetch layer and the
// blueprint module handlers. Includes an Airtable filterByFormula evaluator
// covering the subset this repo uses.

let recSeq = 0;
export const newId = (prefix) => `${prefix}${(++recSeq).toString(36).padStart(14, "0")}`;

// Airtable field-id -> field-name maps, PER TABLE (blueprints write by field
// id, formulas read by name; names can collide across tables). Register your
// own tables before running flows:
//
//   registerTableFields("tblXXXXXXXXXXXXXX", { fldAaa: "Email", fldBbb: "Status" });
export const TABLE_FIELDS = {};
const TABLE_IDS = {};

export function registerTableFields(tableId, idToName) {
  TABLE_FIELDS[tableId] = { ...(TABLE_FIELDS[tableId] ?? {}), ...idToName };
  TABLE_IDS[tableId] = Object.fromEntries(
    Object.entries(TABLE_FIELDS[tableId]).map(([id, name]) => [name, id]));
}

export const normalizeFields = (tableId, fields) =>
  Object.fromEntries(Object.entries(fields ?? {}).map(([k, v]) => [TABLE_FIELDS[tableId]?.[k] ?? k, v]));
export const fieldsById = (tableId, fields) =>
  Object.fromEntries(Object.entries(fields ?? {}).map(([k, v]) => [TABLE_IDS[tableId]?.[k] ?? k, v]));

export function createState() {
  return {
    airtable: new Map(),  // tableId -> Map(recId -> {id, createdTime, fields})
    lemlist: {
      campaigns: new Map(),   // campaignId -> Map(emailLower -> lead)
      activities: [],         // newest first
      hooks: [],
    },
    log: [],                  // every mutating call, for assertions
  };
}

export function table(state, tableId) {
  if (!state.airtable.has(tableId)) state.airtable.set(tableId, new Map());
  return state.airtable.get(tableId);
}

export function seedRecord(state, tableId, fields, id = newId("rec")) {
  const rec = { id, createdTime: new Date().toISOString(), fields: { ...fields } };
  table(state, tableId).set(id, rec);
  return rec;
}

export function seedLemlistLead(state, campaignId, lead) {
  if (!state.lemlist.campaigns.has(campaignId)) state.lemlist.campaigns.set(campaignId, new Map());
  state.lemlist.campaigns.get(campaignId).set((lead.email ?? "").toLowerCase(), { _id: newId("lea_"), ...lead });
}

// ---------------- Airtable formula evaluator ----------------
// Supports: AND OR NOT LOWER UPPER FIND ARRAYJOIN TRUE FALSE REGEX_REPLACE,
// {Field} refs, string literals "x", numbers, = != > < >= <=, & concat.
export function evalFormula(formula, fields) {
  let pos = 0;
  const src = formula;
  const ws = () => { while (/\s/.test(src[pos] ?? "")) pos++; };

  function parseCompare() {
    let l = parseConcat();
    ws();
    const m = src.slice(pos).match(/^(!=|>=|<=|=|>|<)/);
    if (!m) return l;
    pos += m[1].length;
    const r = parseConcat();
    const [a, b] = [l, r];
    switch (m[1]) {
      case "=": return String(a ?? "") === String(b ?? "");
      case "!=": return String(a ?? "") !== String(b ?? "");
      case ">": return Number(a) > Number(b);
      case "<": return Number(a) < Number(b);
      case ">=": return Number(a) >= Number(b);
      case "<=": return Number(a) <= Number(b);
    }
  }
  function parseConcat() {
    let v = parseAtom(); ws();
    while (src[pos] === "&") { pos++; v = String(v ?? "") + String(parseAtom() ?? ""); ws(); }
    return v;
  }
  function args() {
    const out = [];
    pos++; ws(); // (
    if (src[pos] === ")") { pos++; return out; }
    for (;;) {
      out.push(parseCompare()); ws();
      if (src[pos] === ",") { pos++; ws(); continue; }
      if (src[pos] === ")") { pos++; break; }
      throw new Error(`formula: bad char '${src[pos]}' @${pos}: ${src}`);
    }
    return out;
  }
  function parseAtom() {
    ws();
    if (src[pos] === '"') {
      pos++; let out = "";
      while (pos < src.length && src[pos] !== '"') {
        if (src[pos] === "\\") { out += src[pos + 1]; pos += 2; } else out += src[pos++];
      }
      pos++; return out;
    }
    if (src[pos] === "{") {
      const end = src.indexOf("}", pos);
      const name = src.slice(pos + 1, end); pos = end + 1;
      return fields[name];
    }
    const m = src.slice(pos).match(/^[A-Z_]+/);
    if (m && src[pos + m[0].length] === "(") {
      pos += m[0].length;
      const fn = m[0]; const a = args();
      switch (fn) {
        case "AND": return a.every((x) => truthyA(x));
        case "OR": return a.some((x) => truthyA(x));
        case "NOT": return !truthyA(a[0]);
        case "LOWER": return String(a[0] ?? "").toLowerCase();
        case "UPPER": return String(a[0] ?? "").toUpperCase();
        case "TRUE": return true;
        case "FALSE": return false;
        case "BLANK": return "";
        case "FIND": { const i = String(a[1] ?? "").indexOf(String(a[0] ?? "")); return i < 0 ? 0 : i + 1; }
        case "ARRAYJOIN": return Array.isArray(a[0]) ? a[0].join(",") : String(a[0] ?? "");
        case "REGEX_REPLACE": return String(a[0] ?? "").replace(new RegExp(String(a[1]), ""), String(a[2] ?? ""));
        default: throw new Error(`formula: unsupported fn ${fn}`);
      }
    }
    const num = src.slice(pos).match(/^-?\d+(\.\d+)?/);
    if (num) { pos += num[0].length; return Number(num[0]); }
    throw new Error(`formula: cannot parse @${pos}: ${src.slice(pos, pos + 30)}`);
  }
  const truthyA = (v) => !(v === undefined || v === null || v === "" || v === false || v === 0);
  const out = parseCompare();
  return truthyA(out);
}

export function searchRecords(state, tableId, formula, maxRecords = Infinity) {
  const out = [];
  for (const rec of table(state, tableId).values()) {
    if (!formula || evalFormula(formula, rec.fields)) out.push(rec);
    if (out.length >= maxRecords) break;
  }
  return out;
}
