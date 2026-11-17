// vars.ts — resolve CSS var() references and reduce calc() expressions.
//   • var()  — walked with postcss-value-parser (robust to nested funcs / fallbacks).
//   • calc() — reduced with reduce-css-calc (nested, mixed units where possible).
// Custom properties (--*) are read from CSS.getComputedStyleForNode, i.e. the
// cascaded value at this element — exactly what var() resolves to here.

/// <reference path="./types-shims.d.ts" />
import reduceCSSCalc from 'reduce-css-calc';
import valueParser from 'postcss-value-parser';

export function simplifyCalc(value: string): string {
  if (!value.includes('calc(')) return value;
  // reduce-css-calc throws on non-numeric tokens (e.g. `calc(infinity * 1px)`);
  // keep the original so the caller's own infinity handling can take over.
  try {
    // Precision 12, NOT the library-default 5/6: Chrome stores a unitless
    // number (line-height factor) as float32, and `calc(1/0.75)` truncated to
    // `1.333333` parses BELOW 4/3 — the used line-height then floors a whole
    // 1/64 LayoutUnit down (16px → 15.9844px on text-xs). 12 digits round-trip
    // through float32 back onto the browser's own full-precision result.
    return reduceCSSCalc(value, 12);
  } catch {
    return value;
  }
}

/** Out-param for resolveVars: signals an IACVT substitution (see below). */
export interface VarResolveFlags {
  // Set true when an UNDEFINED custom property with no usable fallback was
  // substituted to nothing. Per spec this makes the WHOLE declaration
  // Invalid At Computed-Value Time (IACVT) — the remaining tokens re-parse as a
  // different, valid-but-wrong value. The caller should discard the leftover and
  // materialise the browser's computed value instead.
  invalid: boolean;
}

export function resolveVars(
  value: string,
  vars: Map<string, string>,
  depth = 0,
  flags?: VarResolveFlags,
): string {
  if (depth > 32) return value;
  if (!value.includes('var(')) return value;

  const parsed = valueParser(value);
  parsed.walk((node) => {
    if (node.type !== 'function' || node.value !== 'var') return undefined;
    const nameNode = node.nodes.find((n) => n.type === 'word');
    const name = nameNode ? nameNode.value.trim() : '';
    const v = vars.get(name);

    let resolved: string;
    if (v !== undefined && v !== '') {
      resolved = v;
    } else {
      const commaIdx = node.nodes.findIndex((n) => n.type === 'div' && n.value === ',');
      if (commaIdx >= 0) {
        resolved = resolveVars(valueParser.stringify(node.nodes.slice(commaIdx + 1)).trim(), vars, depth + 1, flags);
      } else {
        resolved = '';
        // Undefined custom prop, no fallback → IACVT (see VarResolveFlags).
        // (A DEFINED-but-empty prop, v==='', substitutes to empty per spec but
        // is NOT flagged here — out of scope for this signal.)
        if (v === undefined && flags) flags.invalid = true;
      }
    }

    // Replace the var() function node in place with its resolved text.
    const w = node as unknown as valueParser.WordNode;
    w.type = 'word';
    w.value = resolved;
    (node as unknown as valueParser.FunctionNode).nodes = [];
    return false; // don't descend into the (now replaced) node
  });

  const out = parsed.toString();
  // A resolved custom-property value may itself contain var() — resolve again.
  if (out.includes('var(')) return resolveVars(out, vars, depth + 1, flags);
  return out;
}
