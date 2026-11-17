// diff.ts — style PATCH between two extracted artifacts A(old) / B(new).
//
// NOT a human diff report: an operational, render-lossless delta.
// `applyStylePatch(A, diffStyles(A, B))` yields a JSON whose `elements` +
// `rootContext` are canonically == B's, so `jsonToHtml` of it renders identically
// to `jsonToHtml(B)`.
//
// PRECONDITION (contract; not detected here): A and B are the SAME DOM/structure,
// extracted with the SAME states/pseudoElements/embedFonts opts, differing ONLY in
// styles. Identical structure ⇒ deterministic id-minting ⇒ a shared, stable id
// space ⇒ the patch keys purely by element id (no structural / children diff).
// Direction A = old, B = new.
//
// GRANULARITY: set/delete operate on LONGHANDS. Both sides' buckets are expanded
// via `expandShorthand`, diffed at the longhand level, and applied at the longhand
// level — so a shorthand-vs-longhand representation difference that renders the
// same (`margin:8px` vs four equal `margin-*`) produces an EMPTY patch, and a
// clean apply is possible regardless of which form each side used. Re-collapsing
// applied longhands back to shorthands is purely cosmetic (render + canonical
// comparison are unaffected) and is intentionally skipped.

import { expandShorthand } from './internal/shorthand.ts';
import { effectivelyEqual } from './internal/resolve.ts';
import { splitTopLevel, splitTopLevelComma } from './internal/value-tokens.ts';
import { colord } from 'colord'; // names plugin already extended by resolve.ts import
import { converter as culoriConverter, parse as culoriParse, differenceCiede2000 } from 'culori';
import type { SelfContainedStyles, StyleJson, StyleEntry, Decls } from './extract.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Patch schema
// ─────────────────────────────────────────────────────────────────────────────

/** A per-bucket delta at LONGHAND granularity. `set` values carry `!important`
 *  folded in (`"red !important"`), matching the `Decls` convention. */
export interface BucketPatch {
  set: Decls;
  delete: string[];
}

/** A cross-element relational entry (same shape as `StyleEntry.relational[n]`). */
export interface RelEntry {
  trigger: string;
  state: string;
  combinator: string;
  pseudo?: string;
  delta: Decls;
}

/** The composite identity of a relational entry (trigger INCLUDED — the stable
 *  id-space precondition makes it safe, and it disambiguates two triggers driving
 *  the same subject: `.foo:hover .bar` vs `.baz:hover .bar`). */
export interface RelKey {
  trigger: string;
  state: string;
  combinator: string;
  pseudo?: string;
}

export interface RelationalPatch {
  upsert?: RelEntry[];
  remove?: RelKey[];
}

export interface ElementPatch {
  /** id present in A but absent in B → drop the whole entry on apply. */
  removed?: true;
  base?: BucketPatch;
  states?: Record<string, BucketPatch>;
  pseudos?: Record<string, { base?: BucketPatch; states?: Record<string, BucketPatch> }>;
  relational?: RelationalPatch;
}

