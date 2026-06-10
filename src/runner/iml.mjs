// Minimal IML (Make expression language) evaluator — covers the subset used
// by this repo's blueprints. Not a general implementation.
//
// Supported: {{1.Email}}, {{20.`Lemlist Campaign ID`}}, {{103.body.person.x}},
// nested function calls ifempty(a; b), lower(x), first(split(x; space)),
// last(...), trim(x), replace(a; b; c), length(x), join(arr; sep), contains(a; b),
// if(cond; a; b), emptystring, space, plus string concatenation with `+`.

const FUNCS = {
  ifempty: (a, b) => (a === undefined || a === null || a === "" ? b : a),
  lower: (x) => String(x ?? "").toLowerCase(),
  upper: (x) => String(x ?? "").toUpperCase(),
  trim: (x) => String(x ?? "").trim(),
  first: (x) => (Array.isArray(x) ? x[0] : String(x ?? "")[0]),
  last: (x) => (Array.isArray(x) ? x[x.length - 1] : String(x ?? "").slice(-1)),
  split: (x, sep) => String(x ?? "").split(sep),
  join: (arr, sep) => (Array.isArray(arr) ? arr.join(sep) : String(arr ?? "")),
  replace: (x, from, to) => String(x ?? "").split(from).join(to),
  length: (x) => (Array.isArray(x) || typeof x === "string" ? x.length : 0),
  contains: (a, b) => String(a ?? "").includes(String(b ?? "")),
  if: (cond, a, b) => (truthy(cond) ? a : b),
  formatDate: (d, fmt) =>
    fmt === "X" ? String(Math.floor(new Date(d).getTime() / 1000)) : new Date(d).toISOString(),
};
const CONSTANTS = { emptystring: "", space: " ", now: () => new Date() };

export const truthy = (v) =>
  !(v === undefined || v === null || v === "" || v === false || v === 0);

// Resolve a dotted path like `103.body.person.email` against the bundle map.
// First segment is the module id; backticked segments may contain dots/spaces.
function resolvePath(path, bundles) {
  const segs = [];
  let rest = path;
  while (rest.length) {
    if (rest.startsWith("`")) {
      const end = rest.indexOf("`", 1);
      segs.push(rest.slice(1, end));
      rest = rest.slice(end + 1).replace(/^\./, "");
    } else {
      const dot = rest.indexOf(".");
      if (dot < 0) { segs.push(rest); rest = ""; }
      else { segs.push(rest.slice(0, dot)); rest = rest.slice(dot + 1); }
    }
  }
  let cur = bundles[segs[0]];
  for (const s of segs.slice(1)) {
    if (cur == null) return undefined;
    // Make's `array[]` mapping: take first element transparently
    const key = s.replace(/\[\]$/, "");
    cur = Array.isArray(cur) && !/^\d+$/.test(key) ? cur[0]?.[key] : cur[key];
  }
  return cur;
}

// Tokenize + parse a single expression (inside {{ }}).
function evalExpr(src, bundles) {
  let pos = 0;
  const peek = () => src[pos];
  const skipWs = () => { while (/\s/.test(src[pos] ?? "")) pos++; };

  function parseConcat() {
    let v = parseCompare();
    skipWs();
    while (src[pos] === "+") {
      pos++; skipWs();
      const r = parseCompare();
      v = String(v ?? "") + String(r ?? "");
      skipWs();
    }
    return v;
  }

  function parseCompare() {
    const l = parseAtom();
    skipWs();
    const m = src.slice(pos).match(/^(!=|>=|<=|=|>|<)/);
    if (!m) return l;
    pos += m[1].length; skipWs();
    const r = parseAtom();
    switch (m[1]) {
      case "=": return String(l ?? "") === String(r ?? "");
      case "!=": return String(l ?? "") !== String(r ?? "");
      case ">": return Number(l) > Number(r);
      case "<": return Number(l) < Number(r);
      case ">=": return Number(l) >= Number(r);
      case "<=": return Number(l) <= Number(r);
    }
  }

  function parseAtom() {
    skipWs();
    if (peek() === '"' || peek() === "'") {
      const q = src[pos++];
      let out = "";
      while (pos < src.length && src[pos] !== q) {
        if (src[pos] === "\\") { out += src[pos + 1]; pos += 2; }
        else out += src[pos++];
      }
      pos++; // closing quote
      return out;
    }
    // identifier / path / function call / number
    let ident = "";
    while (pos < src.length && /[\w.`\-\[\]]/.test(src[pos])) {
      if (src[pos] === "`") { // consume backticked block wholesale
        ident += src[pos++];
        while (pos < src.length && src[pos] !== "`") ident += src[pos++];
        ident += src[pos++];
      } else ident += src[pos++];
    }
    skipWs();
    if (src[pos] === "(") { // function call
      pos++; // (
      const args = [];
      skipWs();
      if (src[pos] === ")") pos++;
      else {
        for (;;) {
          args.push(parseConcat());
          skipWs();
          if (src[pos] === ";") { pos++; continue; }
          if (src[pos] === ")") { pos++; break; }
          throw new Error(`iml: bad char '${src[pos]}' in args of ${ident} @ ${pos} in: ${src}`);
        }
      }
      const fname = ident.replace(/^iml\./, "");
      const fn = FUNCS[fname];
      if (!fn) throw new Error(`iml: unknown function ${ident} in: ${src}`);
      return fn(...args);
    }
    if (ident === "") return undefined;
    if (/^-?\d+(\.\d+)?$/.test(ident)) {
      // bare number — but a leading module-id path like `1.Email` also matches
      // digits+dot; treat as number only when it has no trailing path chars
      if (!ident.includes(".") || /^\d+\.\d+$/.test(ident) === false) {
        if (/^-?\d+$/.test(ident)) return Number(ident);
      }
    }
    if (ident in CONSTANTS) {
      const c = CONSTANTS[ident];
      return typeof c === "function" ? c() : c;
    }
    return resolvePath(ident, bundles);
  }

  const v = parseConcat();
  return v;
}

// Public: render a template string. Single full-string expression keeps its
// native type; mixed text renders to string.
// Some blueprint contexts store IML with JSON-escaped quotes (\"X\") — retry
// with them unescaped when the raw form fails to parse.
function evalExprLenient(expr, bundles) {
  try { return evalExpr(expr, bundles); }
  catch (e) {
    const alt = expr.replace(/\\"/g, '"');
    if (alt !== expr) return evalExpr(alt, bundles);
    throw e;
  }
}

export function render(template, bundles) {
  if (template == null || typeof template !== "string") return template;
  const single = template.match(/^\{\{(.+)\}\}$/s);
  if (single && !single[1].includes("{{")) return evalExprLenient(single[1], bundles);
  return template.replace(/\{\{(.+?)\}\}/gs, (_, expr) => {
    const v = evalExprLenient(expr, bundles);
    return v == null ? "" : String(v);
  });
}

// Render every string leaf of an object/array.
export function renderDeep(value, bundles) {
  if (typeof value === "string") return render(value, bundles);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, bundles));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, bundles)]));
  return value;
}
