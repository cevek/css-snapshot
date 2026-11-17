// probe-matcher.ts — browser-side author-cascade matcher (perf: replaces the
// per-node CSS.getMatchedStylesForNode with ONE probe-sheet injection + ONE
// marker-read evaluate). Ported from the validated spike (`spike-probe.ts`,
// t-fhs59y) which differentially matched CDP getMatchedStylesForNode 441/441 on a
// real production Tailwind site.
//
// WHY this exists: getMatchedStylesForNode re-matches the node AND its whole
// ancestor chain per call, and the CDP backend serialises the calls → ~110s for
// 441 nodes. Instead we let the BROWSER ITSELF do the matching: inject a generated
// "probe sheet" (each author (rule, selector) becomes `SEL{--czp<i>:1}` wrapped in
// the rule's real @media/@supports/@container/@scope stack), then read every
// element's set markers in ONE evaluate — the real engine has already evaluated
// every condition against real layout. ~0.4s.
//
// ── The seam ──────────────────────────────────────────────────────────────────
// Output feeds the EXISTING resolveElementStyles(tag, matched, …) → cascadeResolve
// UNTOUCHED. cascadeResolve picks the winner by (important, PUSH-ORDER); it trusts
// `matchedCSSRules` to be in ASCENDING cascade order (winner LAST). Our glue sort
// (`cmpRules`: layer first-mention order → specificity → source order) produces
// exactly that order. See cascade.ts.
//
// ── Scope ───────────────────────────────────────────────────────────────────────
// This is a PURE AUTHOR-CASCADE matcher: it synthesizes ONLY `matchedCSSRules`
// (origin 'regular') + `pseudoElements`. `inlineStyle` / `attributesStyle` are left
// UNSET — the caller assembles those tiers from `CSS.getInlineStylesForNode` (the
// browser's own presentational-attribute mapping, no ancestor re-match). cascadeResolve
// pushes attrs lowest and inline highest around whatever we return, so this is composable.
//
// ── Dual-source rule inventory (§2 of buildProbeMatcher) ─────────────────────────
// `CSS.getStyleSheetText` returns a sheet's SOURCE text, which MISSES rules a page adds
// at runtime via `insertRule` (a URL-backed Vite/Tailwind dev sheet, CSS-in-JS "speedy"
// mode) — the call SUCCEEDS but the text is stale, a SILENT miss. So per sheet we compare
// the text-parse rule count against a LIVE CSSOM census; a mismatch (or unreadable text)
// ⇒ the sheet is CSSOM-authoritative and HARVESTED from the live CSSOM in-page instead of
// parsed from text. Pristine (static) sheets keep the raw-text parse — a NO-OP. The detector
// is DIRECTIONAL: it harvests only when the live CSSOM has STRICTLY MORE rules than the text
// (`census > text`, the insertRule signature); the reverse (`text > census`, css-tree keeping
// a browser-dropped pseudo) is a pristine representation quirk, not a mutation. In the harvest
// direction it is fail-open (a CSSOM inventory is render-correct; only the value representation
// differs, the same class as CDP's own reserialization). Ported from the validated spike
// (spike-probe.ts, t-0a7afv: 80/80 match-set/order/winner on a live Vite dev server).
//
// ── Unproven surfaces (⚑ → risk, consumed at TWO granularities by the driver) ────
// The returned matcher's `risk` (see ProbeRisk) is consumed as:
//  • `mustFallbackToCdp` = the AT-REST-poisoning set (`scope` | `sourcelessSheet` |
//    `droppedBraceSelector`) — the raw match set itself is wrong, so the driver uses CDP
//    for the WHOLE extraction. @scope replication (donut / :scope-root semantics) is
//    ported from the spike but unasserted → flagged here. `sourcelessSheet` = a sheet whose
//    text AND CSSOM are BOTH unreadable (rare) — no authoritative rule source.
//    State deltas need NO risk gate: phase 4 re-reads the RAW `--czp` markers under
//    `CSS.forcePseudoState` (`matchedFromComputed`), so the under-force match set is
//    ENGINE-TRUTH for every state-selector class (`:not(...)` incl. impure args, states in
//    `:is/:where`, `:has(:state)`) — identical to what CDP `getMatchedStylesForNode` returns
//    under the same force. No static synthesis, so nothing to under-/over-match.
//  • `ownerlessSheet` / `sheetTextFailed` = DIAGNOSTIC only (NOT fallback triggers). An
//    ownerless sheet (constructed/@import'd) is ubiquitous; a text-unreadable sheet is
//    HARVESTED from CSSOM by the dual-source inventory. See each ProbeRisk field.

// @ts-ignore — @types/css-tree (v2) lags css-tree (v3); the walk/loc surface is stable.
import { parse as cssParse, walk as cssWalk } from 'css-tree';
// @ts-ignore — no bundled types.
import { selectorSpecificity } from '@csstools/selector-specificity';
// @ts-ignore — no bundled types on the default export we use.
import psParser from 'postcss-selector-parser';
import { specificity as parselSpecificity } from './specificity.ts';
import type {
  MatchedStyles,
  CssRule,
  RuleMatch,
  PseudoElementMatch,
} from './cdp-types.ts';

// ── public interface ────────────────────────────────────────────────────────────

/** One element in the caller's WALK-ORDER list — its CDP nodeId + upper-cased tag.
 *  The order MUST be the caller's own tree walk (skip set applied, recursing THROUGH
 *  skipped tags), because the marker read is zipped to it positionally (see below). */
export interface ProbeElement {
  nodeId: number;
  /** `el.tagName` (upper-case) — checked per-index against the in-page walk to catch
   *  a silent reorder that a length check would miss. */
  tag: string;
}

export interface ProbeMatcherOptions {
  /** Subtree mode: the CSS selector of the subtree root — the marker walk starts
   *  there instead of `document.documentElement`. Must resolve to the SAME node the
   *  caller rooted its element walk on. */
  rootSel?: string;
  /** Tags to skip in the marker walk (recursing THROUGH them), UPPER-CASE. Defaults
   *  to the driver's SKIP_REWORK_TAGS (kept in sync by the lockstep tag assertion).
   *  The caller SHOULD pass its own set so the two walks can never drift. */
  skipTags?: Set<string>;
  /** CDP frameId to inject the probe sheet into (CSS.createStyleSheet). Defaults to
   *  the top frame. Track I passes the target frame's id for frame-scoped extraction
   *  (§4.7); the sheet must live in the document the selectors resolve against. */
  frameId?: string;
  /** The `DOM.getDocument({depth:-1})` root node, if the caller already fetched one
   *  (the driver does). REUSED for author-sheet ordering (ownerNode → document index)
   *  instead of a second full-tree fetch — important because a fresh `DOM.getDocument`
   *  can invalidate the caller's existing nodeIds. Omitted ⇒ the builder fetches its own. */
  domRoot?: any;
}

