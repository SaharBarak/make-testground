// Make filter evaluation. A filter is { name, conditions: [[AND...], OR [[...]]] }
// — outer array = OR groups, inner arrays = ANDed conditions.
import { render, truthy } from "./iml.mjs";

const OPS = {
  "exist": (a) => truthy(a) || a === 0 || a === false ? a !== undefined && a !== null && a !== "" : false,
  "notexist": (a) => a === undefined || a === null || a === "",
  "text:equal": (a, b) => String(a ?? "") === String(b ?? ""),
  "text:equal:ci": (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase(),
  "text:notequal": (a, b) => String(a ?? "") !== String(b ?? ""),
  "text:contain": (a, b) => String(a ?? "").includes(String(b ?? "")),
  "text:contain:ci": (a, b) => String(a ?? "").toLowerCase().includes(String(b ?? "").toLowerCase()),
  "text:notcontain:ci": (a, b) => !String(a ?? "").toLowerCase().includes(String(b ?? "").toLowerCase()),
  "text:empty": (a) => a === undefined || a === null || String(a) === "",
  "text:notempty": (a) => !(a === undefined || a === null || String(a) === ""),
  "number:equal": (a, b) => Number(a) === Number(b),
  "number:notequal": (a, b) => Number(a) !== Number(b),
  "number:greater": (a, b) => Number(a) > Number(b),
  "number:less": (a, b) => Number(a) < Number(b),
  "boolean:equal": (a, b) => String(a) === String(b),
};

export function passesFilter(filter, bundles) {
  if (!filter?.conditions?.length) return true;
  return filter.conditions.some((group) =>
    group.every((cond) => {
      const a = render(cond.a, bundles);
      const b = render(cond.b, bundles);
      const op = OPS[cond.o];
      if (!op) throw new Error(`filter: unsupported operator ${cond.o}`);
      return op(a, b);
    }),
  );
}