export interface StylePatch {
  elements: Record<string, ElementPatch>;
  /** B's `rootContext` when it differs from A's (the `rem` anchor). */
  rootContext?: { fontSize: string };
  /** B's `fonts` when they differ from A's (`@font-face` / `@import` CSS). */
  fonts?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Value helpers
// ─────────────────────────────────────────────────────────────────────────────

// Props whose VALUE is a case-sensitive string. `effectivelyEqual` lowercases, so
// it would false-equal `"Hello"` vs `"hello"` — a real change silently dropped
// (a correctness hole, not merely a minimality one). Compare these bit-exact.
const CASE_SENSITIVE_PROPS = new Set([
  'content', 'quotes', 'grid-template-areas', 'grid-template', 'grid',
  'counter-reset', 'counter-increment', 'counter-set',
]);

const IMPORTANT_SUFFIX = ' !important';

const collapseWs = (s: string): string => s.trim().replace(/\s+/g, ' ');
// `effectivelyEqual` / `canonValue` lowercase the whole value — but a `url()`
// payload is case-SIGNIFICANT (on a case-sensitive host `url(A.png)` ≠ `url(a.png)`
// are different resources). A url-bearing value is therefore compared case-preserved
// (whitespace-collapsed only); color/zero-unit equivalence inside such a value is
// forgone (at worst a non-minimal — still correct — patch). `valuesEqual` and
// `canonValue` MUST stay in lockstep here or the round-trip oracle would disagree
// with the diff.
const hasUrl = (s: string): boolean => /\burl\(/i.test(s);

function splitImportant(v: string): { bare: string; important: boolean } {
  return v.endsWith(IMPORTANT_SUFFIX)
    ? { bare: v.slice(0, -IMPORTANT_SUFFIX.length), important: true }
    : { bare: v, important: false };
}

// `box-shadow`/`text-shadow` allow the <color> token in a FLEXIBLE position (before
// OR after the lengths), so two renders-identical layers can be written
// `rgba(17,17,17,0.03) 0px 1px 2px` vs `0 1px 2px #11111108`. `effectivelyEqual`
// (whole-value colord OR `normaliseValue`) can't see the equality — the value is
// neither a single color nor a plain-token string. `canonicalizeShadow` parses each
// comma-layer, canonicalises the color (colord → rgb) and zero-lengths, and re-emits
// with the color in a FIXED slot (last). LENGTH ORDER and LAYER ORDER are preserved
// (both are render-significant); only the color token moves. Returns null on any
// layer it cannot FULLY parse (unknown token like `currentColor`/keyword, <2 or >4
// lengths, or a 2nd color) → both call sites (`valuesEqual`, `canonValue`) then fall
// back to `effectivelyEqual`. Deterministic per input string, so the diff predicate
// and the round-trip oracle make the SAME shadow-vs-fallback decision on any value.
const SHADOW_PROPS = new Set(['box-shadow', 'text-shadow']);

// A single length/number token (offset-x/-y, blur, spread); also a bare `0`.
const LENGTH_RE = /^-?(?:\d*\.?\d+)(?:px|em|rem|ex|ch|vw|vh|vmin|vmax|cm|mm|in|pt|pc|q)?$/i;
const isZeroLen = (t: string): boolean =>
  /^-?0(?:\.0+)?(?:px|em|rem|ex|ch|vw|vh|vmin|vmax|cm|mm|in|pt|pc|q)?$/i.test(t);

function canonicalizeShadow(value: string): string | null {
  const layers = splitTopLevelComma(value);
  if (!layers.length) return null;
  const out: string[] = [];
  for (const layer of layers) {
    const toks = splitTopLevel(layer);
    if (!toks.length) return null;
    let inset = false;
    let color: string | null = null;
    const lengths: string[] = [];
    for (const t of toks) {
      if (t.toLowerCase() === 'inset') { inset = true; continue; }
      if (LENGTH_RE.test(t)) { lengths.push(isZeroLen(t) ? '0' : t.toLowerCase()); continue; }
      // Not `inset`, not a length ⇒ must be the (single) color token.
      const c = colord(t);
      if (!c.isValid()) return null; // unknown token (currentColor/keyword) → bail
      if (color !== null) return null; // two colors in one layer → malformed
      // RGB channels are integer-exact; ALPHA is colord-precision (2dp ⇒ ≤~1/255),
      // the SAME fuzz `effectivelyEqual`/`canonValue` apply to every color in the tool
      // (colord rounds alpha at parse). A sub-1/255 alpha delta thus reads as equal —
      // within the render-identity contract (sub-pixel). Known limitation, ARCHITECTURE §9.
      color = c.toRgbString();
    }
    if (lengths.length < 2 || lengths.length > 4) return null; // need offset-x/-y (+blur/+spread)
    const parts: string[] = [];
    if (inset) parts.push('inset');
    parts.push(...lengths);
    if (color) parts.push(color);
    out.push(parts.join(' '));
  }
  return out.join(', ');
}

// ── color canonicalisation (colord primary, culori for wide-gamut + color-mix) ──
//
// colord parses sRGB (hex / rgb / hsl / named). It CANNOT parse `oklch`/`oklab` nor
// the `color-mix()` FUNCTION (verified: culori@4 `parse()` also returns undefined on
// `color-mix()`, though it parses `oklch`/`oklab`). So two representations of ONE
// paint — `rgba(255,255,255,0.15)` vs `color-mix(in oklab,#fff 15%,transparent)`, or
// `#e7e7eb` vs `oklch(…)` — are string-different yet the same colour, and would
// spuriously diff.
//
// `canonicalizeColor` resolves ANY single-colour value to a canonical rgb STRING via
// `colord(...).toRgbString()` — the SAME formatter the existing colord path already
// used — so a culori-resolved colour and a colord-resolved colour emit BYTE-IDENTICAL
// strings. Both `valuesEqual` and `canonValue` route through it, so the diff predicate
// and the round-trip oracle stay in lockstep. The tolerance is integer-channel rounding
// ONLY (~0.5/255, matching colord today); a wide-gamut pair further than that apart
// legitimately stays distinct (e.g. an out-of-tolerance `oklch` border — a residual,
// not a bug). EMIT is never touched: this feeds comparison + the oracle only, so an
// out-of-sRGB-gamut colour is never rewritten in the rendered output.

type Rgb01 = { r: number; g: number; b: number; alpha: number };

const culoriToRgb = culoriConverter('rgb');

// `color-mix()` mixing is only implemented for RECTANGULAR interpolation spaces, where
// premultiplied-alpha LINEAR channel mixing is correct. A POLAR space (contains a hue
// channel — oklch/lch/hsl/hwb) needs circular hue interpolation with a hue method; we
// BAIL there (→ null → the token compare), never computing a wrong equality.
const RECTANGULAR_MIX_SPACES = new Set([
  'oklab', 'lab', 'rgb', 'srgb', 'srgb-linear',
  'xyz', 'xyz-d50', 'xyz-d65', 'display-p3', 'a98-rgb', 'prophoto-rgb', 'rec2020',
]);

const clamp255 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Parse a single colour to 0..1 rgb+alpha — colord first (sRGB/hex/named), then culori
 *  (`oklch`/`oklab`/`lab`/`lch`/…). `transparent` is special-cased (culori `parse()`
 *  returns undefined for the bare keyword). Returns null when neither recognises it (so
 *  a non-colour value like `14px` / `bold` falls through untouched). */
function parseColor01(v: string): Rgb01 | null {
  const s = v.trim();
  if (/^transparent$/i.test(s)) return { r: 0, g: 0, b: 0, alpha: 0 };
  const c = colord(s);
  if (c.isValid()) { const { r, g, b, a } = c.toRgb(); return { r: r / 255, g: g / 255, b: b / 255, alpha: a }; }
  // Gate the culori fallback: it must ONLY see a FUNCTION-form colour (`oklch(`/`oklab(`/
  // `lab(`/`lch(`/`hwb(`/`color(`) or a `#`-hex. culori.parse() otherwise accepts a BARE
  // hex-shaped token — `parse('999')` → `#999999`, `parse('abc')` → `#aabbcc`, `parse('1e3')`
  // → `#11ee33` — which would silently equate a real `z-index: 999 → 999999` change (and,
  // because `canonValue` calls this UN-gated, blind the round-trip oracle to it). A wide-gamut
  // colour is always function-form or `#`-prefixed, so this preserves every real case.
  if (s.startsWith('#') || s.includes('(')) {
    try {
      const p = culoriParse(s);
      if (p) { const r = culoriToRgb(p); if (r) return { r: r.r ?? 0, g: r.g ?? 0, b: r.b ?? 0, alpha: r.alpha ?? 1 }; }
    } catch { /* culori threw on an unrecognised token → not a colour */ }
  }
  return null;
}

/** Evaluate `color-mix(in <space>, c1 [p1%], c2 [p2%])` to 0..1 rgb+alpha with CSS
 *  PREMULTIPLIED-alpha semantics (validated to reproduce the browser result). Returns
 *  null on anything it can't fully parse or a non-rectangular space (see above). */
function evalColorMix(v: string): Rgb01 | null {
  const m = /^color-mix\(\s*([\s\S]*)\)\s*$/i.exec(v.trim());
  if (!m) return null;
  const parts = splitTopLevelComma(m[1]!);
  if (parts.length !== 3) return null;
  const head = parts[0]!.trim().split(/\s+/); // ["in","oklab"] (+ optional hue method)
  if (head[0]?.toLowerCase() !== 'in' || !head[1]) return null;
  const spaceRaw = head[1].toLowerCase();
  if (!RECTANGULAR_MIX_SPACES.has(spaceRaw)) return null;
  const space = spaceRaw === 'srgb' ? 'rgb' : spaceRaw;
  let conv: ReturnType<typeof culoriConverter>;
  try { conv = culoriConverter(space as Parameters<typeof culoriConverter>[0]); } catch { return null; }

  const parseEntry = (entry: string): { col: Rgb01; pct: number | null } | null => {
    let pct: number | null = null;
    const colToks: string[] = [];
    for (const t of entry.trim().split(/\s+/)) {
      const pm = /^([\d.]+)%$/.exec(t);
      if (pm) pct = parseFloat(pm[1]!);
      else colToks.push(t);
    }
    const col = parseColor01(colToks.join(' '));
    return col ? { col, pct } : null;
  };
  const e1 = parseEntry(parts[1]!);
  const e2 = parseEntry(parts[2]!);
  if (!e1 || !e2) return null;

  // Weights: one missing → 100−other; both missing → 50/50; sum<100 → alpha scaled.
  let p1 = e1.pct, p2 = e2.pct;
  if (p1 === null && p2 === null) { p1 = 50; p2 = 50; }
  else if (p1 === null) p1 = 100 - p2!;
  else if (p2 === null) p2 = 100 - p1;
  const sum = p1! + p2!;
  if (sum <= 0) return null;
  const w1 = p1! / sum, w2 = p2! / sum;
  const alphaScale = sum < 100 ? sum / 100 : 1;

  const toSpace = (c: Rgb01): Record<string, number> & { mode: string } =>
    conv({ mode: 'rgb', r: c.r, g: c.g, b: c.b, alpha: c.alpha }) as unknown as Record<string, number> & { mode: string };
  const A = toSpace(e1.col), B = toSpace(e2.col);
  const a1 = A.alpha ?? 1, a2 = B.alpha ?? 1;
  const outAlpha = a1 * w1 + a2 * w2;
  const mixed: Record<string, number | string> = { mode: A.mode };
  for (const ch of Object.keys(A)) {
    if (ch === 'mode' || ch === 'alpha') continue;
    const v1 = A[ch] ?? 0, v2 = B[ch] ?? 0;
    mixed[ch] = outAlpha === 0 ? 0 : (v1 * a1 * w1 + v2 * a2 * w2) / outAlpha; // premultiplied
  }
  mixed.alpha = outAlpha * alphaScale;
  const r = culoriToRgb(mixed as unknown as Parameters<typeof culoriToRgb>[0]);
  if (!r) return null;
  return { r: r.r ?? 0, g: r.g ?? 0, b: r.b ?? 0, alpha: r.alpha ?? 1 };
}

/** Canonicalise a SINGLE-colour value to a stable rgb string (colord's formatter), or
 *  null when it isn't a recognisable single colour. colord-parseable colours take the
 *  fast path (byte-identical to the pre-existing behaviour → golden-safe); only
 *  `color-mix()` / wide-gamut values engage culori. */
export function canonicalizeColor(v: string): string | null {
  const s = v.trim();
  const format = (rgb: Rgb01 | null): string | null => {
    if (!rgb) return null;
    const out = colord({ r: clamp255(rgb.r * 255), g: clamp255(rgb.g * 255), b: clamp255(rgb.b * 255), a: clamp01(rgb.alpha) });
    return out.isValid() ? out.toRgbString() : null;
  };
  if (/^color-mix\(/i.test(s)) return format(evalColorMix(s));
  const c = colord(s);
  if (c.isValid()) return c.toRgbString(); // fast path: byte-identical to prior behaviour
  return format(parseColor01(s));          // culori wide-gamut (oklch/oklab/…)
}

// ── perceptual colour near-equality (WEB-UI DISPLAY ONLY — never in the oracle) ──
//
// A design-token migration (`rgb(…)` → `oklch(…)`) shifts channels by ~2-3/255 — integer-
// DISTINCT (so `valuesEqual`/`canonValue`/`canonicalizeColor` correctly still SEE it, staying
// integer-exact for the same-DOM patch + round-trip oracle) yet perceptually IDENTICAL. The
// web-UI diff (`diffService.buildChanges`) uses this to route such a change to `appliedHidden`:
// invisible in the shown diff, but the EXACT new colour still applies (render unchanged). This
// is a PURE, side-effect-free predicate called ONLY from that display layer — it never weakens
// the exact colour paths above.
//
// Metric: CIEDE2000 (ΔE2000). Threshold 5.0 — empirically past the token-migration noise floor
// (≤3.07 on the reference fixture) and well under a real recolour (≥8.4). ALPHA is compared
// SEPARATELY (ΔE2000 is alpha-blind): a >0.02 alpha gap (a colour appearing/disappearing, e.g.
// `transparent`→opaque) is NOT near-equal. Either side unparseable (`currentcolor`, a keyword)
// → false → the change stays visible.
const deltaE2000 = differenceCiede2000();
const parseAnyColor01 = (v: string): Rgb01 | null =>
  /^color-mix\(/i.test(v.trim()) ? evalColorMix(v) : parseColor01(v);

/** True when two single-colour values are perceptually near-identical (ΔE2000 ≤ 5.0 and
 *  their alphas within 0.02). Unparseable either side → false. DISPLAY-ONLY (see above). */
export function colorNearEqual(a: string, b: string): boolean {
  const ca = parseAnyColor01(a), cb = parseAnyColor01(b);
  if (!ca || !cb) return false;
  if (Math.abs(ca.alpha - cb.alpha) > 0.02) return false;
  const A = { mode: 'rgb' as const, r: ca.r, g: ca.g, b: ca.b };
  const B = { mode: 'rgb' as const, r: cb.r, g: cb.g, b: cb.b };
  return deltaE2000(A, B) <= 5.0;
}

// `rem` anchor context for a value compare: each side's root `font-size` in px
// (`undefined` when the artifact carries no `rootContext` — whole-doc mode). Built
// once per `diffStyles`/`computeDiff` run and threaded to every `valuesEqual`.
export type RemCtx = { aFs?: number; bFs?: number };

/** Parse a `rootContext.fontSize` string (`"16px"`) to px; `undefined` if absent
 *  or unparseable. */
export function parseRootPx(fontSize?: string): number | undefined {
  if (!fontSize) return undefined;
  const n = parseFloat(fontSize);
  return Number.isFinite(n) ? n : undefined;
}

// A number immediately followed by the `rem` unit (`1rem`, `0.875rem`, `.5rem`).
// Separate non-global (`.test`) / global (`.replace`) instances — a shared global
// regex carries `lastIndex` state across calls.
const hasRem = (v: string): boolean => /(?:\d*\.)?\d+rem\b/i.test(v);
/** Resolve every `Nrem` token in `v` to `(N*fs)px` (the browser's own anchoring).
 *  Rounded to 4 dp to shed IEEE-754 noise (`0.3*16 = 4.800000000000001`), so a
 *  resolved `rem` compares equal to a cleanly-authored `px` of the same length. */
const resolveRem = (v: string, fs: number): string =>
  v.replace(/(-?(?:\d*\.)?\d+)rem\b/gi, (_m, n: string) => `${+(parseFloat(n) * fs).toFixed(4)}px`);

// A near-infinite border-radius pill (`calc(infinity*1px)`) computes to FLT_MAX
// (`3.40282e+38px`); the extractor clamps it to `9999px` at SOURCE (`clampHugeRadius`,
// threshold `1e6px`), but a stored artifact that predates the clamp still carries the
// raw FLT_MAX. Both max every real box's corner, so `9999px` and `3.40282e+38px` are the
// SAME render — canonicalise any px length ≥ the same `1e6` threshold to `9999px` (a fixed
// point: 9999 < 1e6) so the two representations compare/canon equal. COMPARISON + ORACLE
// only (lockstep valuesEqual/canonValue) — the emitted value is never rewritten. Matches
// a scientific-notation exponent explicitly (`3.40282e+38px`), which a bare `\d+px` misses.
const HUGE_LEN_PX = 1e6;
const isRadiusProp = (prop: string): boolean => prop.endsWith('radius');
const hasHugeRadius = (v: string): boolean => /-?[\d.]+(?:e[+-]?\d+)?px/i.test(v);
const canonRadius = (v: string): string =>
  v.replace(/-?[\d.]+(?:e[+-]?\d+)?px/gi, (m) => (parseFloat(m) >= HUGE_LEN_PX ? '9999px' : m));

/** Do two folded declaration values render identically for `prop`?
 *  `!important` flags must match (`red` ≠ `red !important`); the bare values are
 *  compared case-exact for string-valued props, case-preserved for `url()`-bearing
 *  values (see `hasUrl`), else via `effectivelyEqual` (colors/zero-units/
 *  whitespace-insensitive) — with two representation-invariant pre-steps:
 *   • SHADOW props: color-position / color-format / zero-unit are canonicalised so a
 *     reordered-color layer compares equal (see `canonicalizeShadow`).
 *   • `rem`: resolved to px ONLY when SAFE — both anchors present AND equal (`remCtx`).
 *     Then a `rem`-vs-`px` representation of the SAME length compares equal. When the
 *     anchors DIFFER (or one is absent), `rem` stays a TOKEN: resolving it would
 *     false-equal a value that must change when the anchor changes (A=`1rem`@16 vs
 *     B=`0.8rem`@20 both = 16px, but apply re-anchors to B → `1rem` would become
 *     20px ≠ 16px), so the diff must SHOW it. The `rootContext` patch (§11) carries
 *     the anchor. When neither side has `rem`, this is a no-op (plain `px` compare). */
export function valuesEqual(prop: string, a: string, b: string, remCtx?: RemCtx): boolean {
  const A = splitImportant(a);
  const B = splitImportant(b);
  if (A.important !== B.important) return false;
  if (CASE_SENSITIVE_PROPS.has(prop)) return A.bare.trim() === B.bare.trim();
  if (hasUrl(A.bare) || hasUrl(B.bare)) return collapseWs(A.bare) === collapseWs(B.bare);
  // rem→px pre-step (guarded): only when both anchors are present AND equal.
  let av = A.bare;
  let bv = B.bare;
  if (
    remCtx && remCtx.aFs !== undefined && remCtx.bFs !== undefined && remCtx.aFs === remCtx.bFs &&
    (hasRem(av) || hasRem(bv))
  ) {
    av = resolveRem(av, remCtx.aFs);
    bv = resolveRem(bv, remCtx.aFs);
  }
  // huge-radius canon (comparison-only): a FLT_MAX pill == a `9999px` pill.
  if (isRadiusProp(prop)) {
    if (hasHugeRadius(av)) av = canonRadius(av);
    if (hasHugeRadius(bv)) bv = canonRadius(bv);
  }
  if (SHADOW_PROPS.has(prop)) {
    const sa = canonicalizeShadow(av);
    const sb = canonicalizeShadow(bv);
    if (sa !== null && sb !== null) return sa === sb; // both fully parsed → repr-invariant compare
    // else at least one is unparseable → fall through to effectivelyEqual (token)
  }
  // Wide-gamut / color-mix equality: colord (and thus `effectivelyEqual`) can't parse
  // `oklch`/`oklab`/`color-mix()`, so a rgba-vs-color-mix representation of ONE colour
  // would spuriously differ. Engage ONLY when at least one side is NOT colord-parseable,
  // so ordinary colord↔colord pairs keep their exact `effectivelyEqual` path (golden-safe);
  // `canonValue` routes the same values through `canonicalizeColor`, keeping the oracle in
  // lockstep (applied's rgba and B's color-mix both canonicalise to the same rgb string).
  if (!colord(av).isValid() || !colord(bv).isValid()) {
    const ca = canonicalizeColor(av);
    const cb = canonicalizeColor(bv);
    if (ca !== null && cb !== null) return ca === cb;
  }
  return effectivelyEqual(av, bv);
}

// ── importance-only phantom (WEB-UI DISPLAY ONLY — never in the oracle) ───────────
//
// A reworked artifact gives each element ONE rule with no competing declaration, so
// `!important` is INERT (it only matters against a competitor). An extraction that
// adds `!important` to an already-winning value — `height:48px` → `height:3rem
// !important` where `3rem`≡`48px` at the shared anchor — renders IDENTICALLY: a pure
// phantom. But `valuesEqual` (correctly, for the same-DOM patch oracle) treats
// `!important` as significant, so the change surfaces. `diffService.buildChanges`
// uses this predicate to route such a change to `appliedHidden`: invisible in the
// shown diff, yet the EXACT new value (incl. `!important`) still applies — so the
// render (and any state/hover competitor that WOULD honour `!important`) is preserved.
//
// PURE, side-effect-free, DISPLAY-ONLY: it never weakens the exact `valuesEqual`/
// `canonValue` paths — it merely REUSES `valuesEqual` on the bare (importance-stripped)
// values, which is the strict oracle with the `!important` guard trivially satisfied
// (both bare, so both `important:false`), so all its canon (rem-guard/shadow/colour/
// effectivelyEqual) still decides bare-equality.

/** True when `a` and `b` differ ONLY in `!important` — their bare values are equal per
 *  the strict `valuesEqual` oracle but the importance flags disagree. A same-importance
 *  or bare-DIFFERENT pair → false (a real change stays visible). DISPLAY-ONLY. */
export function importanceOnlyDiff(prop: string, a: string, b: string, remCtx?: RemCtx): boolean {
  const A = splitImportant(a);
  const B = splitImportant(b);
  if (A.important === B.important) return false;
  return valuesEqual(prop, A.bare, B.bare, remCtx);
}

/** Expand every declaration in a bucket to LONGHANDS (order-preserving, later
 *  wins — so a shorthand followed by a longhand override behaves as in CSS).
 *  `!important` is stripped before expansion and re-folded onto each longhand.
 *  A non-shorthand (or an un-expandable value) is kept verbatim.
 *
 *  Exported as the CANONICAL longhand expander (ARCHITECTURE §11): it is the one
 *  that produced every `BucketPatch.set` value, so a consumer computing the matching
 *  `before` value (2c's old→new display) MUST expand the left bucket with THIS — a
 *  second copy would drift the two out of longhand alignment. */
export function expandBucket(decls: Decls | undefined): Decls {
  const out: Decls = {};
  if (!decls) return out;
  for (const [prop, raw] of Object.entries(decls)) {
    const { bare, important } = splitImportant(raw);
    const expanded = expandShorthand(prop, bare);
    if (expanded) {
      for (const [lh, v] of expanded) out[lh] = important ? `${v}${IMPORTANT_SUFFIX}` : v;
    } else {
      out[prop] = raw;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// diff
// ─────────────────────────────────────────────────────────────────────────────

/** Longhand-level delta from bucket A → bucket B; `undefined` if identical. */
function diffBucket(a: Decls | undefined, b: Decls | undefined, remCtx?: RemCtx): BucketPatch | undefined {
  const aL = expandBucket(a);
  const bL = expandBucket(b);
  const set: Decls = {};
  const del: string[] = [];
  for (const [prop, bv] of Object.entries(bL)) {
    const av = aL[prop];
    if (av === undefined || !valuesEqual(prop, av, bv, remCtx)) set[prop] = bv;
  }
  for (const prop of Object.keys(aL)) {
    if (!(prop in bL)) del.push(prop);
  }
  if (Object.keys(set).length === 0 && del.length === 0) return undefined;
  return { set, delete: del };
}

const relKeyStr = (e: { trigger: string; state: string; combinator: string; pseudo?: string }): string =>
  `${e.state}|${e.combinator}|${e.pseudo ?? ''}|${e.trigger}`;

function diffRelational(a: RelEntry[] = [], b: RelEntry[] = [], remCtx?: RemCtx): RelationalPatch | undefined {
  const aMap = new Map(a.map((e) => [relKeyStr(e), e]));
  const bMap = new Map(b.map((e) => [relKeyStr(e), e]));
  const upsert: RelEntry[] = [];
  const remove: RelKey[] = [];
  for (const [k, be] of bMap) {
    const ae = aMap.get(k);
    // Trigger is part of the key ⇒ equal here; only the delta can differ.
    if (!ae || diffBucket(ae.delta, be.delta, remCtx)) upsert.push(be);
  }
  for (const [k, ae] of aMap) {
    if (!bMap.has(k)) {
      const rk: RelKey = { trigger: ae.trigger, state: ae.state, combinator: ae.combinator };
      if (ae.pseudo !== undefined) rk.pseudo = ae.pseudo;
      remove.push(rk);
    }
  }
  if (upsert.length === 0 && remove.length === 0) return undefined;
  const out: RelationalPatch = {};
  if (upsert.length) out.upsert = upsert;
  if (remove.length) out.remove = remove;
  return out;
}

function unionKeys(a: Record<string, unknown> = {}, b: Record<string, unknown> = {}): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])];
}

/** Delta from entry A → entry B; `undefined` if identical. `remCtx` (both sides'
 *  `rem` anchors) enables the guarded `rem`→px compare in `valuesEqual`; omit it to
 *  compare `rem` as a token (the safe default for callers with no `rootContext`). */
function diffElement(a: StyleEntry, b: StyleEntry, remCtx?: RemCtx): ElementPatch | undefined {
  const patch: ElementPatch = {};

  const base = diffBucket(a.base, b.base, remCtx);
  if (base) patch.base = base;

  const states: Record<string, BucketPatch> = {};
  for (const st of unionKeys(a.states, b.states)) {
    const d = diffBucket(a.states?.[st], b.states?.[st], remCtx);
    if (d) states[st] = d;
  }
  if (Object.keys(states).length) patch.states = states;

  const pseudos: Record<string, { base?: BucketPatch; states?: Record<string, BucketPatch> }> = {};
  for (const pe of unionKeys(a.pseudos, b.pseudos)) {
    const ap = a.pseudos?.[pe] ?? {};
    const bp = b.pseudos?.[pe] ?? {};
    const pePatch: { base?: BucketPatch; states?: Record<string, BucketPatch> } = {};
    const pb = diffBucket(ap.base, bp.base, remCtx);
    if (pb) pePatch.base = pb;
    const pStates: Record<string, BucketPatch> = {};
    for (const st of unionKeys(ap.states, bp.states)) {
      const d = diffBucket(ap.states?.[st], bp.states?.[st], remCtx);
      if (d) pStates[st] = d;
    }
    if (Object.keys(pStates).length) pePatch.states = pStates;
    if (pePatch.base || pePatch.states) pseudos[pe] = pePatch;
  }
  if (Object.keys(pseudos).length) patch.pseudos = pseudos;

  const rel = diffRelational(a.relational, b.relational, remCtx);
  if (rel) patch.relational = rel;

  return Object.keys(patch).length ? patch : undefined;
}

/** Delta from entry A → entry B; `undefined` if identical. Exported as the
 *  id-agnostic pair-diff primitive (see `diff-tree.ts` `diffPair`). */
export { diffElement };

/** Pure per-element diff of two `StyleJson` maps → id → ElementPatch. `remCtx` is
 *  threaded to `valuesEqual` (see `diffElement`); `diffStyles` supplies it from both
 *  artifacts' `rootContext`. */
export function diffElements(a: StyleJson, b: StyleJson, remCtx?: RemCtx): Record<string, ElementPatch> {
  const out: Record<string, ElementPatch> = {};
  for (const id of unionKeys(a, b)) {
    const ae = a[id];
    const be = b[id];
    if (ae && !be) {
      out[id] = { removed: true };
    } else if (!ae && be) {
      const p = diffElement({}, be, remCtx);
      if (p) out[id] = p;
    } else if (ae && be) {
      const p = diffElement(ae, be, remCtx);
      if (p) out[id] = p;
    }
  }
  return out;
}

/** Full patch A → B (elements + rootContext + fonts). */
export function diffStyles(a: SelfContainedStyles, b: SelfContainedStyles): StylePatch {
  const remCtx: RemCtx = { aFs: parseRootPx(a.rootContext?.fontSize), bFs: parseRootPx(b.rootContext?.fontSize) };
  const patch: StylePatch = { elements: diffElements(a.elements, b.elements, remCtx) };
  // `&& b.rootContext` is deliberate: rootContext PRESENCE differing between A and B
  // (one whole-doc, one subtree) is precondition-excluded (same extraction opts +
  // same structure ⇒ same mode). Only its fontSize VALUE can differ. Emitting a
  // `rootContext: undefined` "drop" here would also break JSON round-trip (the key
  // vanishes on stringify), so we intentionally never emit it — unlike `fonts`,
  // whose "drop" is a real empty string and survives serialisation.
  if ((a.rootContext?.fontSize ?? undefined) !== (b.rootContext?.fontSize ?? undefined) && b.rootContext) {
    patch.rootContext = { fontSize: b.rootContext.fontSize };
  }
  if (a.fonts !== b.fonts) patch.fonts = b.fonts;
  return patch;
}

// ─────────────────────────────────────────────────────────────────────────────
// apply
// ─────────────────────────────────────────────────────────────────────────────

/** Apply a bucket patch to A's bucket → new longhand-level `Decls` (or `undefined`
 *  if the result is empty, so an emptied bucket disappears). If `bp` is undefined
 *  the bucket is untouched (A's original representation kept). */
export function applyBucket(existing: Decls | undefined, bp: BucketPatch | undefined): Decls | undefined {
  if (!bp) return existing;
  const long = expandBucket(existing);
  for (const prop of bp.delete) delete long[prop];
  for (const [prop, v] of Object.entries(bp.set)) long[prop] = v;
  return Object.keys(long).length ? long : undefined;
}

function applyRelational(existing: RelEntry[] | undefined, rp: RelationalPatch): RelEntry[] | undefined {
  const arr: RelEntry[] = existing ? existing.map((e) => ({ ...e })) : [];
  let out = arr;
  if (rp.remove?.length) {
    const dead = new Set(rp.remove.map(relKeyStr));
    out = out.filter((e) => !dead.has(relKeyStr(e)));
  }
  for (const u of rp.upsert ?? []) {
    const k = relKeyStr(u);
    const entry: RelEntry = { ...u, delta: { ...u.delta } }; // don't alias the patch into the output
    const idx = out.findIndex((e) => relKeyStr(e) === k);
    if (idx >= 0) out[idx] = entry;
    else out.push(entry);
  }
  return out.length ? out : undefined;
}

const clone = <T>(v: T): T => (v === undefined ? v : (structuredClone(v) as T));

/** True when a `StyleEntry` has no buckets left. B omits empty entries, so an entry
 *  emptied by a patch must be pruned. The single home for the `StyleEntry` bucket
 *  set — reused by `applyStylePatch` and diff-tree.ts's `applyDiff` so a new bucket
 *  can't drift the two apply paths. */
export function isEmptyEntry(e: StyleEntry): boolean {
  return !e.base && !e.states && !e.pseudos && !e.relational;
}

/** Apply a NON-`removed` `ElementPatch` to a `StyleEntry` in place (base / states /
 *  pseudos / relational). The caller owns cloning and the final empty-entry prune
 *  (`removed` and the prune stay in `applyStylePatch`). Reused by `diff-tree.ts`'s
 *  structural apply to translate a right→left style delta onto one entry. */
export function applyElementPatch(e: StyleEntry, ep: ElementPatch): void {
  if (ep.base) {
    const r = applyBucket(e.base, ep.base);
    if (r) e.base = r;
    else delete e.base;
  }

  if (ep.states) {
    e.states ??= {};
    for (const [st, bp] of Object.entries(ep.states)) {
      const r = applyBucket(e.states[st], bp);
      if (r) e.states[st] = r;
      else delete e.states[st];
    }
    if (!Object.keys(e.states).length) delete e.states;
  }

  if (ep.pseudos) {
    e.pseudos ??= {};
    for (const [pe, pp] of Object.entries(ep.pseudos)) {
      const peEntry = e.pseudos[pe] ?? (e.pseudos[pe] = {});
      if (pp.base) {
        const r = applyBucket(peEntry.base, pp.base);
        if (r) peEntry.base = r;
        else delete peEntry.base;
      }
      if (pp.states) {
        peEntry.states ??= {};
        for (const [st, bp] of Object.entries(pp.states)) {
          const r = applyBucket(peEntry.states[st], bp);
          if (r) peEntry.states[st] = r;
          else delete peEntry.states[st];
        }
        if (!Object.keys(peEntry.states).length) delete peEntry.states;
      }
      if (!peEntry.base && !peEntry.states) delete e.pseudos[pe];
    }
    if (!Object.keys(e.pseudos).length) delete e.pseudos;
  }

  if (ep.relational) {
    const r = applyRelational(e.relational, ep.relational);
    if (r) e.relational = r;
    else delete e.relational;
  }
}

/** Apply a patch to A → a NEW `SelfContainedStyles` whose `elements` + `rootContext`
 *  are canonically == B's. A is never mutated. `tree` is taken from A (identical
 *  structure by precondition). */
export function applyStylePatch(a: SelfContainedStyles, patch: StylePatch): SelfContainedStyles {
  const elements: StyleJson = clone(a.elements);

  for (const [id, ep] of Object.entries(patch.elements)) {
    if (ep.removed) {
      delete elements[id];
      continue;
    }
    const e: StyleEntry = elements[id] ?? (elements[id] = {});

    applyElementPatch(e, ep);

    // Prune an entry emptied by the patch (B omits empty entries).
    if (isEmptyEntry(e)) delete elements[id];
  }

  const out: SelfContainedStyles = {
    tree: a.tree,
    fonts: 'fonts' in patch && patch.fonts !== undefined ? patch.fonts : a.fonts,
    elements,
  };
  // widgetCss is not diffed (backlog t-widget-diff): same-DOM pairs share the
  // same widget rules, so A's carry through verbatim.
  if (a.widgetCss) out.widgetCss = a.widgetCss;
  const rootContext = 'rootContext' in patch ? patch.rootContext : a.rootContext;
  if (rootContext) out.rootContext = { ...rootContext }; // fresh object — never alias A or the patch
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// canonicalStyleJson — INDEPENDENT round-trip oracle
// ─────────────────────────────────────────────────────────────────────────────
//
// Normalises a StyleJson to a comparable form WITHOUT going through diff/apply:
// every bucket is expanded to sorted longhands and every value is canonicalised
// (colors → rgb, zero-units, whitespace, case-folded — except case-sensitive
// props). Two artifacts are canonically equal iff their canonicalStyleJson deep-
// equal. Used to verify round-trip (`applied == B`) independently of the diff
// code, so a diff bug can't hide in both the patch and its own equality check.

// DO NOT CONSOLIDATE (scalar/color/zero path): this is an intentional copy of
// resolve.ts `normaliseValue` + `effectivelyEqual`'s color branch, NOT a candidate
// for de-duplication. The diff path uses `effectivelyEqual` (`valuesEqual`); routing
// the oracle through the same helper would make the round-trip test validate the
// diff with the diff's own equality primitive — a bug would then hide in both. Keep
// it independent (and note the shape differs: this canonicalises to a string, while
// `effectivelyEqual` is a pairwise predicate).
//
// EXCEPTION — SHADOW props: `canonicalizeShadow` is deliberately SHARED with
// `valuesEqual` here (a single canonicaliser, not two hand-written parsers). This is
// a conscious deviation from the independence rule above: when shadows DIFFER, apply
// sets B and the oracle compares canon(B) vs canon(B) — a no-op — so the round-trip
// oracle only ever independently validated the "wrongly-equates-DIFFERENT-shadows"
// direction, which sharing would kill anyway. That check is instead carried by the
// GOLDEN battery (`test/diff.test.ts`), whose expected patches/outputs are
// hand-authored (never routed through `canonValue`) and span every parsed dimension
// (offset-x/-y, blur, spread, inset, color, layer-count, layer-order). A second
// independent shadow parser would be its own bug surface for no real gain.
function canonValue(prop: string, raw: string, rootFs?: number): string {
  const { bare, important } = splitImportant(raw);
  let v = bare.trim();
  if (!CASE_SENSITIVE_PROPS.has(prop)) {
    if (hasUrl(v)) {
      v = collapseWs(v); // case-preserved (lockstep with valuesEqual's url path)
    } else {
      // rem→px, lockstep with valuesEqual's guarded pre-step. `rootFs` is the
      // artifact's OWN anchor; the suppress path only fires with equal anchors, so
      // canon(applied) and canon(B) resolve against the same fs (§11).
      if (rootFs !== undefined && hasRem(v)) v = resolveRem(v, rootFs);
      // huge-radius canon, lockstep with valuesEqual (oracle stays in step: applied's
      // clamped `9999px` and B's raw FLT_MAX canonicalise to the SAME `9999px`).
      if (isRadiusProp(prop) && hasHugeRadius(v)) v = canonRadius(v);
      const shadow = SHADOW_PROPS.has(prop) ? canonicalizeShadow(v) : null;
      if (shadow !== null) {
        v = shadow; // lockstep with valuesEqual's shadow path
      } else {
        // `canonicalizeColor` = colord fast-path (byte-identical to the prior
        // `colord(v).toRgbString()`) PLUS culori for `oklch`/`oklab`/`color-mix()`, so a
        // wide-gamut colour canonicalises to the SAME rgb string as its rgba twin —
        // lockstep with valuesEqual's colour path (§11).
        const cc = canonicalizeColor(v);
        if (cc !== null) v = cc;
        else v = v.toLowerCase().replace(/\s+/g, ' ').replace(/(^|[^a-z0-9])0(?:px|em|rem|%)\b/g, '$10');
      }
    }
  }
  return important ? `${v}${IMPORTANT_SUFFIX}` : v;
}

function canonBucket(decls: Decls | undefined, rootFs?: number): Decls | undefined {
  const long = expandBucket(decls);
  const keys = Object.keys(long).sort();
  if (!keys.length) return undefined;
  const out: Decls = {};
  for (const k of keys) out[k] = canonValue(k, long[k]!, rootFs);
  return out;
}

/** `rootFs` = this artifact's `rootContext.fontSize` in px; when given, authored
 *  `rem` is resolved to px so a `rem`-vs-`px` representation of the same length
 *  canonicalises identically (kept in lockstep with `valuesEqual`). Omit it to
 *  leave `rem` as a token (whole-doc mode / no anchor). */
export function canonicalStyleJson(j: StyleJson, rootFs?: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const id of Object.keys(j).sort()) {
    const e = j[id]!;
    const entry: Record<string, unknown> = {};
    const base = canonBucket(e.base, rootFs);
    if (base) entry.base = base;
    if (e.states) {
      const s: Record<string, unknown> = {};
      for (const st of Object.keys(e.states).sort()) {
        const b = canonBucket(e.states[st], rootFs);
        if (b) s[st] = b;
      }
      if (Object.keys(s).length) entry.states = s;
    }
    if (e.pseudos) {
      const p: Record<string, unknown> = {};
      for (const pe of Object.keys(e.pseudos).sort()) {
        const pv = e.pseudos[pe]!;
        const pEntry: Record<string, unknown> = {};
        const pb = canonBucket(pv.base, rootFs);
        if (pb) pEntry.base = pb;
        if (pv.states) {
          const ps: Record<string, unknown> = {};
          for (const st of Object.keys(pv.states).sort()) {
            const b = canonBucket(pv.states[st], rootFs);
            if (b) ps[st] = b;
          }
          if (Object.keys(ps).length) pEntry.states = ps;
        }
        if (Object.keys(pEntry).length) p[pe] = pEntry;
      }
      if (Object.keys(p).length) entry.pseudos = p;
    }
    if (e.relational?.length) {
      entry.relational = [...e.relational]
        .map((r) => ({
          trigger: r.trigger,
          state: r.state,
          combinator: r.combinator,
          pseudo: r.pseudo ?? '',
          delta: canonBucket(r.delta, rootFs) ?? {},
        }))
        .sort((x, y) => relKeyStr(x).localeCompare(relKeyStr(y)));
    }
    if (Object.keys(entry).length) out[id] = entry;
  }
  return out;
}