export interface ProbeMatcher {
  /** The element's AT-REST author match set, cascade-ordered, as `getMatchedStylesForNode`
   *  would return it (origin 'regular' rules only): `matchedCSSRules` ascending +
   *  `pseudoElements` (::before/::after/…). `inlineStyle`/`attributesStyle` UNSET.
   *  Returns an empty match set for an unknown nodeId. */
  matchedFor(nodeId: number): MatchedStyles;
  /** The author match set for a node given the RAW `--czp` markers it currently carries —
   *  the ENGINE-TRUTH match set under whatever `CSS.forcePseudoState` is live when those
   *  markers were read. This is how phase-4 reads state deltas: the probe sheet persists,
   *  so forcing a state and re-reading a subject's `--czp*` computed props yields EXACTLY
   *  the `(rule, selector)` set `getMatchedStylesForNode` would return under that force —
   *  `:has(:state)`, `:not(...)`, states in `:is/:where`, everything — no static synthesis.
   *
   *  `computedPropNames` = the property NAMES from the subject's `CSS.getComputedStyleForNode`
   *  read (which returns the registered `--czp*` markers); the matcher extracts the in-range
   *  markers, groups them by `(rule, pseudo-element)` and cascade-orders them like `matchedFor`.
   *  The caller resolves `computed`-under-force separately (var()-dependent deltas). The result
   *  is the FULL match set (SELF `.el:hover` ∪ RELATIONAL `.foo:hover .el`); splitting self vs
   *  relational and pairing the trigger stays the CALLER's (phase-4) job — exactly as the CDP
   *  path, which the same forces feed identically (parity). */
  matchedFromComputed(computedPropNames: Iterable<string>): MatchedStyles;
  /** Empty the injected probe sheet. Call after the last `matchedFromComputed` read: the
   *  sheet outlives the CDP session, so an undisposed build leaves `--czp*` on the page.
   *  Never throws. A build that throws has already disposed. */
  dispose(): Promise<void>;
  /** The generated probe sheet size, for logging / scale checks. */
  readonly probeCssBytes: number;
  /** Element count the matcher indexed (== the caller's list length). */
  readonly elementCount: number;
  /** Unproven / unrepresentable surfaces detected during the build. Track I MUST consult
   *  this and fall back to the CDP path when any is set — the probe path is NOT trusted
   *  for these (see the ⚑ block up top). `mustFallbackToCdp` is the OR of the concrete
   *  flags for a one-line gate. */
  readonly risk: ProbeRisk;
}

export interface ProbeRisk {
  /** A rule under `@scope` was replicated (donut / :scope-root semantics unproven). */
  scope: boolean;
  /** DIAGNOSTIC ONLY (not in `mustFallbackToCdp`). An ownerless author sheet
   *  (constructed/adopted or `@import`ed — the latter ubiquitous) was present; its cascade
   *  ordering is approximate (appended after DOM-owned sheets), biting only an equal-spec
   *  unlayered cross-@import collision. Correct on real pages (spike: exact on the production site, which
   *  had an @import) — a known limitation, NOT a fallback trigger. */
  ownerlessSheet: boolean;
  /** DIAGNOSTIC ONLY (not in `mustFallbackToCdp`). A `CSS.getStyleSheetText` failed for
   *  some sheet (a CSSOM-mutated / speedy / cross-origin sheet whose text won't serialize).
   *  This is NO LONGER a whole-doc fallback trigger: the dual-source inventory harvests
   *  that sheet's rules from the live CSSOM instead (§2 of buildProbeMatcher). Only a
   *  TRULY sourceless sheet (text failed AND CSSOM unreadable) escalates — see
   *  `sourcelessSheet`. */
  sheetTextFailed: boolean;
  /** A sheet had NO authoritative rule source: its CDP text was unreadable AND its live
   *  CSSOM was unreadable (a cross-origin CORS-blocked sheet whose getStyleSheetText also
   *  threw — rare). Its rules can't be recovered from either source, so the match set is
   *  incomplete → the WHOLE extraction falls back to CDP (in `mustFallbackToCdp`). */
  sourcelessSheet: boolean;
  /** A selector carried a literal brace and its probe was DROPPED (localised
   *  false-negative in the match set). */
  droppedBraceSelector: boolean;
  /** OR of the AT-REST-poisoning flags (scope / sourcelessSheet / droppedBraceSelector) —
   *  the gate for "use CDP for the WHOLE extraction". `sheetTextFailed` is NOT included
   *  (the dual-source inventory harvests such a sheet from CSSOM). There is NO phase-4-only
   *  gate: state deltas are read as ENGINE-TRUTH by re-reading the raw `--czp` markers under
   *  `CSS.forcePseudoState` (see `matchedFromComputed`), so no state-selector class needs a
   *  per-subject CDP fallback. */
  mustFallbackToCdp: boolean;
}

// ── constants ────────────────────────────────────────────────────────────────────

// MUST mirror the driver's SKIP_REWORK_TAGS (extract.ts), UPPER-CASE. The
// caller normally passes its own set via opts.skipTags; this is the standalone default.
const DEFAULT_SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'LINK', 'NOSCRIPT', 'META', 'TITLE', 'HEAD', 'BASE', 'TEMPLATE',
]);

// A trailing pseudo-ELEMENT (single- or double-colon), stripped to find the host.
const PE_RE = /::?(before|after|selection|backdrop|placeholder|marker|first-line|first-letter)$/;

// Marker custom-property prefix. Distinctive (not a plausible author prop like `--m…`)
// so the computed-style enumeration read only picks up OUR probes. The read ALSO
// requires a pure-digit suffix in range, so even a pathological author `--czp<n>`
// collision can't inject a phantom marker.
const MARK = '--czp';

// ── ready-made specificity (order-driving in the probe design) ──────────────────
// parsel THROWS on escaped arbitrary-variant selectors (`.\[\&_svg\]\:x`) → falls
// back to 0, which MIS-ORDERS them (10/441 order deviations in the spike). @csstools
// over postcss-selector-parser handles them; parsel is the fallback. Returns a single
// sortable number a*1e6 + b*1e3 + c (matching src/specificity.ts's base-1000 packing).
function specificity(sel: string): number {
  try {
    const s = selectorSpecificity(psParser().astSync(sel));
    return s.a * 1e6 + s.b * 1e3 + s.c;
  } catch {
    return parselSpecificity(sel);
  }
}

// ── parsed rule model ────────────────────────────────────────────────────────────

interface ParsedSelector { text: string; spec: number }
interface ParsedRule {
  sid: string;                 // CDP styleSheetId (rule identity / debug)
  line: number; col: number;   // 0-based prelude start (debug / stable key)
  seq: number;                 // global source order across sheets (document order)
  selectors: ParsedSelector[];
  decls: { prop: string; value: string; important: boolean }[];
  conds: string[];             // wrapper at-rule texts, innermost LAST (@media/@supports/@container/@scope)
  layerKey: number[] | null;   // first-mention index chain; null = unlayered
  scoped: boolean;             // under @scope (⚑ unproven; probe replicates the block)
}

// A single generated probe: which (rule, selector) it stands for and the pseudo-element
// it targets (null = the host element itself). The probe carries the author selector
// VERBATIM (pe stripped) — the real engine evaluates it, at rest AND under
// `CSS.forcePseudoState` (state deltas are read by re-reading these same markers under
// force; no state-stripped variant is generated — see `matchedFromComputed`).
interface ProbeItem {
  rule: number;                // index into `rules`
  sel: number;                 // index into rule.selectors
  pe: string | null;           // pseudo-element type, or null
}

