// Pure helpers for the reworkHtml/StyleJson rule-set guards.
// Logic ported verbatim from the original verify-styles.mjs harness — do NOT
// rewrite the algorithms (byte-for-byte fidelity is the point of these guards).
import type { StyleJson } from '../../src/extract.ts';
import { orderPropsShorthandFirst, SHORTHAND_COVERAGE } from '../../src/internal/shorthand.ts';

/** Split a CSS text into top-level blocks; return only `#id…{…}` id-rules. */
export function idRules(css: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = css.length;
  while (i < n) {
    while (i < n && /\s/.test(css[i]!)) i++;
    if (i >= n) break;
    if (css[i] === '@') {
      // @import ...;  or  @font-face{...} / @media{...}
      let j = i;
      let depth = 0;
      let sawBrace = false;
      for (; j < n; j++) {
        if (css[j] === '{') { depth++; sawBrace = true; }
        else if (css[j] === '}') { if (--depth === 0) { j++; break; } }
        else if (css[j] === ';' && !sawBrace && depth === 0) { j++; break; }
      }
      i = j; continue;
    }
    // selector { ... }
    let j = i;
    let depth = 0;
    for (; j < n; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') { if (--depth === 0) { j++; break; } }
    }
    const block = css.slice(i, j).trim();
    i = j;
    if (block.startsWith('#')) out.push(block);
  }
  return out;
}

/** reworkHtml strips all original <style> and appends exactly ONE generated block. */
export function extractGeneratedStyle(html: string): string {
  const m = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)];
  if (!m.length) throw new Error('no <style> in reworked html');
  return m[m.length - 1]![1]!;
}

/** Last <style> block's inner text (or '' if none) — used for <style>-parity checks. */
export function styleOf(html: string): string {
  const m = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)];
  return m.length ? m[m.length - 1]![1]! : '';
}

/** Decls (prop -> "value" | "value !important") → buildStyleString form (prop:value!important).
 *  Shares the product's shorthand-before-longhand emit order (src/shorthand.ts) —
 *  a pure ordering util, NOT the product's rule emitter, so Guard 2's structural
 *  independence (selector shape / which rules exist) is intact; only the
 *  within-rule declaration order (a render-significant emit detail) is matched. */
export function declsToString(decls: Record<string, string>): string {
  return orderPropsShorthandFirst(Object.entries(decls)).map((k) => {
    const val = String(decls[k]);
    return val.endsWith(' !important')
      ? `${k}:${val.slice(0, -' !important'.length)}!important`
      : `${k}:${val}`;
  }).join(';');
}

/**
 * Places where the emission re-order `declsToDeclString` keeps for
 * provenance-less buckets would CHANGE what an extracted bucket renders — the
 * checkable form of the emission-order lemma (Guard 6).
 *
 * Reported pair: a shorthand `S` from `SHORTHAND_COVERAGE` (background/font/…)
 * sitting AFTER a longhand `L` it covers. The net moves `S` in front of `L`,
 * reversing who wins that component, while cascade order says `S` won — and for
 * THESE shorthands nothing can adjudicate, because `expandShorthand` cannot give
 * the value `S` would put in that slot. So the pair must not exist at all: Pass 6b
 * drops a covered longhand its shorthand beats, on the element path and (since the
 * pseudo copy landed) inside `resolvePseudoElement` too. A survivor is a denoise
 * hole with the net deciding that render.
 *
 * MODELLABLE pairs (border/margin/padding/…) are OUT OF SCOPE here. They occur
 * (~60 per fuzz run) and the proof they are safe is REAL but not transferable to
 * the bucket: Pass 6 keeps such a longhand on one of two branches — either
 * `effectivelyEqual(value, computed)`, where the swap is provably render-neutral
 * (the longhand sets exactly what already renders), or `!computed`, which proves
 * nothing but is unreachable for these families (Chrome reports every one of these
 * longhands). The verdict is established during extraction and simply does not
 * travel into the JSON, so the checkable guarantee comes from oracles that see
 * pixels: `test/fuzz-denoise.mts` and the witnesses in `emit-order.browser.test.ts`.
 *
 * What makes the narrow scope SOUND is that the net's coverage sources and the
 * denoise passes now coincide: `coveredForOrdering` reads exactly
 * `expandShorthand` (what Pass 6 consults) ∪ `SHORTHAND_COVERAGE` (Pass 6b), so
 * every swap the net can make has a pass behind it. That correspondence is pinned
 * as its own unit test in `emit-order.test.ts` — this list alone, asserted empty,
 * could never catch a newly added source.
 *
 * Returns human-readable paths (`el7.pseudos.after: background-color under background`).
 */
