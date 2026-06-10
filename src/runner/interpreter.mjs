// Blueprint interpreter: executes a Make blueprint's flow against the
// in-memory state. One run = one trigger bundle pushed through every module
// in order (Make semantics: a search/feeder yielding N bundles fans the rest
// of the flow out per bundle).
import { renderDeep, render } from "./iml.mjs";
import { passesFilter } from "./filters.mjs";
import { handlers } from "./modules.mjs";

export async function runBlueprint(bp, ctx) {
  // ctx: { state, stubs?: {modId: fn(bundles)=>output}, trigger?: bundle, trace?: [] }
  const flow = bp.flow ?? bp.blueprint?.flow;
  ctx.trace = ctx.trace ?? [];
  await runFlow(flow, { ...(ctx.bundles ?? {}) }, ctx);
  return ctx.trace;
}

async function runFlow(flow, bundles, ctx) {
  const [head, ...rest] = flow;
  if (!head) return;

  if (head.module === "builtin:BasicRouter") {
    for (const route of head.routes ?? []) await runFlow(route.flow ?? [], { ...bundles }, ctx);
    return;
  }

  const outputs = await execModule(head, bundles, ctx); // array of bundles (fan-out) or null (filtered)
  if (outputs === null) return; // filter blocked
  for (const out of outputs) {
    await runFlow(rest, { ...bundles, [head.id]: out }, ctx);
  }
}

async function execModule(mod, bundles, ctx) {
  if (mod.filter && !passesFilter(mod.filter, bundles)) {
    ctx.trace.push({ id: mod.id, module: mod.module, filtered: true });
    return null;
  }
  // test stub takes precedence (e.g. canned LLM output)
  let out;
  if (ctx.stubs?.[mod.id]) {
    out = await ctx.stubs[mod.id]({ bundles, mod, render: (t) => render(t, bundles) });
  } else {
    const key = mod.module;
    const handler =
      handlers[key] ??
      handlers[Object.keys(handlers).find((k) => k.endsWith("*") && key.startsWith(k.slice(0, -1))) ?? ""];
    if (!handler) throw new Error(`interpreter: no handler for module ${key} (mod ${mod.id}) — add a stub`);
    // http log sinks (grafana/loki) carry deeply escaped JSON payloads that the
    // IML subset can't render — and we swallow them anyway. Pass raw.
    const RAW = key === "http:ActionSendData";
    const mapped = RAW ? (mod.mapper ?? {}) : renderDeep(mod.mapper ?? {}, bundles);
    out = await handler({ mod, mapped, bundles, ctx });
  }
  const arr = out === undefined ? [{}] : Array.isArray(out) ? out : [out];
  ctx.trace.push({ id: mod.id, module: mod.module, bundles: arr.length });
  return arr;
}