// Layer order registry: assigns a first-mention index per level so a nested layer
// path (`a.b.c`) becomes a comparable numeric key. DFS-stable across sheets.
class LayerOrder {
  private children = new Map<string, Map<string, number>>(); // parentPath -> name -> idx
  private anon = 0;
  key(path: string[]): number[] {
    const out: number[] = [];
    let parent = '';
    for (const name of path) {
      let m = this.children.get(parent);
      if (!m) { m = new Map(); this.children.set(parent, m); }
      if (!m.has(name)) m.set(name, m.size);
      out.push(m.get(name)!);
      parent = parent ? parent + '.' + name : name;
    }
    return out;
  }
  declare_(path: string[]) { this.key(path); }
  anonName() { return `__anon${this.anon++}`; }
}

// ── sheet parsing (css-tree, loc-preserving) ────────────────────────────────────

// Desugar a nested selector list against the joined parent selector (CSS Nesting
// spec): `&` → `:is(parentList)`; a `&`-less part → `:is(parentList) part` (descendant
// combinator implied). The `(?<!\\)` guards an ESCAPED `&` inside a Tailwind arbitrary
// variant (`.\[\&_svg\]\:x`). Mirrors the in-page HARVEST_FN desugar so a nested rule's
// text-parsed and CSSOM-harvested representations are identical.
function desugarList(parts: string[], parentJoined: string | null): string[] {
  if (!parentJoined) return parts;
  return parts.map((t) =>
    /(?<!\\)&/.test(t)
      ? t.replace(/(?<!\\)&/g, `:is(${parentJoined})`)
      : `:is(${parentJoined}) ${t}`.trim());
}

// Parse a declaration-list STRING (a harvested `rule.style.cssText`) into decls — the
// CSSOM-harvest counterpart of the block-child Declaration collection in parseSheet.
function parseDeclList(declCss: string): ParsedRule['decls'] {
  const out: ParsedRule['decls'] = [];
  if (!declCss) return out;
  try {
    const ast = cssParse(declCss, { context: 'declarationList', positions: true, parseValue: false });
    cssWalk(ast, (node: any) => {
      if (node.type !== 'Declaration') return;
      out.push({
        prop: node.property,
        value: node.value?.loc ? declCss.slice(node.value.loc.start.offset, node.value.loc.end.offset).trim() : '',
        important: node.important === true || node.important === 'important',
      });
    });
  } catch { /* tolerate a malformed harvested decl string */ }
  return out;
}

// Parse one sheet's SOURCE TEXT → ParsedRule[] in document order (seq is left 0 here and
// renumbered GLOBALLY after assembly, since text-parsed and CSSOM-harvested sheets
// interleave). A recursive descent (not a flat walk) so native CSS NESTING is modelled and
// stays EXACTLY count-aligned with the in-page CSSOM census (Chrome 130+ materialises every
// non-leading bare-declaration run as a separate `CSSNestedDeclarations` rule): a nested
// style rule is desugared against its parent (`desugarList`); a style rule's LEADING decl run
// is its own rule, and EACH subsequent run (a trailing run after a nested rule, or any run
// inside a nested `@media`/`@supports`/… — the `.card{ color:red; &:hover{} padding:1px }`
// pattern) becomes a separate synthesized `:is(parent)` rule. This 1:1 rule-count match is
// what keeps a pristine authored-nesting sheet OFF the harvest path (see the detector).
//
// LIMITATION — bare-class nesting: css-tree parses `&`-led nesting (`&:hover`, `& .kid`) as
// a Rule, but a nested rule that starts with a BARE selector (`.a{ .b{…} }`, no `&`) is
// emitted as a `Raw` node it can't disambiguate from a declaration — so parseSheet under-
// counts it, the census reports MORE rules, and the sheet falls to the CSSOM harvest. That is
// RENDER-CORRECT (the harvest reads the browser's own parse; probe==CDP verified) — only its
// values are CSSOM-reserialized rather than authored. Re-parsing the Raw is deliberately NOT
// attempted: css-tree's Raw boundaries for interleaved bare-rule/decl runs are unreliable and
// a wrong text-parse is worse than a render-correct harvest. Net: bare-class-nested sheets are
// harvested, `&`-nested sheets are text-parsed.
// The parse context threaded through the recursive walk: the accumulated at-rule
// condition stack (innermost last), the layer first-mention path, `@scope` flag, whether
// we're inside `@keyframes` (skip), and `parentSel` — the enclosing style rule's DESUGARED
// selector list (null at stylesheet top), which nested selectors desugar against AND which
// a `CSSNestedDeclarations` run is synthesized onto.
interface ParseCtx {
  conds: string[];
  layerPath: string[];
  scoped: boolean;
  inKeyframes: boolean;
  parentSel: string[] | null;
}