export function bucketsOutOfEmitOrder(elements: StyleJson): string[] {
  const out: string[] = [];
  const check = (where: string, bucket: Record<string, string> | undefined): void => {
    if (!bucket) return;
    const pos = new Map(Object.keys(bucket).map((k, i) => [k, i]));
    for (const [sh, covered] of Object.entries(SHORTHAND_COVERAGE)) {
      if (!pos.has(sh)) continue;
      for (const lh of covered) {
        if (pos.has(lh) && pos.get(sh)! > pos.get(lh)!) out.push(`${where}: ${lh} under ${sh}`);
      }
    }
  };
  for (const [id, e] of Object.entries(elements)) {
    check(`${id}.base`, e.base);
    for (const [st, b] of Object.entries(e.states ?? {})) check(`${id}.states.${st}`, b);
    for (const [pe, pb] of Object.entries(e.pseudos ?? {})) {
      check(`${id}.pseudos.${pe}`, pb.base);
      for (const [st, b] of Object.entries(pb.states ?? {})) check(`${id}.pseudos.${pe}.states.${st}`, b);
    }
    for (const [i, r] of (e.relational ?? []).entries()) check(`${id}.relational[${i}]`, r.delta);
  }
  return out;
}

/**
 * Reconstruct the reworkHtml rule set from a StyleJson (round-trip).
 *
 * This is a DELIBERATELY INDEPENDENT re-implementation of the product's
 * `styleJsonToRules` (which isn't exported) — Guard 2 proves the JSON rebuilds
 * the baseline via an emitter the product didn't write, so it must NOT import the
 * product's. One intentional divergence: the product skips empty-decl rules
 * (`if (s) rules.push(…)`), this always pushes. They agree today because the
 * reference baseline emits no empty-decl entry; if a future change produced e.g.
 * `base: {}`, this oracle would over-emit `#id{}` and Guard 2 would fail on the
 * oracle, not a product regression. Mirror the empty-decl skip here if that ever
 * happens.
 */
export function rulesFromJson(styles: StyleJson): string[] {
  const idSel = (id: string) =>
    /^-?[A-Za-z_][\w-]*$/.test(id) ? `#${id}` : `[id="${id.replace(/(["\\])/g, '\\$1')}"]`;
  const rules: string[] = [];
  for (const [id, e] of Object.entries(styles)) {
    if (e.base) rules.push(`${idSel(id)}{${declsToString(e.base)}}`);
    for (const [pe, pm] of Object.entries(e.pseudos || {})) {
      if (pm.base) rules.push(`${idSel(id)}::${pe}{${declsToString(pm.base)}}`);
      for (const [st, dd] of Object.entries(pm.states || {})) {
        rules.push(`${idSel(id)}:${st}::${pe}{${declsToString(dd)}}`);
      }
    }
    for (const [st, d] of Object.entries(e.states || {})) rules.push(`${idSel(id)}:${st}{${declsToString(d)}}`);
    for (const rel of e.relational || []) {
      const comb = rel.combinator === ' ' ? ' ' : ` ${rel.combinator} `;
      const pe = rel.pseudo ? `::${rel.pseudo}` : '';
      rules.push(`${idSel(rel.trigger)}:${rel.state}${comb}${idSel(id)}${pe}{${declsToString(rel.delta)}}`);
    }
  }
  return rules;
}

export interface SortedEqResult {
  ok: boolean;
  A: string[];
  B: string[];
  at?: number;
}

/** Order-independent string-array equality (sorts both, compares element-wise). */
export function sortedEq(a: string[], b: string[]): SortedEqResult {
  const A = [...a].sort();
  const B = [...b].sort();
  if (A.length !== B.length) return { ok: false, A, B };
  for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) return { ok: false, A, B, at: i };
  return { ok: true, A, B };
}