function parseSheet(sid: string, text: string, layers: LayerOrder): ParsedRule[] {
  const ast = cssParse(text, {
    positions: true, parseValue: false, parseAtrulePrelude: false, parseRulePrelude: true,
  });
  const rules: ParsedRule[] = [];
  const raw = (node: any) => (node && node.loc ? text.slice(node.loc.start.offset, node.loc.end.offset) : '');

  const collectDecls = (nodes: any[]): ParsedRule['decls'] =>
    nodes.map((ch) => ({
      prop: ch.property,
      value: ch.value ? raw(ch.value).trim() : '',
      important: ch.important === true || ch.important === 'important',
    }));

  const emitRule = (selTexts: string[], decls: ParsedRule['decls'], ctx: ParseCtx, loc: { line: number; col: number } | null) => {
    rules.push({
      sid,
      line: loc ? loc.line - 1 : -1,
      col: loc ? loc.col - 1 : -1,
      seq: 0,
      selectors: selTexts.map((t) => ({ text: t, spec: specificity(t) })),
      decls,
      conds: ctx.conds.slice(),
      layerKey: ctx.layerPath.length ? layers.key(ctx.layerPath) : null,
      scoped: ctx.scoped,
    });
  };

  // Process a block's children in DOCUMENT ORDER. `owner` (a style rule's own selectors +
  // loc) means "this is a style rule's DIRECT block": the FIRST bare-declaration run is that
  // rule's own decls (the owner rule, emitted once even if empty — the CSSOM always has a
  // CSSStyleRule). Every SUBSEQUENT run — a run after a nested rule, or any run inside a
  // nested at-rule (`owner` null) — is a `CSSNestedDeclarations` (Chrome 130+): a SEPARATE
  // synthesized rule on `ctx.parentSel`. Emitting them in order (not folding trailing decls
  // into the owner) keeps the rule count EXACTLY census-aligned so a pristine authored-nesting
  // sheet — incl. the common `.card{ color:red; &:hover{} padding:1px }` trailing-decl pattern
  // — is NOT false-flagged as mutated, and preserves source order so a later run overriding an
  // earlier prop still wins.
  const processBlock = (children: any[], ctx: ParseCtx, owner: { sel: string[]; loc: { line: number; col: number } } | null) => {
    let pending: any[] = [];
    let ownerEmitted = false;
    const flush = () => {
      const decls = collectDecls(pending);
      pending = [];
      if (owner && !ownerEmitted) {
        emitRule(owner.sel, decls, ctx, owner.loc);   // the style rule's OWN rule (leading run)
        ownerEmitted = true;
      } else if (decls.length && ctx.parentSel) {
        emitRule([`:is(${ctx.parentSel.join(', ')})`], decls, ctx, null); // CSSNestedDeclarations
      }
    };
    for (const ch of children) {
      if (ch.type === 'Declaration') { pending.push(ch); continue; }
      flush(); // close the current decl run (owner-first-time or synth) BEFORE the nested child
      if (ch.type === 'Rule') processStyleRule(ch, ctx);
      else if (ch.type === 'Atrule') processAtrule(ch, ctx);
    }
    flush(); // trailing run, and (owner && !ownerEmitted) emits the empty owner rule
  };

  function processStyleRule(node: any, ctx: ParseCtx) {
    if (ctx.inKeyframes) return; // keyframe % selectors are not real matches
    const prelude = node.prelude;
    const parts: string[] = [];
    if (prelude && prelude.type === 'SelectorList') {
      for (const sel of prelude.children.toArray()) { const t = raw(sel).trim(); if (t) parts.push(t); }
    } else {
      const t = raw(prelude).trim();
      if (t) for (const part of t.split(',')) parts.push(part.trim());
    }
    const parentJoined = ctx.parentSel ? ctx.parentSel.join(', ') : null;
    const effParts = desugarList(parts, parentJoined);
    if (!effParts.length) return;
    const inner: ParseCtx = { ...ctx, parentSel: effParts };
    const loc = {
      line: prelude?.loc?.start.line ?? node.loc.start.line,
      col: prelude?.loc?.start.column ?? node.loc.start.column,
    };
    processBlock(node.block ? node.block.children.toArray() : [], inner, { sel: effParts, loc });
  }

  function processAtrule(node: any, ctx: ParseCtx) {
    const name = (node.name || '').toLowerCase();
    const prelude = node.prelude ? raw(node.prelude).trim() : '';
    // A statement `@layer a, b;` (no block) DECLARES layer order without holding rules.
    if (name === 'layer' && !node.block) {
      for (const part of prelude.split(',')) { const p = part.trim(); if (p) layers.declare_(p.split('.')); }
      return;
    }
    let inner: ParseCtx = ctx;
    if (name === 'media') inner = { ...ctx, conds: [...ctx.conds, `@media ${prelude}`] };
    else if (name === 'supports') inner = { ...ctx, conds: [...ctx.conds, `@supports ${prelude}`] };
    else if (name === 'container') inner = { ...ctx, conds: [...ctx.conds, `@container ${prelude}`] };
    else if (name === 'scope') inner = { ...ctx, conds: [...ctx.conds, `@scope ${prelude}`.trim()], scoped: true };
    else if (name === 'layer') {
      // An anonymous layer block (`@layer { … }`, empty prelude) gets ONE name shared by all
      // its rules (minting per-rule would split same-block rules into fake sibling layers).
      const seg = prelude ? prelude.split('.') : [layers.anonName()];
      inner = { ...ctx, layerPath: [...ctx.layerPath, ...seg] };
    } else if (name === 'keyframes' || name.endsWith('keyframes')) {
      return; // @keyframes contents are not element matches (census skips the whole block too)
    } else {
      return; // @font-face / @property / @page / … — their decls are not element declarations
    }
    // An at-rule block is never a style rule's OWN decls (owner null): a bare-decl run in it
    // is a CSSNestedDeclarations on ctx.parentSel (when inside a style rule), and nested style
    // rules recurse normally (at stylesheet top, parentSel is null so bare decls are ignored).
    if (node.block) processBlock(node.block.children.toArray(), inner, null);
  }

  const rootCtx: ParseCtx = { conds: [], layerPath: [], scoped: false, inKeyframes: false, parentSel: null };
  processBlock((ast as any).children.toArray(), rootCtx, null);
  return rules;
}

// ── selector stripping / validity (probe-gen helpers) ────────────────────────────

function stripPe(sel: string): { sel: string; pe: string | null } {
  const m = sel.match(PE_RE);
  if (!m) return { sel, pe: null };
  let rest = sel.slice(0, sel.length - m[0].length).trim();
  // A bare `::before` (Tailwind preflight `*,::before,::after{}`) or a trailing
  // combinator leaves an empty compound — that means "any element's ::before", so
  // the host probe is the universal selector.
  if (!rest || /[>+~]$/.test(rest)) rest = (rest + ' *').trim();
  return { sel: rest, pe: m[1] };
}
function validProbeSel(s: string): boolean {
  const t = s.trim();
  // Reject a literal brace: `[title="a{b}"]` concatenated into `SEL{--czpN:1}` would
  // break rule-boundary parsing in the injected sheet and silently kill FOLLOWING
  // probes (an *invalid* selector only drops its own rule; an unbalanced brace poisons
  // siblings). Dropping such a probe is a localised false-negative, not corruption.
  return !!t && !/[>+~,]$/.test(t) && !/\(\s*\)/.test(t) && !/[{}]/.test(t);
}

// ── cascade-order glue (ascending: WEAKEST first) ───────────────────────────────

// Compare two layer keys for NORMAL declarations. Ascending = weaker first.
function cmpLayerKey(ak: number[], bk: number[]): number {
  const n = Math.min(ak.length, bk.length);
  for (let i = 0; i < n; i++) {
    if (ak[i] !== bk[i]) return ak[i] - bk[i]; // sibling layers: earlier declaration = weaker
  }
  if (ak.length === bk.length) return 0;
  // Pure-prefix case: a parent layer's OWN (un-nested) rules vs a rule in one of its
  // nested sub-layers. Per CSS Cascade 5, a layer's un-nested rules act as a FINAL
  // implicit sub-layer → they come AFTER (win over) explicitly-nested sub-layers. So
  // the SHORTER key (parent-direct) is STRONGER (sorts later, ascending). This is the
  // ONE ordering the spike never exercised (its site had no nested sub-layers); pinned
  // against CDP by the nested-@layer fixture in probe-matcher.browser.test.ts.
  return ak.length < bk.length ? 1 : -1;
}

// Full ascending cascade comparator for two matched rules (NORMAL-decl order — the
// !important×@layer reversal is a known parity limit, see §9). `aSpec`/`bSpec` are the
// best specificity among each rule's MATCHED selectors.
function cmpRules(a: ParsedRule, aSpec: number, b: ParsedRule, bSpec: number): number {
  const ak = a.layerKey, bk = b.layerKey;
  if (!!ak !== !!bk) return ak ? -1 : 1;          // layered loses to unlayered (normal decls)
  if (ak && bk) { const c = cmpLayerKey(ak, bk); if (c) return c; }
  if (aSpec !== bSpec) return aSpec - bSpec;      // higher specificity wins (sorts later)
  return a.seq - b.seq;                            // source order (stable, total: seq is unique)
}

// ── synthesize a cdp-types MatchedStyles from a set of matched (rule, sel) hits ───

// Build one RuleMatch. `litSel` = the indices (into rule.selectors) that matched.
// media/supports are OMITTED (probe-matched ⇒ the real engine already evaluated every
// condition ⇒ active by construction; leaving arrays would let cascadeResolve's
// conditionsActive filter our rules back out — cascade.ts:132).
function toRuleMatch(rule: ParsedRule, litSel: number[]): RuleMatch {
  return {
    rule: {
      origin: 'regular',
      selectorList: { selectors: rule.selectors.map((s) => ({ text: s.text })) },
      style: {
        cssProperties: rule.decls.map((d) => ({
          name: d.prop,
          value: d.value,       // bare (css-tree parses !important out); `important` carries it
          important: d.important,
        })),
      },
    } as CssRule,
    matchingSelectors: litSel.slice().sort((x, y) => x - y),
  };
}

// Best specificity among a rule's MATCHED selectors (only matched ones can win).
function bestSpec(rule: ParsedRule, litSel: number[]): number {
  let best = 0;
  for (const si of litSel) { const s = rule.selectors[si]; if (s && s.spec > best) best = s.spec; }
  return best;
}

// Sort a set of (ruleIndex → lit selector indices) into ascending cascade order and
// emit RuleMatch[]. `rules` is the shared parsed-rule array.
function orderAndEmit(rules: ParsedRule[], hits: Map<number, Set<number>>): RuleMatch[] {
  const entries = [...hits.entries()].map(([ri, sels]) => {
    const litSel = [...sels];
    return { ri, litSel, spec: bestSpec(rules[ri], litSel) };
  });
  entries.sort((a, b) => cmpRules(rules[a.ri], a.spec, rules[b.ri], b.spec));
  return entries.map((e) => toRuleMatch(rules[e.ri], e.litSel));
}

// ── the builder ─────────────────────────────────────────────────────────────────

interface CDPLike { send(method: string, params?: any): Promise<any>; on(event: string, cb: (e: any) => void): void }
interface EvalLike { evaluate<A, R>(fn: (arg: A) => R, arg: A): Promise<R> }


/**
 * Build the matcher: ONE expensive setup (harvest author sheet texts → css-tree parse
 * → generate probe sheet → inject via an inspector stylesheet → ONE marker-read
 * evaluate), then cheap per-node lookups.
 *
 * SESSION PRECONDITION: this enables `CSS` on `client` to replay `CSS.styleSheetAdded`
 * for every existing sheet. Pass a client on which `CSS` is NOT already enabled (e.g. a
 * fresh `newCDPSession`) — if CSS was enabled earlier the replay was already consumed and
 * the existing sheets are missed. (The caller's nodeIds are NOT read via `client`; they
 * flow in through `elements`, so a dedicated harvest session is safe.)
 *
 * LOCKSTEP CONTRACT: `elements` is the caller's WALK-ORDER list. The marker read walks
 * the same start node (`opts.rootSel` or `<html>`) with the same skip set, recursing
 * THROUGH skipped tags, and is zipped to `elements` POSITIONALLY. We assert both the
 * length AND per-index tag — a same-length reorder would silently mis-map markers to
 * nodes, which is fatal for a cascade oracle. Pass the SAME skipTags + rootSel the
 * caller used to build `elements`. A drift THROWS (not a silent mis-map) — the caller must
 * treat that throw as a hard build failure (fall back to the CDP path or abort extraction),
 * like a set `risk.mustFallbackToCdp`.
 */
export async function buildProbeMatcher(
  client: CDPLike,
  evalCtx: EvalLike,
  elements: ProbeElement[],
  opts: ProbeMatcherOptions = {},
): Promise<ProbeMatcher> {
  const skipTags = opts.skipTags ?? DEFAULT_SKIP_TAGS;

  // 1. Harvest author sheet texts. styleSheetAdded fires as sheets register; CSS.enable
  //    replays existing sheets. Filter to origin 'regular' (author) and order by
  //    ownerNode document position (ownerless — constructed/@import — after, in added order).
  const sheetHeaders: any[] = [];
  client.on('CSS.styleSheetAdded', (e: any) => sheetHeaders.push(e.header));
  await client.send('DOM.enable');
  await client.send('CSS.enable');
  // Let styleSheetAdded events settle (they arrive asynchronously after enable).
  await evalCtx.evaluate(() => new Promise<void>((r) => setTimeout(r, 300)), null as any);

  const authorSheets = sheetHeaders.filter((h) => h.origin === 'regular');

  // Document order of ownerNodes: index every element by backendNodeId. Reuse the
  // caller's DOM.getDocument root if supplied (a fresh fetch would invalidate the
  // caller's nodeIds); else fetch our own.
  const root = opts.domRoot ?? (await client.send('DOM.getDocument', { depth: -1 })).root;
  const backendDocIndex = new Map<number, number>();
  let docIdx = 0;
  const indexDom = (n: any) => {
    if (n.nodeType === 1) backendDocIndex.set(n.backendNodeId, docIdx++);
    for (const c of n.children || []) indexDom(c);
    // pierce shadow / content docs if present (constructed sheets may own nodes there)
    for (const c of n.contentDocument ? [n.contentDocument] : []) indexDom(c);
  };
  indexDom(root);

  const ordered = [...authorSheets].sort((a, b) => {
    const ai = a.ownerNode != null ? backendDocIndex.get(a.ownerNode) ?? 1e9 : 1e9;
    const bi = b.ownerNode != null ? backendDocIndex.get(b.ownerNode) ?? 1e9 : 1e9;
    return ai - bi || sheetHeaders.indexOf(a) - sheetHeaders.indexOf(b);
  });

  // Risk accumulator (surfaced so the driver can fall back to CDP — see ProbeRisk).
  const risk = {
    scope: false, ownerlessSheet: false, sheetTextFailed: false,
    droppedBraceSelector: false, sourcelessSheet: false,
  };
  // An ownerless author sheet (constructed/adopted or @import) has approximate ordering.
  if (authorSheets.some((h) => h.ownerNode == null)) risk.ownerlessSheet = true;

  // Per-sheet source text (CDP getStyleSheetText). A throw ⇒ the text is unreadable for
  // that sheet (CSSOM-mutated / speedy / cross-origin CORS). We DON'T fall back to CDP
  // on a throw — the dual-source detector below decides per sheet whether to harvest from
  // the live CSSOM (the render-authoritative source) instead. `textFailed[i]` feeds that.
  const textFailed: boolean[] = new Array(ordered.length).fill(false);
  const texts = await Promise.all(ordered.map(async (h, i) => {
    try {
      const { text } = (await client.send('CSS.getStyleSheetText', { styleSheetId: h.styleSheetId })) as any;
      return text as string;
    } catch {
      textFailed[i] = true;
      risk.sheetTextFailed = true; // DIAGNOSTIC now (per-sheet harvest, not whole-doc CDP)
      return '';
    }
  }));

  // 2. DUAL-SOURCE RULE INVENTORY. `CSS.getStyleSheetText` returns a sheet's SOURCE text,
  //    which MISSES rules a page added at runtime via `insertRule` — a URL-backed Vite /
  //    Tailwind dev sheet, CSS-in-JS "speedy" mode — because the source text never
  //    contained them, yet the call SUCCEEDS, so the miss is SILENT. For each sheet we
  //    compare the text-parse rule count against a LIVE CSSOM census; when the CSSOM has
  //    STRICTLY MORE rules (`census > text`, the insertRule signature) the sheet is
  //    CSSOM-authoritative and is HARVESTED from the live CSSOM in-page instead of parsed
  //    from text. Pristine sheets keep the raw-text parse (authored values verbatim) — a
  //    NO-OP on a static page. The detector is DIRECTIONAL (see 2c): the reverse
  //    (`text > census`, css-tree keeping a browser-dropped rule) is a pristine quirk, not a
  //    mutation. In the harvest direction it is fail-open (a CSSOM inventory is render-correct;
  //    only the value representation differs — the same class as CDP's own reserialization).

  //    2a. Census: one in-page walk — per sheet (document.styleSheets order, @import
  //        children DFS, adopted after), recursive style-rule count counting nested
  //        CSSStyleRule AND CSSNestedDeclarations (Chrome 130+), keyframes skipped.
  //        count = -1 when `cssRules` throws (cross-origin: CSSOM-unreadable, but ALSO
  //        immutable to page JS → its CDP text is authoritative, so it stays on text).
  const census: { href: string | null; kind: string; count: number }[] = await evalCtx.evaluate(() => {
    const out: { href: string | null; kind: string; count: number }[] = [];
    const countStyleRules = (list: any): number => {
      let n = 0;
      for (const r of list) {
        if (r instanceof CSSKeyframesRule) continue;
        if (r.constructor && r.constructor.name === 'CSSNestedDeclarations') { n++; continue; }
        if (r instanceof CSSStyleRule) { n++; if (r.cssRules && r.cssRules.length) n += countStyleRules(r.cssRules); }
        else if (r.cssRules) n += countStyleRules(r.cssRules);
      }
      return n;
    };
    // ⚠ TRAVERSAL-LOCKSTEP with the harvest `visit` (2d): the harvest re-derives each sheet's
    // census index by an INDEPENDENT counter over this SAME order. Any reorder/skip here MUST
    // be mirrored there or the harvest reads the wrong sheet. Order: styleSheets → @import
    // children (DFS, parent before children) → adoptedStyleSheets.
    const visit = (sheet: any, kind: string) => {
      let rules: any = null, count = -1;
      try { rules = sheet.cssRules; count = countStyleRules(rules); } catch { /* cross-origin */ }
      out.push({ href: sheet.href || null, kind, count });
      if (rules) for (const r of rules) if (r instanceof CSSImportRule && r.styleSheet) visit(r.styleSheet, 'href');
    };
    for (const s of document.styleSheets) visit(s, (s as any).href ? 'href' : 'inline');
    for (const s of ((document as any).adoptedStyleSheets || [])) visit(s, 'constructed');
    return out;
  }, null as any);

  //    2b. Match each CDP author sheet to a census entry: a URL sheet by href, an inline /
  //        constructed sheet by same-kind visit order (the census walks the same DOM order
  //        the CDP sheets are ordered in).
  const usedCensus = new Array(census.length).fill(false);
  const queueOf = (kind: string) => census.map((c, i) => ({ c, i })).filter((x) => x.c.kind === kind);
  const inlineQ = queueOf('inline'); let inlinePtr = 0;
  const consQ = queueOf('constructed'); let consPtr = 0;
  // DRIFT GUARD (position-matching is the one cross-boundary contract this matcher can't
  // key exactly): the inline / constructed queues pair by VISIT ORDER, so they're only
  // trustworthy when CDP and the in-page census agree on how many sheets of that kind exist.
  // If they disagree (the two enumerations drifted), a position pair could mis-slot a census
  // count onto the wrong sheet → a wrong harvest decision. Rather than assert-and-throw (the
  // marker-walk's discipline — but here the safe default exists), we DISABLE position-matching
  // for the drifted kind, so those sheets fall to the text parse (authoritative for a static
  // sheet; only a same-process speedy-inline mutation is missed, re-opening the silent bug for
  // that rare case — acceptable vs a false-harvest). URL sheets key by href, unaffected.
  const cdpInlineCount = ordered.filter((h) => !h.isConstructed && !(h.sourceURL && !h.isInline)).length;
  const cdpConsCount = ordered.filter((h) => h.isConstructed).length;
  const inlineReliable = cdpInlineCount === inlineQ.length;
  const consReliable = cdpConsCount === consQ.length;
  const censusForSheet = (h: any): { idx: number; count: number } | null => {
    let m: { c: { count: number }; i: number } | null = null;
    if (h.isConstructed) m = consReliable ? (consQ[consPtr++] ?? null) : null;
    else if (h.sourceURL && !h.isInline) {
      const j = census.findIndex((c, i) => !usedCensus[i] && c.href === h.sourceURL);
      if (j >= 0) m = { c: census[j], i: j };
    } else m = inlineReliable ? (inlineQ[inlinePtr++] ?? null) : null;
    if (!m) return null;
    usedCensus[m.i] = true;
    return { idx: m.i, count: m.c.count };
  };

  //    2c. Parse each sheet's text (nesting-aware) + detect mutation vs the census.
  const layers = new LayerOrder();
  const perSheet = ordered.map((h, i) => {
    const textRules = texts[i] ? parseSheet(h.styleSheetId, texts[i], layers) : [];
    const cen = censusForSheet(h);
    // Mutated ⇒ CSSOM-authoritative. The detector is DIRECTIONAL: harvest only when the
    // live CSSOM has STRICTLY MORE style rules than the source text (`census > text`) — the
    // `insertRule` signature (a URL-backed Vite/Tailwind dev sheet adds utilities the fetched
    // source never had). The REVERSE (`text > census`) is a PRISTINE representation quirk,
    // NOT a mutation: css-tree keeps rules the browser DROPS (a cross-browser-only pseudo
    // like `:-moz-ui-invalid` in Tailwind's preflight), so the SOURCE text stays authoritative
    // — harvesting there would needlessly swap authored values for CSSOM-reserialized ones and
    // break the byte-level baseline on a static page. `textFailed` (text unreadable, CSSOM
    // readable) is subsumed: an empty text-parse is 0 < census. (A runtime `deleteRule` —
    // census < text — is the one residual the count detector can't tell from the pristine
    // quirk; rare, deferred with the mid-extraction drift guard, t-65ge0w.)
    const mutated = cen != null && cen.count >= 0 && cen.count > textRules.length;
    // Truly sourceless: text unreadable AND CSSOM unreadable (cross-origin CORS + a
    // getStyleSheetText failure) — no authoritative rule source at all → CDP fallback.
    if (textFailed[i] && (cen == null || cen.count < 0)) risk.sourcelessSheet = true;
    return { sid: h.styleSheetId, textRules, mutated, censusIdx: cen ? cen.idx : null };
  });

  //    2d. Harvest the mutated sheets from the live CSSOM (one in-page walk over the
  //        flagged census indices): nested rules desugared per spec, CSSNestedDeclarations
  //        → an implicit rule on the parent, @layer statements feed the layer order,
  //        condition stacks accumulated, declarations via `rule.style.cssText`.
  const flaggedIdx = perSheet.filter((p) => p.mutated && p.censusIdx != null).map((p) => p.censusIdx as number);
  const harvested: Record<number, any[]> = flaggedIdx.length
    ? await evalCtx.evaluate((flagged: number[]) => {
        const G = globalThis as any;
        const flaggedSet = new Set(flagged);
        const out: Record<number, any[]> = {};
        let idx = -1;
        // Top-level comma split, honouring nesting parens/brackets and escapes.
        const splitList = (s: string): string[] => {
          const parts: string[] = []; let d = 0, cur = '';
          for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (ch === '\\') { cur += ch + (s[i + 1] || ''); i++; continue; }
            if (ch === '(' || ch === '[') d++;
            else if (ch === ')' || ch === ']') d--;
            if (ch === ',' && d === 0) { parts.push(cur.trim()); cur = ''; }
            else cur += ch;
          }
          if (cur.trim()) parts.push(cur.trim());
          return parts;
        };
        // ⚠ MUST stay byte-identical to the Node-side `desugarList` (parseSheet) — a nested
        // rule's text-parsed and harvested selector text have to match or its two
        // representations diverge. Duplicated because a serialized in-page closure can't call
        // a module function.
        const desugar = (rawSel: string, parentJoined: string): string[] => splitList(rawSel).map((t) =>
          /(?<!\\)&/.test(t) ? t.replace(/(?<!\\)&/g, ':is(' + parentJoined + ')') : (':is(' + parentJoined + ') ' + t).trim());
        const harvestSheet = (sheet: any): any[] => {
          const items: any[] = [];
          const walk = (list: any, conds: string[], layerPath: string[], parentJoined: string | null) => {
            for (const r of list) {
              if (r instanceof CSSKeyframesRule) continue;
              if (G.CSSLayerStatementRule && r instanceof G.CSSLayerStatementRule) {
                items.push({ t: 'stmt', names: [...r.nameList] });
              } else if (r.constructor && r.constructor.name === 'CSSNestedDeclarations') {
                // bare decls in a nested context → apply to the parent's elements
                if (parentJoined) items.push({
                  t: 'rule', selsEff: [':is(' + parentJoined + ')'],
                  conds: conds.slice(), layer: layerPath.slice(), decl: r.style ? r.style.cssText : '',
                });
              } else if (r instanceof CSSStyleRule) {
                const rawSel = r.selectorText || '&';
                const selsEff = parentJoined ? desugar(rawSel, parentJoined) : splitList(rawSel);
                items.push({ t: 'rule', selsEff, conds: conds.slice(), layer: layerPath.slice(), decl: r.style.cssText });
                if (r.cssRules && r.cssRules.length) walk(r.cssRules, conds, layerPath, selsEff.join(', '));
              } else if (r instanceof CSSMediaRule) walk(r.cssRules, conds.concat('@media ' + r.conditionText), layerPath, parentJoined);
              else if (r instanceof CSSSupportsRule) walk(r.cssRules, conds.concat('@supports ' + r.conditionText), layerPath, parentJoined);
              else if (G.CSSContainerRule && r instanceof G.CSSContainerRule) walk(r.cssRules, conds.concat('@container ' + r.conditionText), layerPath, parentJoined);
              else if (G.CSSLayerBlockRule && r instanceof G.CSSLayerBlockRule) walk(r.cssRules, conds, layerPath.concat(r.name ? r.name.split('.') : ['__anon_cssom']), parentJoined);
              else if (G.CSSScopeRule && r instanceof G.CSSScopeRule) walk(r.cssRules, conds.concat('@scope' + (r.start ? ' (' + r.start + ')' : '') + (r.end ? ' to (' + r.end + ')' : '')), layerPath, parentJoined);
              else if (r.cssRules && r.cssRules.length) walk(r.cssRules, conds, layerPath, parentJoined);
            }
          };
          try { walk(sheet.cssRules, [], [], null); } catch { /* unreadable */ }
          return items;
        };
        // ⚠ TRAVERSAL-LOCKSTEP with the census `visit` (2a): `idx` is that census array index.
        // This walk MUST match the census order (styleSheets → @import DFS → adopted) exactly,
        // or a flagged index harvests the wrong sheet.
        const visit = (sheet: any) => {
          idx++;
          if (flaggedSet.has(idx)) out[idx] = harvestSheet(sheet);
          let rules: any = null; try { rules = sheet.cssRules; } catch { /* cross-origin */ }
          if (rules) for (const r of rules) if (r instanceof CSSImportRule && r.styleSheet) visit(r.styleSheet);
        };
        for (const s of document.styleSheets) visit(s);
        for (const s of ((document as any).adoptedStyleSheets || [])) visit(s);
        return out;
      }, flaggedIdx)
    : {};

  //    2e. Assemble the final rule list (document order; per-sheet source), then renumber
  //        `seq` GLOBALLY (text-parsed & harvested sheets interleave, so seq is the final
  //        document-order index, not a per-sheet running count).
  const rules: ParsedRule[] = [];
  for (const p of perSheet) {
    const items = p.mutated && p.censusIdx != null ? harvested[p.censusIdx] : undefined;
    if (!items) { rules.push(...p.textRules); continue; }
    for (const item of items) {
      if (item.t === 'stmt') { for (const n of item.names || []) layers.declare_(String(n).split('.')); continue; }
      const selTexts: string[] = item.selsEff || [];
      if (!selTexts.length) continue;
      const conds: string[] = item.conds || [];
      rules.push({
        sid: p.sid, line: -1, col: -1, seq: 0,
        selectors: selTexts.map((t) => ({ text: t, spec: specificity(t) })),
        decls: parseDeclList(item.decl || ''),
        conds,
        layerKey: (item.layer && item.layer.length) ? layers.key(item.layer) : null,
        scoped: conds.some((c) => c.startsWith('@scope')),
      });
    }
  }
  rules.forEach((r, i) => { r.seq = i; });
  if (rules.some((r) => r.scoped)) risk.scope = true;

  // 3. Generate the probe sheet. For each (rule, selector) ONE `raw` probe (pe stripped,
  //    author selector VERBATIM — states KEPT). At rest a state-bearing selector self-
  //    excludes (dark); under `CSS.forcePseudoState` the SAME markers light exactly as the
  //    engine matches, so no state-stripped variant is needed (see `matchedFromComputed`).
  //    Each probe is wrapped in the rule's condition stack (never @layer).
  const items: ProbeItem[] = [];
  for (let r = 0; r < rules.length; r++) {
    const rule = rules[r];
    for (let s = 0; s < rule.selectors.length; s++) {
      const { sel: noPe, pe } = stripPe(rule.selectors[s].text);
      if (validProbeSel(noPe)) items.push({ rule: r, sel: s, pe });
      else if (/[{}]/.test(noPe)) risk.droppedBraceSelector = true;
    }
  }

  // Per-build marker prefix: a probe sheet an aborted extraction could not empty stays on
  // the page and keeps lighting ITS markers; a fixed `--czp<i>` would read them as this
  // build's rule i — silent phantom matches on every later extraction of that tab.
  const mark = `${MARK}${Math.random().toString(36).slice(2, 8)}_`;
  let css = '';
  // @property with syntax '*' and NO initial-value ⇒ the custom prop is invalid-at-
  // computed-value-time unless SET, so computed-style enumeration lists ONLY lit
  // markers (read is O(matched), not O(registered)).
  for (let i = 0; i < items.length; i++) css += `@property ${mark}${i}{syntax:'*';inherits:false;}`;
  const parts: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const rule = rules[it.rule];
    const selText = stripPe(rule.selectors[it.sel].text).sel;
    let probe = `${selText}{${mark}${i}:1;}`;
    for (let c = rule.conds.length - 1; c >= 0; c--) probe = `${rule.conds[c]}{${probe}}`;
    parts.push(probe);
  }
  css += parts.join('\n');

  // 4. Inject via an inspector stylesheet (CSP-immune; invisible to page observers).
  //    The sheet outlives the CDP session that made it, so `dispose` must empty it or every
  //    later reader of that page (DevTools, a chrome-devtools MCP `get_css_styles`) sees the
  //    `--czp*` markers.
  const frameId = opts.frameId ?? (await client.send('Page.getFrameTree')).frameTree.frame.id;
  const { styleSheetId: probeSid } = await client.send('CSS.createStyleSheet', { frameId });
  const dispose = async (): Promise<void> => {
    await client.send('CSS.setStyleSheetText', { styleSheetId: probeSid, text: '' }).catch(() => {});
  };
  let walkResult: Array<[string, number[]]>;
  try {
    await client.send('CSS.setStyleSheetText', { styleSheetId: probeSid, text: css });
    // Force a style/layout flush so @container/@scope resolve against real layout.
    await evalCtx.evaluate(() => void document.body.offsetHeight, null as any);

    // 5. ONE marker read — the SAME walk (start node + skip set, recurse THROUGH skipped
    //    tags) the caller used to build `elements`. Returns [tag, markerIds[]] per element.
    walkResult = await evalCtx.evaluate(
      (arg: { skip: string[]; rootSel: string | null; mark: string; count: number }) => {
        const SKIP = new Set(arg.skip);
        const PFX = arg.mark;
        const out: Array<[string, number[]]> = [];
        const start = arg.rootSel ? document.querySelector(arg.rootSel) : document.documentElement;
        const walk = (el: Element) => {
          const tag = el.tagName.toUpperCase();
          if (!SKIP.has(tag)) {
            const cs = getComputedStyle(el);
            const mine: number[] = [];
            for (let i = 0; i < cs.length; i++) {
              const n = cs.item(i);
              if (!n.startsWith(PFX)) continue;
              const rest = n.slice(PFX.length);
              // Pure-digit suffix in range: guards against an author `--czp…` collision
              // injecting a phantom / NaN marker.
              if (!/^\d+$/.test(rest)) continue;
              const idx = +rest;
              if (idx < arg.count) mine.push(idx);
            }
            out.push([tag, mine]);
          }
          for (const c of el.children) walk(c as Element);
        };
        if (start) walk(start);
        return out;
      },
      { skip: [...skipTags], rootSel: opts.rootSel ?? null, mark, count: items.length },
    );

    // 6. Lockstep assertion — length AND per-index tag (a same-length reorder mis-maps
    //    markers→nodes silently; fatal for an oracle).
    if (walkResult.length !== elements.length) {
      throw new Error(
        `probe-matcher: marker walk length ${walkResult.length} != caller element list ${elements.length} ` +
        `(skip set / start node drift)`,
      );
    }
    for (let i = 0; i < elements.length; i++) {
      if (walkResult[i][0] !== elements[i].tag.toUpperCase()) {
        throw new Error(
          `probe-matcher: walk/element tag mismatch at index ${i}: marker walk saw ` +
          `<${walkResult[i][0]}> but caller list has <${elements[i].tag}> (walk order drift)`,
        );
      }
    }
  } catch (e) {
    await dispose();
    throw e;
  }

  // Index nodeId → the element's set of lit probe ids.
  const litByNode = new Map<number, number[]>();
  elements.forEach((e, i) => litByNode.set(e.nodeId, walkResult[i][1]));

  // ── lookups ──────────────────────────────────────────────────────────────────

  // Group an explicit lit-probe-id list into { host, pe } — host = Map<ruleIdx,Set<selIdx>>,
  // pe = Map<peType, Map<ruleIdx,Set<selIdx>>>. Shared by the at-rest read (from `litByNode`)
  // and the under-force read (from freshly-read `--czp` markers).
  function collectFrom(litIds: Iterable<number>) {
    const host = new Map<number, Set<number>>();
    const pe = new Map<string, Map<number, Set<number>>>();
    for (const pid of litIds) {
      const it = items[pid];
      if (!it) continue;
      const bucket = it.pe ? (pe.get(it.pe) ?? pe.set(it.pe, new Map()).get(it.pe)!) : host;
      if (!bucket.has(it.rule)) bucket.set(it.rule, new Set());
      bucket.get(it.rule)!.add(it.sel);
    }
    return { host, pe };
  }

  function assemble(host: Map<number, Set<number>>, pe: Map<string, Map<number, Set<number>>>): MatchedStyles {
    const pseudoElements: PseudoElementMatch[] = [];
    for (const [peType, hits] of pe) {
      pseudoElements.push({ pseudoType: peType, matches: orderAndEmit(rules, hits) });
    }
    // inlineStyle/attributesStyle intentionally UNSET (the caller supplies those tiers).
    return { matchedCSSRules: orderAndEmit(rules, host), pseudoElements };
  }

  function matchedFor(nodeId: number): MatchedStyles {
    // At-rest matches: every lit probe (a state-bearing selector self-excludes — dark at
    // rest — so only state-free/at-rest-satisfied selectors light).
    const g = collectFrom(litByNode.get(nodeId) || []);
    return assemble(g.host, g.pe);
  }

  // Parse a node's computed-property NAMES into the in-range lit `--czp` marker ids. Mirrors
  // the build-time marker read (prefix + pure-digit suffix in range) so a pathological author
  // `--czp<n>` collision can't inject a phantom marker.
  function markerIdsFromProps(propNames: Iterable<string>): number[] {
    const out: number[] = [];
    for (const n of propNames) {
      if (!n.startsWith(mark)) continue;
      const rest = n.slice(mark.length);
      if (!/^\d+$/.test(rest)) continue;
      const idx = +rest;
      if (idx < items.length) out.push(idx);
    }
    return out;
  }

  function matchedFromComputed(computedPropNames: Iterable<string>): MatchedStyles {
    const g = collectFrom(markerIdsFromProps(computedPropNames));
    return assemble(g.host, g.pe);
  }

  const riskOut: ProbeRisk = {
    ...risk,
    // `mustFallbackToCdp` is the AT-REST-poisoning set only — risks that make the raw
    // (rest) match set itself wrong, so the WHOLE extraction must use CDP. There is no
    // per-state gate: state deltas are read as ENGINE-TRUTH by re-reading the raw `--czp`
    // markers under `CSS.forcePseudoState` (`matchedFromComputed`), so no state-selector
    // class needs a CDP fallback. `ownerlessSheet` is DIAGNOSTIC only (an @import'd sheet is
    // ownerless and ubiquitous; the spike proved the probe path exact on a production site which carried
    // one). `sheetTextFailed` is DIAGNOSTIC too — a text-unreadable sheet is HARVESTED from
    // CSSOM by the dual-source inventory (§2); only a TRULY sourceless sheet (`sourcelessSheet`:
    // text AND CSSOM both unreadable) can't be recovered and forces CDP.
    mustFallbackToCdp: risk.scope || risk.sourcelessSheet || risk.droppedBraceSelector,
  };
  return { matchedFor, matchedFromComputed, dispose, probeCssBytes: css.length, elementCount: elements.length, risk: riskOut };
}
