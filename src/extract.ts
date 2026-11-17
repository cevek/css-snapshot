// The extraction driver: drives a Chromium page over CDP, feeds the browser's own
// cascade into the pure resolve/de-noise core (./internal/*), and serialises the
// result (`reworkStyles` → JSON, `reworkHtml` / `jsonToHtml` → HTML).
// See docs/ARCHITECTURE.md.

// No playwright import: the driver is typed structurally, so it runs over a playwright
// Page as well as over a raw CDP session factory (`cdp.ts` `cdpPage`) and type-checks
// for a consumer that has no playwright installed.

/** What extraction needs to run code in a document. playwright's `Page` and `Frame`
 *  both satisfy it. */
export interface EvalContext {
  evaluate<R>(fn: string | (() => R | Promise<R>)): Promise<R>;
  evaluate<R, Arg>(fn: (arg: Arg) => R | Promise<R>, arg: Arg): Promise<R>;
}

/** What extraction needs from a CDP session. playwright's `CDPSession` satisfies it. */
export interface ExtractionSession {
  send(method: string, params?: object): Promise<any>;
  on(event: string, listener: (params: any) => void): unknown;
  detach(): Promise<void>;
}

/** An iframe to extract from (`reworkStyles({ frame })`): a playwright `Frame`. It is
 *  handed to `newCDPSession`, so frame mode needs a page whose `newCDPSession` knows
 *  frames — playwright's does; `cdp.ts` `CdpPage` rejects it. */
export type FrameLike = EvalContext;

/** What extraction needs from a page: playwright's `Page` satisfies it, and so does
 *  `cdp.ts` `CdpPage`. */
export interface ExtractionPage extends EvalContext {
  context(): { newCDPSession(target: ExtractionPage | FrameLike): Promise<ExtractionSession> };
}
import { tokenize as parselTokenize } from 'parsel-js';
import {
  resolveElementStyles, resolvePseudoElement, diffResolved, denoiseResolved, REPLICABLE_PSEUDOS, INHERITABLE,
  MATERIALISED_ORDER,
} from './internal/resolve.ts';
import { buildStyleString } from './internal/style-string.ts';
import { orderPropsShorthandFirst } from './internal/shorthand.ts';
import { cascadeOrdered } from './internal/cascade.ts';
import type { MatchedStyles, CssStyle, RuleMatch } from './internal/cdp-types.ts';
import { buildProbeMatcher, type ProbeElement, type ProbeMatcher } from './internal/probe-matcher.ts';

import type { ResolvedDecl } from './internal/cascade.ts';
export type { ResolvedDecl } from './internal/cascade.ts';

export interface ExtractElementCssOptions {
  /** Materialise inherited props (font/color/line-height/…) from ancestors. Default true. */
  includeInherited?: boolean;
  /** Prepend the page's reachable @font-face / @import CSS. Default false. */
  embedFonts?: boolean;
  /** Append a trailing `/* d:x,y,w,h *​/` layout comment (parent-relative offset + size). Default false. */
  includeRects?: boolean;
  /** No-op for a single childless element (there are no SVG children to strip). Kept for parity. Default false. */
  stripSvg?: boolean;
}

/** Pseudo-class states we can force via CDP. `focus-visible` co-forces `focus`. */
const STATE_FORCE: Record<string, string[]> = {
  hover: ['hover'],
  focus: ['focus'],
  'focus-visible': ['focus', 'focus-visible'],
  active: ['active'],
  disabled: ['disabled'],
};
const DEFAULT_STATES = ['hover', 'focus', 'focus-visible', 'active', 'disabled'];

// Author-cascade matcher selection (whole-document rework path only). `probe` =
// the browser-side probe-sheet matcher (src/probe-matcher.ts) — ONE inspector
// sheet injection + ONE marker read instead of a per-node
// getMatchedStylesForNode (the dominant cost, ~250ms/node on a deep Tailwind
// page); `cdp` = the original per-node path. Probe auto-falls-back to CDP on any
// risk flag, a build failure, or a mode it can't serve (frame). Override with
// the `matcher` option or env `CSS_SNAPSHOT_MATCHER=probe|cdp`. See ARCHITECTURE.md §10.
const DEFAULT_MATCHER: 'probe' | 'cdp' = 'probe';

/** Same-process frame mode stamps the frame's <html> with this attribute (+ a sequence
 *  number) to find its document in the pierced snapshot; it never reaches the output. */
export const FRAME_STAMP_PREFIX = 'data-css-snapshot-frame-';
/** The active author-cascade matcher: env `CSS_SNAPSHOT_MATCHER` override, else the
 *  build default. Exported so the baseline capture + the guard/differential tests
 *  select the same matcher (and its path-specific baseline) as the extraction. */
export function matcherMode(): 'probe' | 'cdp' {
  // `process` is absent in Playwright MCP's run-code vm (src/pw-mcp.ts).
  const env = typeof process === 'undefined' ? undefined : process.env?.CSS_SNAPSHOT_MATCHER;
  const v = (env || '').toLowerCase();
  return v === 'probe' || v === 'cdp' ? v : DEFAULT_MATCHER;
}

// Pseudo-elements CDP does NOT surface via getMatchedStylesForNode.pseudoElements,
// so we read their computed style directly, per relevant host tag.
const COMPUTED_PSEUDO_TAGS: Record<string, string[]> = {
  input: ['placeholder'],
  textarea: ['placeholder'],
  li: ['marker'],
};
const COMPUTED_PSEUDO_PROPS = [
  'color', 'opacity', 'font-family', 'font-size', 'font-weight', 'font-style',
  'letter-spacing', 'text-transform', 'text-decoration-line', 'text-decoration-color',
  'background-color',
];

export interface ExtractElementStylesOptions extends ExtractElementCssOptions {
  /**
   * Pseudo-class states to capture. Each value is the DELTA vs the normal state
   * (only props the state changes/adds). Default: hover, focus, focus-visible,
   * active, disabled. Pass [] to skip.
   */
  states?: string[];
  /** Capture ::before/::after/::placeholder/… rules. Default true. Pass false to skip. */
  pseudoElements?: boolean;
}

export interface ExtractedStyles {
  /** The element's own de-noised declarations (same as extractElementCss). */
  base: string;
  /** state name → delta declaration string (only states that change something). */
  states: Record<string, string>;
  /** pseudo-element type (`before`/`after`/`placeholder`/…) → declaration string. */
  pseudos: Record<string, string>;
}

/**
 * Extract the resolved, de-noised CSS of ONE element (no children) as a plain
 * declaration string (`prop:value;prop:value;…`).
 *
 * @param page      A Playwright Chromium Page.
 * @param selector  A CSS selector for the single target element.
 */
export async function extractElementCss(
  page: ExtractionPage,
  selector: string,
  opts: ExtractElementCssOptions = {},
): Promise<string> {
  const { base } = await collectStyles(page, selector, opts, [], false);
  return base;
}

/**
 * Extract the element's base styles PLUS its pseudo-class state deltas
 * (:hover, :focus, …) and pseudo-element rules (::before, …). Every value is a
 * plain declaration string; empty states/pseudos are omitted.
 */
export async function extractElementStyles(
  page: ExtractionPage,
  selector: string,
  opts: ExtractElementStylesOptions = {},
): Promise<ExtractedStyles> {
  const states = opts.states ?? DEFAULT_STATES;
  const doPseudos = opts.pseudoElements !== false;
  return collectStyles(page, selector, opts, states, doPseudos);
}

async function collectStyles(
  page: ExtractionPage,
  selector: string,
  opts: ExtractElementCssOptions,
  states: string[],
  doPseudos: boolean,
): Promise<ExtractedStyles> {
  const includeInherited = opts.includeInherited !== false; // default true
  const { embedFonts = false, includeRects = false /*, stripSvg — no-op */ } = opts;

  const client = await page.context().newCDPSession(page);
  try {
    await client.send('DOM.enable');
    await client.send('CSS.enable');

    const { root } = (await client.send('DOM.getDocument', { depth: 0 })) as any;
    const { nodeId } = (await client.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector,
    })) as any;
    if (!nodeId) throw new Error(`extractElementStyles: no element matched selector ${selector}`);

    const { node } = (await client.send('DOM.describeNode', { nodeId })) as any;
    const tag = (node.localName || node.nodeName || 'div').toLowerCase();

    const result = await snapshotNode(client, page, nodeId, tag, {
      includeInherited, protectInherited: false, states, doPseudos,
    }, newDefaultsCache());

    if (embedFonts) {
      const fontsCss = await collectFontFaceCss(page);
      if (fontsCss) result.base = result.base ? `${fontsCss}\n${result.base}` : fontsCss;
    }
    if (includeRects) {
      const rect = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error(`no element matched ${sel}`);
        const r = el.getBoundingClientRect();
        const parent = el.parentElement;
        const pr = parent ? parent.getBoundingClientRect() : { left: 0, top: 0 };
        return [
          Math.round(r.left - pr.left), Math.round(r.top - pr.top),
          Math.round(r.width), Math.round(r.height),
        ].join(',');
      }, selector);
      result.base = result.base ? `${result.base} /* d:${rect} */` : `/* d:${rect} */`;
    }

    return result;
  } finally {
    await client.detach().catch(() => {});
  }
}

// ── per-node core (shared by single-element and full-document paths) ──────────

interface SnapshotConfig {
  includeInherited: boolean;
  protectInherited: boolean;
  states: string[];
  doPseudos: boolean;
}

/** Per-tag browser-default cache, so a 500-element document computes each tag's defaults once. */
interface DefaultsCache {
  base: Map<string, Map<string, string> | undefined>;
  pseudo: Map<string, Map<string, Map<string, string>>>;
}
function newDefaultsCache(): DefaultsCache {
  return { base: new Map(), pseudo: new Map() };
}

/** Resolve one node's base declarations, state deltas and pseudo-element rules. */
async function snapshotNode(
  client: any,
  page: ExtractionPage,
  nodeId: number,
  tag: string,
  cfg: SnapshotConfig,
  cache: DefaultsCache,
): Promise<ExtractedStyles> {
  const matched = await matchedStyles(client, nodeId);
  const computedMap = await computedStyle(client, nodeId);

  // Input type / disabledness change the UA defaults (see tagDefaultsSpec); the
  // single-element path has no node object, so read the attributes over CDP.
  let disabled = false, type = '';
  if (DISABLEABLE_TAGS.has(tag)) {
    const { attributes } = await client.send('DOM.getAttributes', { nodeId }).catch(() => ({ attributes: [] }));
    for (let i = 0; i < attributes.length; i += 2) {
      if (attributes[i] === 'disabled') disabled = true;
      if (tag === 'input' && attributes[i] === 'type') type = String(attributes[i + 1] || '').toLowerCase();
    }
  }
  const defKey = tag + (type ? `|type=${type}` : '') + (disabled ? '|disabled' : '');
  if (!cache.base.has(defKey)) cache.base.set(defKey, await getTagDefaults(page, tag, disabled, type));
  const tagDefaults = cache.base.get(defKey);

  const base = buildStyleString(
    resolveElementStyles(tag, matched, computedMap, tagDefaults, cfg.includeInherited, true, cfg.protectInherited),
  );

  const stateOut: Record<string, string> = {};
  if (cfg.states.length) {
    // Reference cascade WITHOUT inherited materialisation AND without tag-default
    // drops, so a state that resets a base-declared property to its default still
    // shows up in the diff.
    const reference = resolveElementStyles(tag, matched, computedMap, tagDefaults, false, false, cfg.protectInherited);
    for (const state of cfg.states) {
      const forced = STATE_FORCE[state];
      if (!forced) continue;
      try {
        await client.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: forced });
        const sm = await matchedStyles(client, nodeId);
        const scomp = await computedStyle(client, nodeId);
        const sResolved = resolveElementStyles(tag, sm, scomp, tagDefaults, false, false, cfg.protectInherited);
        const delta = buildStyleString(diffResolved(reference, sResolved));
        if (delta) stateOut[state] = delta;
      } finally {
        await client.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }).catch(() => {});
      }
    }
  }

  const pseudoOut: Record<string, string> = {};
  if (cfg.doPseudos) {
    // ── CDP-surfaced pseudo-elements: ::before/::after/::selection/::backdrop ──
    if (matched?.pseudoElements?.length) {
      if (!cache.pseudo.has(tag)) cache.pseudo.set(tag, await getPseudoDefaults(page, tag, [...REPLICABLE_PSEUDOS]));
      const peDefaults = cache.pseudo.get(tag)!;
      for (const pe of matched.pseudoElements) {
        if (!REPLICABLE_PSEUDOS.has(pe.pseudoType)) continue;
        const map = resolvePseudoElement(pe.pseudoType, pe.matches, computedMap, peDefaults.get(pe.pseudoType));
        if (map) pseudoOut[pe.pseudoType] = buildStyleString(map);
      }
    }
    // ── ::placeholder / ::marker: CDP does NOT surface these in pseudoElements,
    //    so read the pseudo's COMPUTED style and emit only what differs from the
    //    element's own computed style (these pseudos inherit from the element,
    //    so the difference IS the pseudo-specific rule). ──
    for (const pe of COMPUTED_PSEUDO_TAGS[tag] || []) {
      if (pseudoOut[pe]) continue;
      const actual = await computedPseudo(client, nodeId, pe);
      const delta = new Map<string, { value: string; important: boolean }>();
      for (const [k, v] of actual) {
        if (!v || v === computedMap.get(k)) continue;
        delta.set(k, { value: v, important: false });
      }
      if (delta.size) pseudoOut[pe] = buildStyleString(delta);
    }
  }

  return { base, states: stateOut, pseudos: pseudoOut };
}

// ─────────────────────────────────────────────────────────────────────────────
// Full-document rework
// ─────────────────────────────────────────────────────────────────────────────

export interface ReworkHtmlOptions {
  /** Pseudo-class states to capture per element (as `#id:hover{…}`). Default all; [] to skip. */
  states?: string[];
  /** Capture ::before/::after/… per element. Default true. */
  pseudoElements?: boolean;
  /** Inline the page's @font-face / @import CSS so fonts still load. Default true. */
  embedFonts?: boolean;
  /** Force the author-cascade matcher (`probe`|`cdp`), overriding env/default.
   *  Test seam — pins a path without env mutation (the differential + frame guards). */
  matcher?: 'probe' | 'cdp';
}

// Non-rendering elements: never get an id / rule (and we strip <style>/<link>).
const SKIP_REWORK_TAGS = new Set([
  'script', 'style', 'link', 'noscript', 'meta', 'title', 'head', 'base', 'template',
]);
// Same set, UPPERCASE, for the in-page getComputedStyle walks (el.tagName is
// upper-cased). Derived from SKIP_REWORK_TAGS so the CDP walk and the in-page
// walks can never diverge (a divergence throws the count-mismatch guard — the
// <noscript> crash, G1).
const SKIP_REWORK_TAGS_UPPER = [...SKIP_REWORK_TAGS].map((t) => t.toUpperCase());

function collectReworkElements(
  node: any,
  out: { nodeId: number; tag: string; node: any }[],
  ids: Set<string>,
): void {
  if (node.nodeType === 1) {
    const tag = (node.localName || node.nodeName || '').toLowerCase();
    const id = getAttr(node, 'id');
    if (id) ids.add(id);
    if (!SKIP_REWORK_TAGS.has(tag)) out.push({ nodeId: node.nodeId, tag, node });
  }
  for (const c of node.children || []) collectReworkElements(c, out, ids);
}

function getAttr(node: any, name: string): string | undefined {
  const a: string[] = node.attributes || [];
  for (let i = 0; i < a.length; i += 2) if (a[i] === name) return a[i + 1];
  return undefined;
}

/** Locate a node by nodeId in a CDP `DOM.getDocument({depth:-1})` snapshot tree. */
function findNodeById(node: any, nodeId: number): any {
  if (node.nodeId === nodeId) return node;
  for (const c of node.children || []) {
    const hit = findNodeById(c, nodeId);
    if (hit) return hit;
  }
  return null;
}

// Monotonic, collision-free suffix for the same-process frame stamp (below).
let frameStampSeq = 0;

/**
 * In a `DOM.getDocument({pierce:true})` snapshot, find the iframe content
 * document whose <html> carries `attr` — a unique marker stamped via
 * `frame.evaluate` on the target frame's `documentElement`. This is how a
 * SAME-PROCESS (same-site) iframe — which shares the parent's CDP session and so
 * has no session of its own — is located from the PARENT's session. URL is NOT a
 * reliable key: the diff tool routinely embeds two children with an identical url
 * (same-DOM precondition), so we match the exact `Frame` the caller passed, not
 * its address. `attributes` is CDP's flat [name, value, …] array.
 */
function findStampedContentDoc(node: any, attr: string): any {
  const cd = node.contentDocument;
  if (cd) {
    const htmlEl = (cd.children || []).find((c: any) => c.nodeType === 1);
    const attrs: string[] = htmlEl?.attributes || [];
    for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === attr) return cd;
    const deep = findStampedContentDoc(cd, attr);
    if (deep) return deep;
  }
  for (const c of node.children || []) {
    const hit = findStampedContentDoc(c, attr);
    if (hit) return hit;
  }
  return null;
}

function idSelector(id: string): string {
  return /^-?[A-Za-z_][\w-]*$/.test(id) ? `#${id}` : `[id="${id.replace(/(["\\])/g, '\\$1')}"]`;
}

// ─────────────────────────────────────────────────────────────────────────────
// reworkHtml — rewrite the whole loaded document into a self-contained form:
// every element that carries resolved styles gets a stable id (existing ids
// reused/deduped), and one <style> of `#id{…}` / `#id:hover{…}` / `#id::before{…}`
// rules reproduces the render. All original stylesheets, inline styles and
// scripts are stripped, so opening the returned HTML yields the same rendered
// picture with only id-based rules. Inheritance flows through the emitted rules.
//
// How it works (see ARCHITECTURE.md for the full design):
//   • per-element author cascade via CDP getMatchedStylesForNode (parallel);
//   • ONE page.evaluate snapshots getComputedStyle for every node (no per-node
//     round-trips; custom props included for var());
//   • states resolved in REVERSE: collect state-bearing selectors, find their
//     trigger/subject elements, force only the triggers (catches group-hover);
//   • :focus/:focus-visible only on focusable elements, :disabled only on form
//     controls.
// ─────────────────────────────────────────────────────────────────────────────

// Longhands the resolve passes read even when not declared (border/outline).
const EXTRA_COMPUTED_PROPS = [
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'outline-style', 'outline-width',
];
const FOCUSABLE_TAGS = new Set(['a', 'area', 'button', 'input', 'select', 'textarea']);
const FORM_CONTROL_TAGS = new Set(['input', 'select', 'textarea', 'button', 'fieldset', 'optgroup', 'option']);

/** Collect declared property names + referenced custom-property names from a node's matched styles. */
function collectPropsAndVars(matched: MatchedStyles | null, props: Set<string>, vars: Set<string>): void {
  if (!matched) return;
  const scan = (style: any) => {
    if (!style?.cssProperties) return;
    for (const p of style.cssProperties) {
      if (p.name) props.add(p.name.toLowerCase());
      if (p.value) for (const m of String(p.value).matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) vars.add(m[1]);
    }
  };
  for (const rm of matched.matchedCSSRules || []) scan(rm.rule.style);
  scan(matched.inlineStyle);
  scan(matched.attributesStyle);
}

/** Split a selector list on top-level commas (respecting () and []). */
function splitSelectorList(text: string): string[] {
  const out: string[] = [];
  let depth = 0, last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { out.push(text.slice(last, i)); last = i + 1; }
  }
  out.push(text.slice(last));
  return out.map((s) => s.trim()).filter(Boolean);
}

// Functional pseudo-classes whose argument is itself a selector. `:is/:where/:not`
// are SELF-scoped (a state inside them applies to the compound's own element, so
// `.x:is(.y:hover)` ≡ `.x.y:hover`); `:has` is RELATIONAL (the state applies to a
// descendant/related element, not the subject).
const SELF_FUNC_PSEUDOS = new Set(['is', 'where', 'not', 'matches']);
const isFuncPseudo = (t: any) => t.type === 'pseudo-class' && t.argument != null && (SELF_FUNC_PSEUDOS.has(t.name) || t.name === 'has');

/** Recursively collect the set of state-pseudo names anywhere in a selector (incl. inside functional pseudos). */
function collectStates(selector: string, states: string[]): Set<string> {
  const out = new Set<string>();
  let toks: any[];
  try { toks = parselTokenize(selector) as any[]; } catch { return out; }
  for (const t of toks) {
    if (t.type === 'pseudo-class' && states.includes(t.name)) out.add(t.name);
    else if (isFuncPseudo(t)) for (const s of collectStates(t.argument, states)) out.add(s);
  }
  return out;
}

/**
 * Return `selector` with every state pseudo removed, recursing into functional
 * pseudo arguments. An arg emptied by stripping becomes `*` (or, for `:not`, the
 * whole pseudo is dropped — an unconstrained `:not()` is a no-op filter). This
 * yields a state-stripped SUPERSET selector safe for querySelectorAll.
 */
function stripStates(selector: string, states: string[]): string {
  let toks: any[];
  try { toks = parselTokenize(selector) as any[]; } catch { return selector; }
  let out = '';
  for (const t of toks) {
    if (t.type === 'pseudo-class' && states.includes(t.name)) continue;
    if (isFuncPseudo(t)) {
      const inner = stripStates(t.argument, states).trim();
      if (!inner) { if (t.name === 'not') continue; out += `:${t.name}(*)`; }
      else out += `:${t.name}(${inner})`;
    } else out += t.content;
  }
  return out.trim();
}

// Pseudo-elements that CSS also allows with a single colon (`:before`), which
// parsel tokenizes as a pseudo-CLASS — so we strip them by name too.
const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);

/**
 * Strip pseudo-ELEMENT tokens (`::after`, legacy `:before`, …) from a selector,
 * leaving the host-element selector. Phase 4 queries the DOM with this (a
 * pseudo-element is unqueryable) and captures the pseudo's own state delta by
 * re-reading the host's `pseudoElements` under the forced state.
 */
function stripPseudoElements(selector: string): string {
  let toks: any[];
  try { toks = parselTokenize(selector) as any[]; } catch { return selector; }
  let out = '';
  for (const t of toks) {
    if (t.type === 'pseudo-element') continue;
    if (t.type === 'pseudo-class' && t.argument == null && LEGACY_PSEUDO_ELEMENTS.has(t.name)) continue;
    out += t.content;
  }
  return out.trim();
}

/** Token ranges of top-level compounds (maximal runs between combinators). */
function compoundRanges(toks: any[]): { s: number; e: number }[] {
  const ranges: { s: number; e: number }[] = [];
  let s = 0;
  for (let i = 0; i <= toks.length; i++) {
    if (i === toks.length || toks[i].type === 'combinator') {
      if (i > s) ranges.push({ s, e: i });
      s = i + 1;
    }
  }
  return ranges;
}

/** Tokens up to and including the last compound bearing any state (self or nested). Used to locate the state-carrying element within a `:has` inner selector. */
function sliceToStateCompound(toks: any[], states: string[]): any[] {
  const ranges = compoundRanges(toks);
  let end = toks.length;
  for (const r of ranges) {
    const bears = toks.slice(r.s, r.e).some((t) => (t.type === 'pseudo-class' && states.includes(t.name)) || (isFuncPseudo(t) && collectStates(t.argument, states).size));
    if (bears) end = r.e;
  }
  return toks.slice(0, end);
}

const reconstruct = (arr: any[]) => arr.map((t) => t.content).join('');

// Reverse a CSS identifier escape (`\:` → `:`, `\HH ` → the code point). parsel's
// class `token.name` is NOT usable here: it truncates at the first escaped char
// (`.a\:b` yields name `a`, `.hover\:bg-red-500` yields `hover`), so a Tailwind
// escaped-colon class would be mis-read. We unescape `token.content` instead.
function unescapeIdent(s: string): string {
  return s.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n]?|([\s\S]))/g, (_m, hex, ch) =>
    hex != null ? String.fromCodePoint(parseInt(hex, 16)) : ch);
}

// Class names required by the SUBJECT element's own (last) compound of a
// state-stripped subject selector. A matched in-subtree subject necessarily
// carries these classes, so "a last-compound class is absent from the subtree"
// ⇒ the subject can't be in the subtree ⇒ the target is safe to skip. Returns
// null on a parse failure (→ caller keeps the target); classes nested inside
// `:is()/:where()/…` are intentionally NOT collected (keeps the drop conservative).
function subjectLastCompoundClasses(subjectSel: string): string[] | null {
  let toks: any[];
  try { toks = parselTokenize(subjectSel) as any[]; } catch { return null; }
  const ranges = compoundRanges(toks);
  if (!ranges.length) return null;
  const last = ranges[ranges.length - 1];
  const out: string[] = [];
  for (let i = last.s; i < last.e; i++) {
    if (toks[i].type === 'class') out.push(unescapeIdent(String(toks[i].content).slice(1)));
  }
  return out;
}

// Combinator relating a relational trigger to its subject. Descendant (' ')
// subsumes child ('>') — with unique ids `#T:state #S` matches the child case
// too — so `>` normalises to ' '; sibling (`+`/`~`) MUST stay a sibling.
type Combinator = ' ' | '+' | '~';
type StateTarget = { state: string; triggerSel: string; subjectSel: string; combinator: Combinator | null };

/**
 * Classify the combinator(s) between a state-bearing compound and the selector's
 * subject (its last compound), given the token index `from` just past the state
 * compound. All-descendant/child ⇒ ' ' (trigger is an ancestor of subject).
 * A lone `+`/`~` ⇒ that sibling combinator. Anything mixed (e.g. `.a:hover + .b .c`)
 * has no single trigger→subject combinator → null (caller falls back to self emit).
 */
function classifyCombinator(toks: any[], from: number): Combinator | null {
  const combs = toks.slice(from).filter((t) => t.type === 'combinator').map((t) => (t.content || '').trim() || ' ');
  if (!combs.length) return null;
  if (combs.every((c) => c === ' ' || c === '>')) return ' ';
  if (combs.length === 1 && (combs[0] === '+' || combs[0] === '~')) return combs[0] as Combinator;
  return null;
}

/**
 * For a single complex selector, return the {state, triggerSel, subjectSel} for
 * each state pseudo it carries. triggerSel = elements to force (the compound
 * bearing the state; for `:has(…:state)` the descendant matched inside the has);
 * subjectSel = elements whose style changes (the whole selector, all state pseudos
 * stripped — incl. inside `:is()/:where()/:not()/:has()`).
 *
 * Nested states: `:is/:where/:not` are self-scoped (trigger = the wrapper's own
 * compound, same as a top-level state); `:has` is relational (trigger = the inner
 * descendant). The force-then-reread mechanism makes `:not(:hover)` work too —
 * forcing hover flips its match off, and the delta captures the reversion.
 */
function stateTargets(selector: string, states: string[]): StateTarget[] {
  let toks: any[];
  try { toks = parselTokenize(selector) as any[]; } catch { return []; }
  if (!toks) return [];
  if (!collectStates(selector, states).size) return [];
  // Query/keying selectors are host-element only: strip pseudo-elements too so a
  // `.x:hover::after` yields host `.x` (its ::after delta is captured separately).
  const subjectSel = stripPseudoElements(stripStates(selector, states)) || '*';
  const res: StateTarget[] = [];
  const push = (state: string, triggerSel: string, combinator: Combinator | null = null) => {
    if (triggerSel) res.push({ state, triggerSel, subjectSel, combinator });
  };

  const ranges = compoundRanges(toks);
  for (const r of ranges) {
    const ctoks = toks.slice(r.s, r.e);
    // Prefix through the end of this compound (state-stripped) = the element(s)
    // that carry this compound's selector — the anchor for both self & has triggers.
    const anchor = stripPseudoElements(stripStates(reconstruct(toks.slice(0, r.e)), states)) || '*';
    // Is the state-bearing compound the SUBJECT (last compound) or a RELATIONAL
    // trigger (a combinator follows it, so the subject = last compound is a
    // different element)? For the relational case, classify the trigger→subject
    // combinator so Phase 4 can key the delta on the trigger's id.
    const combinator: Combinator | null = r.e >= toks.length ? null : classifyCombinator(toks, r.e);
    // Self-scoped states: direct state tokens + those inside :is/:where/:not/matches.
    const selfStates = new Set<string>();
    for (const t of ctoks) {
      if (t.type === 'pseudo-class' && states.includes(t.name)) selfStates.add(t.name);
      else if (t.type === 'pseudo-class' && SELF_FUNC_PSEUDOS.has(t.name) && t.argument != null)
        for (const s of collectStates(t.argument, states)) selfStates.add(s);
    }
    for (const s of selfStates) push(s, anchor, combinator);
    // Relational states inside :has() — force the state on the inner descendant.
    for (const t of ctoks) {
      if (t.type === 'pseudo-class' && t.name === 'has' && t.argument != null) {
        const hasStates = collectStates(t.argument, states);
        if (!hasStates.size) continue;
        let inner: any[];
        try { inner = parselTokenize(t.argument) as any[]; } catch { continue; }
        const innerLoc = stripStates(reconstruct(sliceToStateCompound(inner, states)), states) || '*';
        for (const s of hasStates) push(s, `${anchor} ${innerLoc}`.trim());
      }
    }
  }
  return res;
}

/**
 * Is `selector` satisfiable under a PURE SELF-force of `forced` — i.e. does every
 * forced-state occurrence sit on the selector's OWN last compound (the subject)?
 * `.bar:hover` → yes (self). `.foo:hover .bar` → no (the state is on `.foo`, a
 * relational trigger, which a self-only force does not activate). A selector with
 * no forced state (a base rule) is trivially self-satisfiable. Reuses
 * `stateTargets`: a relational target (non-null combinator) means a forced state
 * lives before a combinator, so the rule needs a trigger beyond the subject.
 */
function selfBorneSatisfiable(selector: string, forced: string[]): boolean {
  return stateTargets(selector, forced).every((t) => t.combinator === null);
}

/**
 * Restrict a matched-under-force set to its SELF-BORNE rules — those matched via a
 * selector satisfiable under a pure self-force (see `selfBorneSatisfiable`). Used
 * on the probe path to derive a subject's self-state delta, so a RELATIONAL rule
 * (whose trigger may be out-of-subtree or relevance-ineligible, and so is NOT
 * force-active) can't leak into the self-state. A rule survives iff ≥1 of its
 * MATCHED selectors is self-borne; its `matchingSelectors` is narrowed to those.
 * `pseudoElements` and the inline/attribute tiers are filtered/carried likewise.
 */
function filterSelfBorne(ms: MatchedStyles, forced: string[]): MatchedStyles {
  const keep = (rm: RuleMatch): RuleMatch | null => {
    const sels = rm.rule.selectorList.selectors;
    const kept = rm.matchingSelectors.filter((i) => {
      const t = sels[i]?.text;
      return t ? selfBorneSatisfiable(t, forced) : false;
    });
    return kept.length ? { ...rm, matchingSelectors: kept } : null;
  };
  const keepAll = (arr: RuleMatch[]): RuleMatch[] => arr.map(keep).filter((x): x is RuleMatch => x !== null);
  return {
    matchedCSSRules: keepAll(ms.matchedCSSRules || []),
    pseudoElements: (ms.pseudoElements || [])
      .map((pe) => ({ pseudoType: pe.pseudoType, matches: keepAll(pe.matches) }))
      .filter((pe) => pe.matches.length),
    inlineStyle: ms.inlineStyle,
    attributesStyle: ms.attributesStyle,
  };
}

function isFocusable(node: any): boolean {
  const tag = (node.localName || node.nodeName || '').toLowerCase();
  if (tag === 'a' || tag === 'area') return getAttr(node, 'href') !== undefined;
  if (FOCUSABLE_TAGS.has(tag)) return true;
  return getAttr(node, 'tabindex') !== undefined || getAttr(node, 'contenteditable') !== undefined;
}
function isFormControl(node: any): boolean {
  return FORM_CONTROL_TAGS.has((node.localName || node.nodeName || '').toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared intermediate model — ONE walk (`buildReworkModel`) assigns ids and
// resolves every element's styles; both `reworkHtml` (the `<style>` string) and
// `reworkStyles` (the JSON) serialise from it. No resolve/de-noise/state logic
// is duplicated across the two entry points.
// ─────────────────────────────────────────────────────────────────────────────

type DeclMap = Map<string, { value: string; important: boolean; order?: number }>;

/** A pseudo-element's own resolved decls + its SELF-state deltas (`.el:hover::after`). */
interface PseudoModel { base: DeclMap | null; states: Map<string, DeclMap>; }

/**
 * A cross-element state delta: this element (or its pseudo-element `pseudo`)
 * changes when `triggerNodeId` enters `state`. `pseudo` undefined = the element's
 * own decls (`.foo:hover .bar`); set = a pseudo (`.foo:hover .bar::before`).
 */
interface RelationalDelta { triggerNodeId: number; state: string; combinator: Combinator; pseudo?: string; delta: DeclMap; }

interface ElementModel {
  nodeId: number;
  id: string | null;                    // output id (null = no rule, no source id)
  tag: string;
  node: any;
  base: DeclMap;                        // element's own resolved decls (may serialise empty)
  pseudos: Map<string, PseudoModel>;
  selfStates: Map<string, DeclMap>;    // self :hover/:focus/… deltas
  relational: RelationalDelta[];       // cross-element deltas, keyed on the trigger
  reference: Map<string, ResolvedDecl>; // base cascade w/o default-drop, for state diffs
  rect?: NodeRect;                      // capture-time geometry (§ StyleTreeNode meta)
  computed?: Decls;                     // de-noised computed (§ StyleTreeNode meta)
}

interface ReworkModel {
  elements: ElementModel[];            // document order
  byNode: Map<number, ElementModel>;
  states: string[];
  tree?: StyleTreeNode;                // serialisable document tree (only built when requested)
  rootFontSize?: string;               // subtree mode: document <html>'s computed font-size (rem anchor)
}

// ── JSON output shape (reworkStyles) ──
export type Decls = Record<string, string>;   // prop -> value ("red" | "red !important")
export interface StyleEntry {
  base?: Decls;
  states?: Record<string, Decls>;
  pseudos?: Record<string, { base?: Decls; states?: Record<string, Decls> }>;
  relational?: Array<{ trigger: string; state: string; combinator: string; pseudo?: string; delta: Decls }>;
}
export type StyleJson = Record<string, StyleEntry>;

/**
 * A node in the serialisable document tree. Element nodes carry `tag` (+ optional
 * `id`/`attrs`/`children`); text nodes carry `text`. Comments and the doctype are
 * omitted (they don't render); the doctype is re-emitted by `jsonToHtml`.
 */
export interface StyleTreeNode {
  tag?: string;                        // present on element nodes
  id?: string;                         // model-assigned id (styled elements)
  attrs?: Record<string, string>;      // all attributes except id + inline style
  children?: StyleTreeNode[];          // omitted for void/empty elements
  text?: string;                       // present on text nodes (verbatim, incl. whitespace)
  // ── capture-time META. Never rendered, never diffed: `jsonToHtml` serialises a
  // node by its explicit fields, and the style diff works over `elements`. It is
  // the truth of ONE capture, so `applyDiff` strips it (its output was never
  // captured — it would mix the two sides).
  rect?: NodeRect;                     // geometry RELATIVE TO THE EXTRACTION ROOT, integer px
  computed?: Decls;                    // getComputedStyle for the keys that survived denoise
}

/** Capture-time geometry, relative to the extraction root (root itself is 0,0). */
export interface NodeRect { x: number; y: number; w: number; h: number }

interface ComputedSnapshot { style: Record<string, string>; rect: NodeRect }

/**
 * Self-contained result of `reworkStyles`: from this one object alone `jsonToHtml`
 * rebuilds a fully-styled offline HTML document.
 *  - `tree`     — the document structure (from `<html>` down), styling-stripped.
 *  - `fonts`    — the page's reachable `@font-face` / `@import` CSS (may be empty).
 *  - `elements` — per-id resolved styles (`StyleJson`).
 *  - `rootContext` — SUBTREE MODE ONLY (`opts.root`): the document `<html>`'s
 *      computed `font-size`, the anchor `rem` units resolve against. Absent in
 *      whole-document mode (the real `<html>` carries its own font-size); when
 *      present, `jsonToHtml` re-hosts the subtree under a synthetic `<html>`
 *      bearing this font-size so `rem` below the cut resolves correctly.
 *  - `description` — OPTIONAL free-text human note about this snapshot (what page /
 *      element / state it captures). Pure metadata: never emitted by the extractor,
 *      ignored by `jsonToHtml` and every diff path — set by the CLI / UI only.
 *  - `removed` — OPTIONAL node-deletion marks (stamped element ids in THIS snapshot's own
 *      id space) the user made in the NodeTree: each id's subtree is CUT (`pruneArtifact`)
 *      before a diff / on a snapshot-editor Save. Non-destructive marking (the full tree
 *      is retained, unmarking is a rollback); the prune is applied at diff time / by the
 *      editor, not stored pre-pruned. Ignored by `jsonToHtml` — set by the CLI / UI only.
 */
export interface SelfContainedStyles {
  tree: StyleTreeNode;
  fonts: string;
  /** Verbatim author rules for native-widget internals (`::-webkit-*` pseudo
   *  selectors — datetime fields, scrollbars, sliders). The per-element pipeline
   *  cannot express them; `jsonToHtml` re-emits them after the generated rules. */
  widgetCss?: string;
  elements: StyleJson;
  rootContext?: { fontSize: string };
  description?: string;
  removed?: string[];
}

export interface ReworkStylesOptions {
  /**
   * Extract the subtree rooted at this element (CSS selector, first match)
   * instead of the whole document. Inherited props are materialised onto the
   * subtree root so descendants inherit correctly across the cut; the tree is
   * re-hosted under a synthetic `<html><body>` by `jsonToHtml`. The subtree
   * root must be flow content (a `<div>`/`<section>`/…, not `<tr>`/`<td>`/
   * `<option>`) — see ARCHITECTURE.md §9. Absent → whole document (default).
   */
  root?: string;
  /** Pseudo-class states to capture per element. Default all; [] to skip. */
  states?: string[];
  /** Capture ::before/::after/… (incl. their state deltas). Default true. */
  pseudoElements?: boolean;
  /** Collect the page's reachable @font-face / @import CSS into `fonts`. Default true. */
  embedFonts?: boolean;
  /**
   * Extract from an iframe instead of the top document. Works for both a
   * cross-origin OOPIF (own renderer process → a frame-scoped CDP session) and a
   * same-site same-process child (shares the parent's session → reached from the
   * page session via `DOM.getDocument({pierce:true})`; see `buildReworkModel`).
   * Every in-page evaluate runs in the frame's context, so `root`/state selectors
   * resolve against the frame's document. The resolve/de-noise/cascade core is
   * frame-agnostic — only session acquisition and document rooting are coupled.
   */
  frame?: FrameLike;
  /** Force the author-cascade matcher (`probe`|`cdp`), overriding env/default.
   *  Test seam — pins a path without env mutation (the differential + frame guards). */
  matcher?: 'probe' | 'cdp';
}

/**
 * Shared core: one CDP walk over the loaded document that assigns stable ids on
 * the LIVE DOM (existing ids reused/deduped) and resolves, per element, its base
 * declarations, pseudo-element rules, self-state deltas and relational deltas.
 * Returns the structured model; leaves the original CSS/scripts intact (callers
 * serialise + strip as needed). Detaches its own CDP client before returning.
 * When `buildDocTree` is set, also builds the serialisable document tree
 * (`reworkStyles` only) while the CDP session is still live — text-node repair
 * (§CDP truncation) needs session-scoped nodeIds, so it can't run after detach.
 *
 * When `rootSel` is set, the walk is SCOPED to the subtree rooted at that
 * element (first match): collection, DOM adjacency and the computed snapshot all
 * start there, and inherited props are materialised onto the subtree root so
 * descendants inherit across the cut (see ARCHITECTURE.md §4). `rootFontSize` is
 * captured (the document `<html>`'s computed font-size, the `rem` anchor). A
 * selector resolving to `documentElement` degrades to whole-document mode.
 */
async function buildReworkModel(page: ExtractionPage, states: string[], doPseudos: boolean, buildDocTree = false, rootSel?: string, frame?: FrameLike, matcherPref: 'probe' | 'cdp' = matcherMode()): Promise<ReworkModel> {
  // When `frame` is set, run every CONTENT-reading in-page evaluate in its
  // context. The resolve/de-noise/cascade core is frame-agnostic; the
  // document-content sites all route through `evalCtx`. (getTagDefaults/
  // getPseudoDefaults keep `page` on purpose — they read bare-tag UA defaults
  // from a throwaway iframe, document-independent.)
  const evalCtx: EvalContext = frame ?? page;

  // Acquire the CDP session and classify the frame. Two kinds of iframe:
  //  - OOPIF (cross-site, own renderer process): `newCDPSession(frame)` succeeds
  //    and its `getDocument` returns the frame's OWN document — the original path.
  //  - SAME-PROCESS (same-site): the frame is part of the parent's session, so
  //    `newCDPSession(frame)` throws ("does not have a separate CDP session"). We
  //    fall back to the PAGE session and reach the frame's document with
  //    `pierce:true` (see the same-process branch below). The try/catch keys on
  //    the exact capability we need, so it can't misclassify.
  let client: ExtractionSession;
  // The probe matcher's dedicated session — held OPEN until the end (its injected probe
  // sheet must stay live for phase-4's under-force marker re-read), detached in `finally`.
  let matcherClient: ExtractionSession | null = null;
  let matcher: ProbeMatcher | null = null;
  let frameMode: 'oopif' | 'same-process' | null = null;
  if (!frame) {
    client = await page.context().newCDPSession(page);
  } else {
    let oopif: ExtractionSession | null = null;
    try { oopif = await page.context().newCDPSession(frame); } catch { oopif = null; }
    if (oopif) { client = oopif; frameMode = 'oopif'; }
    else { client = await page.context().newCDPSession(page); frameMode = 'same-process'; }
  }

  // Cleared in `finally`: the attribute stamped on a same-process frame's <html>
  // to locate its content document (removed even on error, so the live DOM is
  // never left dirty).
  let frameStamp: string | null = null;
  try {
    await client.send('DOM.enable');
    await client.send('CSS.enable');
    await installEvalShim(evalCtx);

    let root: any;
    if (frameMode === 'same-process') {
      // Same-process: the page session can't select the frame's document by url
      // (identical-url siblings are indistinguishable), so stamp a unique marker
      // on the target frame's <html> via `frame.evaluate` (which runs in exactly
      // that frame regardless of session), then `pierce` the page snapshot and
      // find the content document carrying the stamp — that is our `root`.
      const attr = `${FRAME_STAMP_PREFIX}${++frameStampSeq}`;
      await frame!.evaluate((a) => document.documentElement.setAttribute(a, '1'), attr);
      frameStamp = attr;
      const { root: pierced } = (await client.send('DOM.getDocument', { depth: -1, pierce: true })) as any;
      root = findStampedContentDoc(pierced, attr);
      // Genuine rooting failure — surface loudly (NOT swallowed by the detection
      // catch, which has already classified the frame as same-process).
      if (!root) throw new Error(`reworkStyles: same-process frame content document not found via pierce (stamp ${attr})`);
      // Strip the stamp from the IN-MEMORY snapshot too: the pierced getDocument
      // captured <html> WITH the marker, and the live-DOM `finally` cleanup can't
      // reach this already-taken snapshot. In whole-frame mode <html> IS the tree
      // root, so an uncleared stamp would leak into the emitted `tree` (which must
      // add nothing to the strip set — ARCHITECTURE.md §4.5).
      const htmlEl = (root.children || []).find((c: any) => c.nodeType === 1);
      const at: string[] | undefined = htmlEl?.attributes;
      if (at) { const i = at.indexOf(attr); if (i >= 0 && i % 2 === 0) at.splice(i, 2); }
    } else {
      // Whole-page or OOPIF: the session's own `getDocument` gives the right doc.
      ({ root } = (await client.send('DOM.getDocument', { depth: -1 })) as any);
    }

    // Subtree mode: locate the root element node in the snapshot tree. A selector
    // that resolves to <html> (documentElement) is treated as whole-document
    // (no synthetic re-host / rootContext), so `root:'html'` degrades cleanly.
    let subtreeNode: any = null;
    let rootFontSize: string | undefined;
    let rootLineHeightFactor: string | null = null;
    if (rootSel) {
      const { nodeId: subId } = (await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: rootSel })) as any;
      if (!subId) throw new Error(`reworkStyles: no element matched root selector ${rootSel}`);
      const found = findNodeById(root, subId);
      // The match must be locatable in the snapshot tree. If not, FAIL loudly
      // rather than silently degrading to whole-document extraction — a caller
      // that asked for a subtree and got the full document has no signal.
      if (!found) throw new Error(`reworkStyles: root selector ${rootSel} matched a node not reachable in the document tree`);
      // A selector resolving to <html> (documentElement) IS whole-document mode —
      // degrade cleanly (no rootContext / synthetic re-host), so `root:'html'` works.
      const isDocEl = (found.localName || found.nodeName || '').toLowerCase() === 'html';
      if (!isDocEl) {
        subtreeNode = found;
        rootFontSize = await evalCtx.evaluate(() => getComputedStyle(document.documentElement).fontSize);
        rootLineHeightFactor = await probeLineHeightFactor(evalCtx, rootSel!);
      }
    }
    const walkRoot = subtreeNode ?? root;         // node whose subtree we collect
    const subtreeRootNodeId: number | undefined = subtreeNode?.nodeId;

    const elements: { nodeId: number; tag: string; node: any }[] = [];
    const usedIds = new Set<string>();
    collectReworkElements(walkRoot, elements, usedIds);

    // DOM adjacency (for pairing a relational subject to its concrete trigger in
    // Phase 4): parent of each element node + each parent's ordered element
    // children (all element children, so `+`/`~` adjacency matches CSS — an
    // interposed <script> breaks adjacency just as the browser sees it).
    const parentOf = new Map<number, number>();
    const elemChildren = new Map<number, number[]>();
    const buildDom = (node: any) => {
      const kids: number[] = [];
      for (const c of node.children || []) {
        if (c.nodeType === 1) { parentOf.set(c.nodeId, node.nodeId); kids.push(c.nodeId); }
        buildDom(c);
      }
      if (kids.length) elemChildren.set(node.nodeId, kids);
    };
    // Scope adjacency to the walked subtree: `parentOf` stops at the subtree
    // root, so a relational trigger OUTSIDE the subtree is never paired (its id
    // wouldn't exist in the output — see ARCHITECTURE.md §9). Whole-doc mode
    // walks from the document node, unchanged.
    buildDom(walkRoot);
    // Nearest ancestor of `subj` in `trigSet` (descendant/child), or the preceding
    // sibling(s) in `trigSet` (`+` = immediate, `~` = any preceding).
    const pairTriggers = (subj: number, trigSet: Set<number>, comb: Combinator): number[] => {
      if (comb === '+' || comb === '~') {
        const p = parentOf.get(subj);
        if (p == null) return [];
        const sibs = elemChildren.get(p) || [];
        const idx = sibs.indexOf(subj);
        if (idx <= 0) return [];
        if (comb === '+') return trigSet.has(sibs[idx - 1]) ? [sibs[idx - 1]] : [];
        const out: number[] = [];
        for (let i = idx - 1; i >= 0; i--) if (trigSet.has(sibs[i])) out.push(sibs[i]);
        return out;
      }
      let cur = parentOf.get(subj);
      while (cur != null) { if (trigSet.has(cur)) return [cur]; cur = parentOf.get(cur); }
      return [];
    };

    // ── Author-cascade matcher: probe (browser-side) or CDP (per-node). ──
    // Probe serves whole-document + subtree only; frame mode uses the CDP path
    // (frame-scoped probe injection is unproven — see ARCHITECTURE.md §4.7/§10,
    // backlog t-4ycjsr). Built on a DEDICATED fresh session: buildProbeMatcher
    // enables CSS on ITS client to replay `styleSheetAdded` for existing sheets,
    // but the main `client` already has CSS enabled (that replay is consumed), so
    // a fresh session is required (⚑ SESSION PRECONDITION). Safe: the matcher
    // never sends elements[].nodeId to CDP (it zips markers positionally) and
    // reuses our already-fetched `root` as `domRoot` (backendNodeId ordering is
    // cross-session stable), so the caller's nodeIds stay valid.
    // The matcher's session is held OPEN until after phase-4: the injected probe sheet must
    // stay live so phase-4 can re-read `--czp` markers UNDER `CSS.forcePseudoState` (the
    // sheet survives the session detach in practice, but keeping the session is the safe
    // guarantee). Detached in `finally` at the end of buildReworkModel.
    if (matcherPref === 'probe' && !frame) {
      const probeEls: ProbeElement[] = elements.map((e) => ({ nodeId: e.nodeId, tag: e.tag.toUpperCase() }));
      matcherClient = await page.context().newCDPSession(page);
      try {
        const m = await buildProbeMatcher(matcherClient, evalCtx, probeEls, {
          domRoot: root,
          rootSel: subtreeNode ? rootSel : undefined,
          skipTags: new Set(SKIP_REWORK_TAGS_UPPER),
        });
        // Reject the build (→ CDP fallback) on any risk flag OR an empty index:
        // a zero-sheet replay (the CSS-already-enabled miss) yields no probes
        // (`probeCssBytes === 0`) and would fail the differential everywhere with
        // no localisation — the lockstep tag-check only catches walk DRIFT, not a
        // silent replay miss. `probeCssBytes === 0` on a genuinely style-free page
        // is a harmless fallback (both paths resolve empty there).
        if (m.elementCount > 0 && m.probeCssBytes > 0 && !m.risk.mustFallbackToCdp) matcher = m;
        else await m.dispose();
      } catch {
        // Lockstep drift / injection failure → hard build failure → CDP fallback.
        matcher = null;
      }
    }
    const useProbe = matcher != null;
    // Phase-4 (state deltas) rides the probe whenever phase-1 does: the under-force matched
    // set is read as ENGINE-TRUTH from the raw `--czp` markers (no static synthesis, no
    // per-state gate), so there is nothing to fall back for. (`risk.mustFallbackToCdp`
    // already forced the WHOLE extraction to CDP above — see ARCHITECTURE.md §10.)
    const useProbeState = useProbe;

    // ── Phase 1: matched styles per element + prop/var union ──
    const cache = newDefaultsCache();
    const matchedByNode = new Map<number, MatchedStyles | null>();
    // Probe path: the inline + presentational-attribute tiers the matcher leaves
    // unset, assembled per node (also reused under force in phase 4 — force does
    // not change a node's inline style / presentational attributes).
    const tiersByNode = new Map<number, { inlineStyle?: CssStyle; attributesStyle?: CssStyle }>();
    const declaredProps = new Set<string>(EXTRA_COMPUTED_PROPS);
    // Subtree mode: snapshot the FULL inheritable set on every element, not just
    // declared props — an inherited value the subtree root must materialise may
    // have been set by an ancestor via a UA rule / presentational attribute and
    // never appear in a declared-prop union. Cheap insurance.
    //
    // Whole-document mode wants the same set for ONE node: de-noising drops
    // inherited values everywhere, so a reader resolving an effective value walks
    // up the tree — and that walk must terminate. In subtree mode the root
    // materialises the set into its own rule; here nothing does, so the root node
    // carries it as capture meta instead (`ROOT_INHERITED_META`).
    for (const p of INHERITABLE) declaredProps.add(p);
    const varNames = new Set<string>();
    if (useProbe) {
      // Probe supplies matchedCSSRules + pseudoElements from ONE marker read;
      // assemble the inline & attribute tiers from getInlineStylesForNode (cheap,
      // no ancestor cost — see `inlineAndAttrs`). No per-node getMatchedStylesForNode.
      const tiersAll = await Promise.all(elements.map((e) => inlineAndAttrs(client, e.nodeId)));
      elements.forEach((e, i) => {
        tiersByNode.set(e.nodeId, tiersAll[i]);
        const pm = matcher!.matchedFor(e.nodeId);
        const assembled: MatchedStyles = {
          matchedCSSRules: pm.matchedCSSRules,
          pseudoElements: pm.pseudoElements,
          inlineStyle: tiersAll[i].inlineStyle,
          attributesStyle: tiersAll[i].attributesStyle,
        };
        matchedByNode.set(e.nodeId, assembled);
        collectPropsAndVars(assembled, declaredProps, varNames);
      });
    } else {
      // CDP path: getMatchedStylesForNode is the dominant cost (~250ms/node on a
      // deep page); CDP reads pipeline under Promise.all, so fetch concurrently.
      const matchedAll = await Promise.all(elements.map((e) => matchedStyles(client, e.nodeId)));
      elements.forEach((e, i) => {
        matchedByNode.set(e.nodeId, matchedAll[i]);
        collectPropsAndVars(matchedAll[i], declaredProps, varNames);
      });
    }

    // ── Phase 2: ONE snapshot of getComputedStyle for every element (document order) ──
    // Scoped to the same subtree root as `collectReworkElements` so the two walks
    // stay in lockstep (a length mismatch throws below).
    const computedList = await snapshotComputed(evalCtx, [...declaredProps], [...varNames], SKIP_REWORK_TAGS_UPPER, subtreeNode ? rootSel : undefined);
    if (computedList.length !== elements.length) {
      throw new Error(`reworkHtml: computed snapshot length ${computedList.length} != elements ${elements.length}`);
    }
    const computedByNode = new Map<number, Map<string, string>>();
    const rectByNode = new Map<number, NodeRect>();
    elements.forEach((e, i) => {
      computedByNode.set(e.nodeId, new Map(Object.entries(computedList[i]!.style)));
      rectByNode.set(e.nodeId, computedList[i]!.rect);
    });

    // ── Phase 3: resolve base + pseudos, assign ids ──
    // The node the emitted `tree` is rooted at — also where an effective-value
    // walk-up terminates, so it is the one that carries the INHERITABLE computed
    // as meta. Resolved ONCE: a second copy of this expression could drift and
    // silently put that meta on a different node.
    const treeRootEl: any = subtreeNode ?? (root.children || []).find((c: any) => c.nodeType === 1);
    let counter = 0;
    const info = new Map<number, ElementModel>();
    // Ids actually placed into the OUTPUT (distinct from usedIds, which are the
    // source ids seen at collect time). An id must be unique in the output, so a
    // duplicate source id is reused only ONCE — later duplicates are re-minted.
    const assignedIds = new Set<string>();
    const mintId = async (nodeId: number): Promise<string> => {
      let id: string;
      do { id = `el${++counter}`; } while (usedIds.has(id) || assignedIds.has(id));
      usedIds.add(id); assignedIds.add(id);
      // Never restored on the live page (t-5a8s88).
      await client.send('DOM.setAttributeValue', { nodeId, name: 'id', value: id });
      return id;
    };
    // Reuse an element's existing id, unless an earlier element already consumed
    // it (duplicate) — then mint a fresh one and set it on the node.
    const ensureId = async (nodeId: number, node: any): Promise<string> => {
      const existing = getAttr(node, 'id');
      if (existing && !assignedIds.has(existing)) { assignedIds.add(existing); return existing; }
      return mintId(nodeId);
    };

    // Prefetch each unique tag's browser defaults concurrently (one iframe eval
    // each). Keyed by tag + input type + disabledness (tagDefaultsSpec): the UA
    // paints those variants differently.
    const defSpecs = new Map(elements.map((e) => {
      const s = tagDefaultsSpec(e.tag, e.node);
      return [s.key, { tag: e.tag, ...s }] as const;
    }));
    await Promise.all([...defSpecs.values()].map(async (s) => {
      if (!cache.base.has(s.key)) cache.base.set(s.key, await getTagDefaults(page, s.tag, s.disabled, s.type));
    }));

    for (const e of elements) {
      const m = matchedByNode.get(e.nodeId) || null;
      const computedMap = computedByNode.get(e.nodeId) || new Map<string, string>();
      const tagDefaults = cache.base.get(tagDefaultsKey(e.tag, e.node));

      // Subtree mode: materialise inherited props (font/color/line-height/…) onto
      // the subtree ROOT only, so descendants inherit them across the cut through
      // the emitted rules — exactly as single-element mode does. Descendants keep
      // includeInherited:false (they inherit from the root as in whole-doc mode).
      const isSubtreeRoot = e.nodeId === subtreeRootNodeId;
      const baseMap = resolveElementStyles(e.tag, m, computedMap, tagDefaults, isSubtreeRoot, true, true);
      // An INHERITED unitless line-height materialises as frozen used px; when
      // the probe proved it is a factor, re-emit the factor so descendants with
      // a different font-size scale exactly as in situ. Only the MATERIALISED
      // entry — an author-declared line-height on the root itself already
      // carries its authored form.
      if (isSubtreeRoot && rootLineHeightFactor) {
        const lh = baseMap.get('line-height');
        if (lh && lh.order === MATERIALISED_ORDER) lh.value = rootLineHeightFactor;
      }
      // G2: an element carrying the `hidden` attribute whose author `display` was
      // dropped as "== tag default" collapses in the output — the UA
      // `[hidden]{display:none}` wins. Re-emit its computed display explicitly so
      // the id rule overrides `[hidden]`. (If display isn't in the snapshot, the
      // element is genuinely hidden — leave it so `[hidden]` keeps it hidden.)
      if (getAttr(e.node, 'hidden') !== undefined) {
        const disp = computedMap.get('display');
        if (disp) baseMap.set('display', { value: disp, important: false, specificity: Number.MAX_SAFE_INTEGER, order: Number.MAX_SAFE_INTEGER });
      }
      const base = buildStyleString(baseMap);
      const reference = resolveElementStyles(e.tag, m, computedMap, tagDefaults, false, false, true);

      const pseudos = new Map<string, PseudoModel>();
      if (doPseudos) {
        if (m?.pseudoElements?.length) {
          if (!cache.pseudo.has(e.tag)) cache.pseudo.set(e.tag, await getPseudoDefaults(page, e.tag, [...REPLICABLE_PSEUDOS]));
          const peDef = cache.pseudo.get(e.tag)!;
          for (const pe of m.pseudoElements) {
            if (!REPLICABLE_PSEUDOS.has(pe.pseudoType)) continue;
            const map = resolvePseudoElement(pe.pseudoType, pe.matches, computedMap, peDef.get(pe.pseudoType));
            if (map) pseudos.set(pe.pseudoType, { base: map, states: new Map() });
          }
        }
        for (const pe of COMPUTED_PSEUDO_TAGS[e.tag] || []) {
          if (pseudos.has(pe)) continue;
          const actual = await computedPseudo(client, e.nodeId, pe);
          const delta: DeclMap = new Map();
          for (const [k, v] of actual) { if (!v || v === computedMap.get(k)) continue; delta.set(k, { value: v, important: false }); }
          if (delta.size) pseudos.set(pe, { base: delta, states: new Map() });
        }
      }

      // Resolve an output id when the element has output OR carries an existing id
      // (the latter must be deduped even if it emits no rule — it stays in the HTML).
      let id: string | null = null;
      if (getAttr(e.node, 'id') || base || pseudos.size) id = await ensureId(e.nodeId, e.node);
      info.set(e.nodeId, {
        nodeId: e.nodeId, id, tag: e.tag, node: e.node,
        base: baseMap, pseudos, selfStates: new Map(), relational: [], reference,
        rect: rectByNode.get(e.nodeId),
        // The de-noised computed: the browser's value for exactly the keys that
        // survived, so a reader sees what an authored `rem`/`var()`/`auto` became.
        // A SUBSET of `base`'s keys, not an equal set — `snapshotComputed` drops
        // empty values, and `getPropertyValue` returns "" for a shorthand whose
        // components disagree (`border` with mixed sides, `font`, `grid`).
        computed: computedFor(baseMap, computedMap, e.nodeId === treeRootEl?.nodeId),
      });
    }

    // ── Phase 4: reverse states ──
    if (states.length) {
      const stateSelTexts: string[] = await evalCtx.evaluate((sts) => {
        const re = new RegExp(':(' + sts.slice().sort((a, b) => b.length - a.length).join('|') + ')', 'i');
        const out = new Set<string>();
        const walk = (rules: CSSRuleList | undefined) => {
          if (!rules) return;
          for (let i = 0; i < rules.length; i++) {
            const r = rules[i] as any;
            if (r.selectorText && re.test(r.selectorText)) out.add(r.selectorText);
            if (r.cssRules) walk(r.cssRules);
          }
        };
        for (const sh of Array.from(document.styleSheets)) { try { walk(sh.cssRules); } catch { /* cross-origin */ } }
        return [...out];
      }, states);

      type RelEntry = { triggerSel: string; subjectSel: string; combinator: Combinator };
      const perState = new Map<string, {
        triggers: Set<string>;      // all trigger selectors to force
        subjects: Set<string>;      // all subject selectors to read (self + relational)
        selfSubjects: Set<string>;  // subject selectors whose delta keys on `#id:state`
        relEntries: RelEntry[];     // relational rules keyed on the trigger's id
      }>();
      // Subtree token pre-filter: the set of class names present anywhere in the
      // subtree. A state target whose SUBJECT's last compound requires a class
      // absent here can never match a subtree element, so it is dropped before any
      // querySelectorAll / forcePseudoState (430 → a handful on a heavy Tailwind
      // sheet). Only in subtree mode; whole-doc keeps every selector.
      const subClasses = new Set<string>();
      if (subtreeNode) {
        for (const el of elements) {
          const cls = getAttr(el.node, 'class');
          if (cls) for (const c of cls.split(/\s+/)) if (c) subClasses.add(c);
        }
      }
      const seenRel = new Set<string>();
      for (const txt of stateSelTexts) {
        for (const sel of splitSelectorList(txt)) {
          for (const t of stateTargets(sel, states)) {
            // Drop a target whose subject element cannot exist in the subtree
            // (its last compound needs a class no subtree element carries). Bare
            // tag / attribute / `*` / `:is()`-only subjects have no such class →
            // kept (conservative). Byte-identical: a dropped target's subject QSA
            // is empty anyway (scoped to the subtree below).
            if (subtreeNode) {
              const cls = subjectLastCompoundClasses(t.subjectSel);
              if (cls && cls.length && !cls.some((c) => subClasses.has(c))) continue;
            }
            let ps = perState.get(t.state);
            if (!ps) { ps = { triggers: new Set(), subjects: new Set(), selfSubjects: new Set(), relEntries: [] }; perState.set(t.state, ps); }
            ps.triggers.add(t.triggerSel);
            ps.subjects.add(t.subjectSel);
            if (t.combinator == null) {
              ps.selfSubjects.add(t.subjectSel);
            } else {
              const key = `${t.state}|${t.triggerSel}|${t.subjectSel}|${t.combinator}`;
              if (!seenRel.has(key)) { seenRel.add(key); ps.relEntries.push({ triggerSel: t.triggerSel, subjectSel: t.subjectSel, combinator: t.combinator }); }
            }
          }
        }
      }

      // Scope Phase-4 queries to the subtree (whole-doc mode → the document node,
      // unchanged). This stops forcing whole-page triggers on out-of-subtree
      // elements (the visual flicker + perf floor). See ARCHITECTURE.md §9 for the
      // one output consequence (an out-of-subtree relational trigger no longer
      // leaks into a subject's self-state).
      const qsaScope = subtreeRootNodeId ?? root.nodeId;
      // DOM.querySelectorAll scoped to a node EXCLUDES that node itself, so the
      // subtree ROOT is missing from every result — its own self-states / trigger
      // role would be lost (the whole-document scope included it before). Re-add it
      // when it matches any selector in the set (root-only `el.matches`, resolved once).
      let rootObjId: string | undefined | null;
      const rootMatchesAny = async (sels: Set<string>): Promise<boolean> => {
        if (subtreeRootNodeId == null || !sels.size) return false;
        try {
          if (rootObjId === undefined) {
            const rn = (await client.send('DOM.resolveNode', { nodeId: subtreeRootNodeId })) as any;
            rootObjId = rn.object?.objectId ?? null;
          }
          if (!rootObjId) return false;
          const { result } = (await client.send('Runtime.callFunctionOn', {
            objectId: rootObjId,
            functionDeclaration: 'function(sels){for(const s of sels){try{if(this.matches(s))return true}catch(e){}}return false}',
            arguments: [{ value: [...sels] }],
            returnByValue: true,
          })) as any;
          return result?.value === true;
        } catch { return false; }
      };
      const queryAll = async (sels: Set<string>): Promise<number[]> => {
        const ids = new Set<number>();
        for (const sel of sels) {
          try {
            const { nodeIds } = (await client.send('DOM.querySelectorAll', { nodeId: qsaScope, selector: sel })) as any;
            for (const n of nodeIds) ids.add(n);
          } catch { /* invalid selector after stripping */ }
        }
        if (subtreeRootNodeId != null && await rootMatchesAny(sels)) ids.add(subtreeRootNodeId);
        return [...ids];
      };

      const emittedRel = new Set<string>();
      // relevance: a plain <div> can't be :focus / :disabled — skip forcing/keying it.
      const triggerRelevant = (n: number, state: string): boolean => {
        const nd = info.get(n)?.node;
        if (!nd) return true;
        if (state === 'focus' || state === 'focus-visible') return isFocusable(nd);
        if (state === 'disabled') return isFormControl(nd);
        return true;
      };
      for (const state of states) {
        const ps = perState.get(state);
        if (!ps) continue;
        const forced = STATE_FORCE[state];
        if (!forced) continue;

        const triggers = (await queryAll(ps.triggers)).filter((n) => triggerRelevant(n, state));
        if (!triggers.length) continue;
        // The FORCED set — a self-state applies to an element only if it was
        // actually forced (a relevance-eligible trigger). CDP satisfies this by
        // construction (a non-forced subject reads its normal style → empty delta);
        // the probe's under-force marker re-read reflects only the actually-forced
        // triggers too, but a universal self-state rule (`:disabled{cursor:default}`)
        // could still light on a non-eligible subject via a relational path — the
        // `forcedSet` gate keys self-states only on nodes that were actually forced.
        const forcedSet = new Set(triggers);
        const subjects = await queryAll(ps.subjects);
        // Self subjects are the forced elements whose OWN state (incl. their own
        // pseudo-elements) applies — the only nodes eligible for a self pseudo-
        // state (`.el:hover::after`); a relational subject is not forced.
        const selfNodeSet = new Set(await queryAll(ps.selfSubjects));

        await Promise.all(triggers.map((n) => client.send('CSS.forcePseudoState', { nodeId: n, forcedPseudoClasses: forced })));
        // subject nodeId → its state delta map (computed once while triggers are
        // forced; emission — self vs relational — is decided afterwards). The
        // `self*` variants carry the SELF-BORNE-only delta (probe path) so a
        // relational rule can't leak into a subject's self-state; they alias the
        // full maps on the CDP path.
        const deltaByNode = new Map<number, DeclMap>();
        const selfDeltaByNode = new Map<number, DeclMap>();
        const selfPseudoStateByNode = new Map<number, Map<string, DeclMap>>();
        // subject nodeId → { pseudoType → delta vs its base pseudo map }. Populated
        // for ALL subjects; attached as a SELF pseudo-state (self subjects) or a
        // RELATIONAL pseudo delta (relational subjects) below.
        const pseudoStateByNode = new Map<number, Map<string, DeclMap>>();
        try {
          // Subjects are few (dozens): read their forced matched+computed
          // concurrently (force stays active), then resolve the delta per node.
          // Probe path: the matched-under-force set is ENGINE-TRUTH — the subject's
          // under-force computed read (`scomp`) already carries the raw `--czp`
          // markers the engine lit under this force, so `matchedFromComputed` rebuilds
          // the exact `getMatchedStylesForNode`-under-force match set with NO extra
          // round-trip (the marker read rides the computed read). Inline/attribute
          // tiers are unchanged by force, so the at-rest tiers (from phase 1) are
          // reused. The CDP path re-reads matched via `getMatchedStylesForNode`.
          const reads = await Promise.all(subjects.map(async (n) => {
            const inf = info.get(n);
            if (!inf) return null;
            // Read computed-under-force FIRST — it carries the `--czp` markers the probe
            // matched-set is rebuilt from (piggyback; zero extra round-trips).
            const scomp = await computedStyle(client, n);
            // FULL matched-under-force set (SELF ∪ RELATIONAL), engine-true. `smSelf`
            // restricts to SELF-BORNE rules — those whose forced state sits on the
            // subject's OWN last compound — so the self-state delta never gains a
            // RELATIONAL rule whose trigger isn't force-active (an out-of-subtree /
            // relevance-ineligible trigger). Same on both paths (both engine-truth).
            const sm = useProbeState
              ? stateMatchedAssembled(matcher!, tiersByNode, n, scomp)
              : await matchedStyles(client, n);
            const smSelf = useProbeState && sm ? filterSelfBorne(sm, forced) : sm;
            return { n, inf, sm, smSelf, scomp };
          }));
          for (const r of reads) {
            if (!r) continue;
            const { n, inf, sm, smSelf, scomp } = r;
            const tagDef = cache.base.get(tagDefaultsKey(inf.tag, inf.node));
            // Reference for the delta: `inf.reference` — the same-matcher at-rest resolve
            // (probe or CDP), so the forced read and the reference share ONE representation
            // (no phantom longhand deltas). The mixed probe/CDP representation split is gone
            // (useProbeState === useProbe now — the under-force read matches phase-1's matcher).
            const ref = inf.reference;
            // Relational delta (keyed on the trigger): the FULL matched set.
            const relResolved = resolveElementStyles(inf.tag, sm, scomp, tagDef, false, false, true);
            const relDelta = diffResolved(ref, relResolved);
            if (buildStyleString(relDelta)) deltaByNode.set(n, relDelta);
            // Self-state delta (keyed on `#id:state`): SELF-BORNE rules only.
            // Identical object when not probe-filtered — avoid a redundant resolve.
            const selfDelta = smSelf === sm ? relDelta : diffResolved(ref, resolveElementStyles(inf.tag, smSelf, scomp, tagDef, false, false, true));
            if (buildStyleString(selfDelta)) selfDeltaByNode.set(n, selfDelta);

            // Pseudo-element state deltas: re-resolve each replicable pseudo under
            // the force, diff vs its base pseudo map. Captured for every subject —
            // self subjects (`.el:hover::after`, from `smSelf`) and relational
            // subjects (`.foo:hover .bar::before`, from `sm`); attribution below.
            if (doPseudos && sm?.pseudoElements?.length) {
              if (!cache.pseudo.has(inf.tag)) cache.pseudo.set(inf.tag, await getPseudoDefaults(page, inf.tag, [...REPLICABLE_PSEUDOS]));
              const peDef = cache.pseudo.get(inf.tag)!;
              const peDeltasFor = (ms: MatchedStyles): Map<string, DeclMap> => {
                const out = new Map<string, DeclMap>();
                for (const pe of ms.pseudoElements || []) {
                  if (!REPLICABLE_PSEUDOS.has(pe.pseudoType)) continue;
                  const forcedMap = resolvePseudoElement(pe.pseudoType, pe.matches, scomp, peDef.get(pe.pseudoType));
                  const baseP = (inf.pseudos.get(pe.pseudoType)?.base ?? new Map()) as Map<string, ResolvedDecl>;
                  const pdelta = diffResolved(baseP, (forcedMap ?? new Map()) as Map<string, ResolvedDecl>);
                  if (buildStyleString(pdelta)) out.set(pe.pseudoType, pdelta);
                }
                return out;
              };
              const peDeltas = peDeltasFor(sm);
              if (peDeltas.size) pseudoStateByNode.set(n, peDeltas);
              const selfPe = smSelf === sm ? peDeltas : peDeltasFor(smSelf as MatchedStyles);
              if (selfPe.size) selfPseudoStateByNode.set(n, selfPe);
            }
          }
        } finally {
          await Promise.all(triggers.map((n) => client.send('CSS.forcePseudoState', { nodeId: n, forcedPseudoClasses: [] }).catch(() => {})));
        }

        // Self states (`.btn:hover`): key the SELF-BORNE delta on the subject's
        // own state (never a relational rule whose trigger isn't force-active), and
        // only for a subject that was actually FORCED (eligibility gate above).
        for (const n of selfNodeSet) {
          if (!forcedSet.has(n)) continue;
          const delta = selfDeltaByNode.get(n);
          const inf = info.get(n);
          if (!delta || !inf) continue;
          inf.id = inf.id || await ensureId(n, inf.node);
          inf.selfStates.set(state, delta);
        }

        // Self pseudo-element states (`.el:hover::after`): attach each to the
        // host's PseudoModel.states (creating a base-less entry if the pseudo
        // only exists under the state). Relational subjects are handled below.
        for (const [n, peDeltas] of selfPseudoStateByNode) {
          if (!selfNodeSet.has(n) || !forcedSet.has(n)) continue;
          const inf = info.get(n);
          if (!inf) continue;
          inf.id = inf.id || await ensureId(n, inf.node);
          for (const [pe, pdelta] of peDeltas) {
            let pm = inf.pseudos.get(pe);
            if (!pm) { pm = { base: null, states: new Map() }; inf.pseudos.set(pe, pm); }
            pm.states.set(state, pdelta);
          }
        }

        // Relational states (`.foo:hover .bar`, `.a:hover + .b`): pair each subject
        // with its concrete trigger element and record the delta keyed on the
        // TRIGGER, so the effect fires when the trigger — not the subject — enters
        // the state. Dedup on (trigger id, state, combinator, subject id).
        for (const rel of ps.relEntries) {
          const trigSet = new Set((await queryAll(new Set([rel.triggerSel]))).filter((n) => triggerRelevant(n, state)));
          if (!trigSet.size) continue;
          for (const sn of await queryAll(new Set([rel.subjectSel]))) {
            const sInf = info.get(sn);
            if (!sInf) continue;
            const delta = deltaByNode.get(sn);           // element-level delta (may be absent)
            const peDeltas = pseudoStateByNode.get(sn);  // pseudo deltas (`…::before`)
            if (!delta && !peDeltas) continue;
            for (const tn of pairTriggers(sn, trigSet, rel.combinator)) {
              const tInf = info.get(tn);
              if (!tInf) continue;
              sInf.id = sInf.id || await ensureId(sn, sInf.node);
              tInf.id = tInf.id || await ensureId(tn, tInf.node);
              // Element-level relational (`.foo:hover .bar{…}`).
              if (delta) {
                const key = `${tInf.id}|${state}||${rel.combinator}|${sInf.id}`;
                if (!emittedRel.has(key)) {
                  emittedRel.add(key);
                  sInf.relational.push({ triggerNodeId: tn, state, combinator: rel.combinator, delta });
                }
              }
              // Pseudo-element relational (`.foo:hover .bar::before{…}`).
              if (peDeltas) {
                for (const [pe, pdelta] of peDeltas) {
                  const key = `${tInf.id}|${state}|${pe}|${rel.combinator}|${sInf.id}`;
                  if (emittedRel.has(key)) continue;
                  emittedRel.add(key);
                  sInf.relational.push({ triggerNodeId: tn, state, combinator: rel.combinator, pseudo: pe, delta: pdelta });
                }
              }
            }
          }
        }
      }
    }

    // Tree root: the subtree element itself in subtree mode, else <html>.
    const tree = buildDocTree ? await buildTree(treeRootEl, info, client, evalCtx, subtreeNode ? rootSel : undefined) : undefined;
    return { elements: elements.map((e) => info.get(e.nodeId)!).filter(Boolean), byNode: info, states, tree, rootFontSize };
  } finally {
    // Remove the same-process locator stamp before detaching (best-effort — the
    // frame may already be gone). `client.detach` always runs.
    if (frameStamp) await frame!.evaluate((a) => document.documentElement.removeAttribute(a), frameStamp).catch(() => {});
    await client.detach().catch(() => {});
    // The probe matcher's session (held open through phase-4 for the under-force marker
    // re-read). The sheet outlives the session, so it is emptied first.
    await matcher?.dispose();
    if (matcherClient) await matcherClient.detach().catch(() => {});
  }
}

// ── Public entry points + serialisers (both driven by the shared model) ───────

/**
 * Rewrite the whole loaded document into a self-contained form: every element
 * that carries resolved styles gets a stable id and one `<style>` of
 * `#id{…}` / `#id:hover{…}` / `#id::before{…}` / `#id:hover::after{…}` /
 * `#trig:hover #subj{…}` rules reproduces the render. All original stylesheets,
 * inline styles and scripts are stripped. Inheritance flows through the rules.
 * (See ARCHITECTURE.md §4 for the pipeline — `buildReworkModel` is that walk.)
 */
export async function reworkHtml(page: ExtractionPage, opts: ReworkHtmlOptions = {}): Promise<string> {
  const states = opts.states ?? DEFAULT_STATES;
  const doPseudos = opts.pseudoElements !== false;
  const model = await buildReworkModel(page, states, doPseudos, false, undefined, undefined, opts.matcher ?? matcherMode());
  // Single serialisation path: model → StyleJson → rules (the SAME emitter
  // `jsonToHtml` uses), so the two entry points can never drift.
  const rules = styleJsonToRules(modelToStyleJson(model));
  const fontsCss = opts.embedFonts !== false ? await collectFontFaceCss(page) : '';
  const widgetCss = await collectWidgetPseudoCss(page);
  const styleText = [fontsCss, ...rules, widgetCss].filter(Boolean).join('\n');
  return page.evaluate((css) => {
    // KEEP IN SYNC with buildTreeNode's strip (the CDP-snapshot path): both must
    // drop exactly {script, style, link[rel~=stylesheet], inline style attr}. A
    // divergence on a NON-rendering tag is invisible to the pixel-diff harness.
    for (const n of Array.from(document.querySelectorAll('script'))) n.remove();
    for (const n of Array.from(document.querySelectorAll('style, link'))) {
      const rel = (n.getAttribute('rel') || '').toLowerCase();
      if (n.tagName === 'STYLE' || rel.split(/\s+/).includes('stylesheet')) n.remove();
    }
    for (const n of Array.from(document.querySelectorAll('[style]'))) n.removeAttribute('style');
    const s = document.createElement('style');
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
    return `<!doctype html>\n${document.documentElement.outerHTML}`;
  }, styleText);
}

/**
 * Extract the whole document as a single SELF-CONTAINED object — `jsonToHtml`
 * rebuilds a fully-styled offline HTML document from it alone:
 *  - `tree`     — the document structure (`<html>` down), with `<script>`/`<style>`/
 *                 `<link rel=stylesheet>`/inline `style` stripped exactly as
 *                 `reworkHtml` strips them; element ids are the model-assigned ids.
 *  - `fonts`    — the page's reachable `@font-face` / `@import` CSS.
 *  - `elements` — per-id resolved styles (`StyleJson`).
 * Shares `buildReworkModel` with `reworkHtml`, so the resolve/de-noise/state
 * logic is identical; only the serialisation differs.
 */
export async function reworkStyles(
  page: ExtractionPage,
  opts: ReworkStylesOptions = {},
): Promise<SelfContainedStyles> {
  const states = opts.states ?? DEFAULT_STATES;
  const doPseudos = opts.pseudoElements !== false;
  const model = await buildReworkModel(page, states, doPseudos, /*buildDocTree*/ true, opts.root, opts.frame, opts.matcher ?? matcherMode());
  const elements = modelToStyleJson(model);
  const fonts = opts.embedFonts !== false ? await collectFontFaceCss(opts.frame ?? page) : '';
  const out: SelfContainedStyles = { tree: model.tree!, fonts, elements };
  const widgetCss = await collectWidgetPseudoCss(opts.frame ?? page);
  if (widgetCss) out.widgetCss = widgetCss;
  // Subtree mode only: carry the document root font-size so `jsonToHtml` can
  // anchor `rem` under a synthetic `<html>`. Absent in whole-doc mode (schema
  // unchanged for existing consumers).
  if (model.rootFontSize !== undefined) out.rootContext = { fontSize: model.rootFontSize };
  return out;
}

// ── Shared Decls → rule serialiser (used by BOTH reworkHtml and jsonToHtml) ────

/** A JSON `Decls` map → `prop:value;…`, unfolding `"v !important"` → `v!important`
 * (byte-identical to `buildStyleString`; empty values are already dropped upstream). */
function declsToDeclString(decls: Decls): string {
  const parts: string[] = [];
  // An EXTRACTED bucket already carries its keys in cascade order (declsFromMap),
  // where this re-order is a no-op: it only moves a shorthand that sits after a
  // longhand it covers, and such a longhand is either gone (Pass 6/6b) or equal to
  // the value the shorthand would give (the Pass 6 guard), so the move is
  // render-neutral. It stays for buckets with NO cascade provenance — the ones
  // `applyBucket`/`applyDiff` assemble, where a patch appends a key to the tail
  // (a `background` landing after the `background-color` that beats it).
  for (const k of orderPropsShorthandFirst(Object.entries(decls))) {
    const val = String(decls[k]);
    parts.push(val.endsWith(' !important') ? `${k}:${val.slice(0, -' !important'.length)}!important` : `${k}:${val}`);
  }
  return parts.join(';');
}

/**
 * The one place a `StyleJson` becomes CSS rules — `#id{…}`, `#id::pe{…}`,
 * `#id:state::pe{…}`, `#id:state{…}` and `#trigger:state <comb> #id[::pe]{…}`.
 * `reworkHtml` (via `modelToStyleJson`) and `jsonToHtml` (from `json.elements`)
 * both call this, so the emitted rule set can never diverge between them.
 */
function styleJsonToRules(styles: StyleJson): string[] {
  const rules: string[] = [];
  for (const [id, e] of Object.entries(styles)) {
    if (e.base) { const s = declsToDeclString(e.base); if (s) rules.push(`${idSelector(id)}{${s}}`); }
    for (const [pe, pm] of Object.entries(e.pseudos || {})) {
      if (pm.base) { const s = declsToDeclString(pm.base); if (s) rules.push(`${idSelector(id)}::${pe}{${s}}`); }
      // Pseudo-CLASS before pseudo-ELEMENT: `#id:hover::after{…}`.
      for (const [st, dd] of Object.entries(pm.states || {})) { const s = declsToDeclString(dd); if (s) rules.push(`${idSelector(id)}:${st}::${pe}{${s}}`); }
    }
    for (const [st, d] of Object.entries(e.states || {})) { const s = declsToDeclString(d); if (s) rules.push(`${idSelector(id)}:${st}{${s}}`); }
    for (const rel of e.relational || []) {
      const s = declsToDeclString(rel.delta);
      if (!s) continue;
      const comb = rel.combinator === ' ' ? ' ' : ` ${rel.combinator} `;
      const pe = rel.pseudo ? `::${rel.pseudo}` : '';
      rules.push(`${idSelector(rel.trigger)}:${rel.state}${comb}${idSelector(id)}${pe}{${s}}`);
    }
  }
  return rules;
}

// ── Document tree (reworkStyles) + offline reconstruction (jsonToHtml) ─────────

/** HTML void elements: serialised as `<tag …>` with no children / closing tag. */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// CDP `DOM.getDocument` truncates a text node's `nodeValue` at this length,
// appending an ellipsis. A visible text run longer than this (long <pre>, pasted
// prose, inline JSON) would render truncated in `jsonToHtml` while `reworkHtml`
// (via in-page `outerHTML`) keeps it whole — so we re-fetch the full value.
const CDP_TEXT_TRUNCATION = 10000;

/**
 * Build the serialisable document tree from the CDP snapshot element `rootEl`
 * (`<html>` in whole-doc mode, the subtree root element in subtree mode).
 * Mirrors `reworkHtml`'s strip: drops `<script>`,
 * `<style>`, `<link rel=stylesheet>` and the inline `style` attribute; keeps
 * everything else (head/meta/title/base/noscript). Element ids come from the model
 * (`byNode`) so a minted/deduped id is reflected and the stale snapshot id is
 * dropped. Comments and the doctype are omitted (they don't render). Text nodes
 * long enough to have been truncated by CDP are re-fetched in full (`client` must
 * be a LIVE session — snapshot nodeIds are session-scoped).
 */
async function buildTree(
  rootEl: any,
  byNode: Map<number, ElementModel>,
  client: any,
  evalCtx?: EvalContext,
  rootSel?: string,
): Promise<StyleTreeNode> {
  // CDP `DOM.getDocument` SILENTLY OMITS whitespace-only text nodes, but the
  // space between two inline(-flex) siblings is layout (a shrink-to-fit flex
  // row of `<span>a</span> <span>b</span>` loses one word-space per gap without
  // it). So text children are sourced from an in-page walk — one evaluate for
  // the whole document, full `nodeValue` (no CDP ~10 000-char truncation) —
  // aligned to the CDP element tree by preorder cursor. The CDP text children
  // remain as the fallback for a cursor desync (a DOM mutating mid-extraction).
  let sigs: (string | 0)[][] | null = null;
  if (evalCtx) {
    sigs = await evalCtx.evaluate((sel) => {
      const start = sel ? document.querySelector(sel) : document.documentElement;
      if (!start) return null;
      const out: (string | 0)[][] = [];
      const walk = (el: Element) => {
        const sig: (string | 0)[] = [];
        for (const c of Array.from(el.childNodes)) {
          if (c.nodeType === 3) sig.push((c as Text).nodeValue ?? '');
          else if (c.nodeType === 1) sig.push(0);
        }
        out.push(sig);
        for (const c of Array.from(el.children)) walk(c);
      };
      walk(start);
      return out;
    }, rootSel ?? null).catch(() => null);
  }
  const repairs: { node: StyleTreeNode; nodeId: number }[] = [];
  const cursor = sigs ? { sigs, i: 0 } : null;
  const tree = (rootEl && buildTreeNode(rootEl, byNode, repairs, cursor)) || { tag: 'html' };
  if (repairs.length) {
    await Promise.all(repairs.map(async ({ node, nodeId }) => {
      const full = await fullTextValue(client, nodeId);
      if (full != null) node.text = full;
    }));
  }
  return tree;
}

function buildTreeNode(
  node: any,
  byNode: Map<number, ElementModel>,
  repairs: { node: StyleTreeNode; nodeId: number }[],
  cursor: { sigs: (string | 0)[][]; i: number } | null,
): StyleTreeNode | undefined {
  if (node.nodeType === 3) {
    const t = node.nodeValue ?? '';
    if (t === '') return undefined;              // keep whitespace-only (inline spacing)
    const tn: StyleTreeNode = { text: t };
    if (t.length >= CDP_TEXT_TRUNCATION && node.nodeId) repairs.push({ node: tn, nodeId: node.nodeId });
    return tn;
  }
  if (node.nodeType !== 1) return undefined;     // comment(8) / doctype(10) / … dropped
  const tag = (node.localName || node.nodeName || '').toLowerCase();
  // The in-page signature cursor advances for EVERY element (preorder), even one
  // whose output is dropped below — the walks must stay in lockstep.
  const sig = cursor ? cursor.sigs[cursor.i++] : undefined;

  const out: StyleTreeNode = { tag };
  const inf = byNode.get(node.nodeId);
  const id = inf ? (inf.id ?? undefined) : getAttr(node, 'id');
  if (id) out.id = id;

  const attrs: Record<string, string> = {};
  const a: string[] = node.attributes || [];
  for (let i = 0; i < a.length; i += 2) {
    if (a[i] === 'id' || a[i] === 'style') continue;
    attrs[a[i]] = a[i + 1];
  }
  if (Object.keys(attrs).length) out.attrs = attrs;

  if (inf?.rect) out.rect = inf.rect;
  if (inf?.computed) out.computed = inf.computed;

  if (!VOID_ELEMENTS.has(tag)) {
    const cdpKids: any[] = node.children || [];
    const elKids = cdpKids.filter((c) => c.nodeType === 1);
    const children: StyleTreeNode[] = [];
    // Signature usable only when its element-slot count matches CDP's view.
    // A mismatch means the DOM drifted mid-extraction and the flat preorder
    // alignment is broken for everything after — kill the cursor for the REST
    // of the walk (all subsequent nodes fall back to the CDP children).
    if (sig && cursor && sig.filter((s) => s === 0).length !== elKids.length) cursor.sigs = [];
    if (sig && cursor && cursor.sigs.length) {
      let e = 0;
      for (const s of sig) {
        if (s === 0) {
          const cn = buildTreeNode(elKids[e++], byNode, repairs, cursor);
          if (cn) children.push(cn);
        } else if (s !== '') {
          children.push({ text: s });
        }
      }
    } else {
      for (const c of cdpKids) { const cn = buildTreeNode(c, byNode, repairs, cursor); if (cn) children.push(cn); }
    }
    if (children.length) out.children = children;
  }

  // KEEP IN SYNC with reworkHtml's in-page strip (in `reworkHtml`): same set
  // {script, style, link[rel~=stylesheet], inline style attr (skipped above)}.
  // Dropped AFTER the recursion so the signature cursor consumed the subtree.
  if (tag === 'script' || tag === 'style') return undefined;
  if (tag === 'link' && (getAttr(node, 'rel') || '').toLowerCase().split(/\s+/).includes('stylesheet')) return undefined;
  return out;
}

/** Full (untruncated) `nodeValue` of a text node, via a live CDP session. */
async function fullTextValue(client: any, nodeId: number): Promise<string | null> {
  try {
    const { object } = (await client.send('DOM.resolveNode', { nodeId })) as any;
    if (!object?.objectId) return null;
    const { result } = (await client.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      returnByValue: true,
      functionDeclaration: 'function () { return this.nodeValue; }',
    })) as any;
    await client.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
    return typeof result?.value === 'string' ? result.value : null;
  } catch {
    return null;
  }
}

const escapeText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/**
 * Rebuild a fully-styled, self-contained offline HTML document from a
 * `reworkStyles` result — no browser needed. The generated `<style>` (fonts +
 * the `styleJsonToRules` rule set) is injected as `<head>`'s last child, exactly
 * as `reworkHtml` appends its single generated `<style>` to `<head>`.
 */
export function jsonToHtml(json: SelfContainedStyles): string {
  const rules = styleJsonToRules(json.elements);
  if (json.rootContext) {
    // Subtree mode: re-host the subtree under a synthetic <html><body>. The
    // synthetic <html> carries the document's root font-size so `rem` below the
    // cut resolves against the original anchor (not the UA 16px). `em` is already
    // correct — the subtree root's own font-size was materialised into its rules.
    // Fonts stay FIRST (an `@import` must precede every other rule, incl. html{}).
    const rootRule = `html{font-size:${json.rootContext.fontSize}}`;
    const styleText = [json.fonts, rootRule, ...rules, json.widgetCss].filter(Boolean).join('\n');
    const body = serializeNode(json.tree, '');   // no <head> in the subtree → no injection
    return `<!doctype html>\n<html><head><style>${styleText}</style></head><body>${body}</body></html>`;
  }
  const styleText = [json.fonts, ...rules, json.widgetCss].filter(Boolean).join('\n');
  return `<!doctype html>\n${serializeNode(json.tree, styleText)}`;
}

function serializeNode(node: StyleTreeNode, styleText: string): string {
  if (node.text !== undefined) return escapeText(node.text);
  const tag = node.tag || 'div';
  let attrs = '';
  if (node.id) attrs += ` id="${escapeAttr(node.id)}"`;
  if (node.attrs) for (const [k, v] of Object.entries(node.attrs)) attrs += ` ${k}="${escapeAttr(v)}"`;
  if (VOID_ELEMENTS.has(tag)) return `<${tag}${attrs}>`;
  let inner = '';
  for (const c of node.children || []) inner += serializeNode(c, styleText);
  // Inject the generated <style> as head's last child (raw CSS — not escaped).
  if (tag === 'head' && styleText) inner += `<style>${styleText}</style>`;
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

/** The computed value of every key that survived denoise, in the bucket's own key
 *  order. Empty (undefined) when nothing resolved — a node with no own rule.
 *
 *  `isTreeRoot` additionally carries the INHERITABLE set, so a reader walking up
 *  for an effective value always terminates (§ StyleTreeNode meta). In subtree mode
 *  the root already materialises that set into its `base`, so this only adds keys
 *  in whole-document mode. */
function computedFor(base: DeclMap, computed: Map<string, string>, isTreeRoot = false): Decls | undefined {
  const out: Decls = {};
  for (const [k] of cascadeOrdered(base)) {
    const v = computed.get(k);
    if (v) out[k] = v;
  }
  if (isTreeRoot) {
    for (const k of INHERITABLE) {
      if (out[k] !== undefined) continue;
      const v = computed.get(k);
      if (v) out[k] = v;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** DeclMap → JSON Decls, folding `!important` into the value (`"red !important"`).
 *  Keys are laid out in CASCADE order (`cascadeOrdered`), which is what makes the
 *  key order of a `StyleJson` bucket meaningful: the flat rule it serialises to
 *  renders correctly on its own, with no re-ordering needed downstream. */
function declsFromMap(m: DeclMap): Decls {
  const o: Decls = {};
  for (const [k, d] of cascadeOrdered(m)) {
    const v = d.value.trim();
    if (!v) continue;
    o[k] = d.important ? `${v} !important` : v;
  }
  return o;
}
const nonEmpty = (d: Decls): Decls | undefined => (Object.keys(d).length ? d : undefined);

/** Serialise the model to the `StyleJson` map (empty keys omitted). */
function modelToStyleJson(model: ReworkModel): StyleJson {
  const out: StyleJson = {};
  for (const e of model.elements) {
    if (!e.id) continue;
    const entry: StyleEntry = {};

    const base = nonEmpty(declsFromMap(e.base));
    if (base) entry.base = base;

    const states: Record<string, Decls> = {};
    for (const [st, dm] of e.selfStates) { const d = nonEmpty(declsFromMap(dm)); if (d) states[st] = d; }
    if (Object.keys(states).length) entry.states = states;

    const pseudos: Record<string, { base?: Decls; states?: Record<string, Decls> }> = {};
    for (const [pe, pm] of e.pseudos) {
      const peEntry: { base?: Decls; states?: Record<string, Decls> } = {};
      if (pm.base) { const pb = nonEmpty(declsFromMap(pm.base)); if (pb) peEntry.base = pb; }
      const pstates: Record<string, Decls> = {};
      for (const [st, dm] of pm.states) { const d = nonEmpty(declsFromMap(dm)); if (d) pstates[st] = d; }
      if (Object.keys(pstates).length) peEntry.states = pstates;
      if (peEntry.base || peEntry.states) pseudos[pe] = peEntry;
    }
    if (Object.keys(pseudos).length) entry.pseudos = pseudos;

    const relational: StyleEntry['relational'] = [];
    for (const r of e.relational) {
      const tId = model.byNode.get(r.triggerNodeId)?.id;
      const d = nonEmpty(declsFromMap(r.delta));
      if (!tId || !d) continue;
      relational.push({ trigger: tId, state: r.state, combinator: r.combinator, ...(r.pseudo ? { pseudo: r.pseudo } : {}), delta: d });
    }
    if (relational.length) entry.relational = relational;

    if (entry.base || entry.states || entry.pseudos || entry.relational) out[e.id] = entry;
  }
  return out;
}

/**
 * One in-page pass: getComputedStyle for every element (document order),
 * returning the requested props + custom props. When `rootSel` is given the walk
 * starts at that element (subtree mode) instead of `documentElement`, staying in
 * lockstep with `collectReworkElements` (same start node, same skip set).
 */
async function snapshotComputed(page: EvalContext, props: string[], vars: string[], skipTags: string[], rootSel?: string): Promise<ComputedSnapshot[]> {
  return page.evaluate(({ props, vars, skipTags, rootSel }) => {
    const skip = new Set(skipTags);
    const out: { style: Record<string, string>; rect: { x: number; y: number; w: number; h: number } }[] = [];
    const start = rootSel ? document.querySelector(rootSel) : document.documentElement;
    // Geometry is stored relative to the EXTRACTION ROOT, not the viewport: two
    // independently captured sides live on different pages, so absolute
    // coordinates are not comparable between them. Rounded — the sub-pixel tail is
    // noise in the JSON and in every rendering of it.
    //
    // Subtracting one viewport rect from another cancels the page scroll for
    // NORMAL FLOW only. A `fixed`/`sticky` node, or one inside a scrolled
    // container, keeps a scroll-dependent offset — its rect says where it was at
    // capture, which is the honest answer for a node whose position IS the scroll
    // state. `getBoundingClientRect` is also the post-transform AABB, so a rotated
    // element reports a bigger box than its layout size (and can land outside the
    // root's own box, i.e. negative).
    const origin = start ? start.getBoundingClientRect() : { left: 0, top: 0 };
    const walk = (el: Element) => {
      if (!skip.has(el.tagName)) {
        const cs = getComputedStyle(el);
        const m: Record<string, string> = {};
        for (const p of props) { const v = cs.getPropertyValue(p); if (v) m[p] = v; }
        for (const v of vars) { const val = cs.getPropertyValue(v); if (val) m[v] = val; }
        const r = el.getBoundingClientRect();
        out.push({
          style: m,
          rect: {
            x: Math.round(r.left - origin.left), y: Math.round(r.top - origin.top),
            w: Math.round(r.width), h: Math.round(r.height),
          },
        });
      }
      for (const c of Array.from(el.children)) walk(c);
    };
    if (start) walk(start);
    return out;
  }, { props, vars, skipTags, rootSel: rootSel ?? null });
}

/**
 * tsx/esbuild rewrites named functions inside `page.evaluate` callbacks to
 * `__name(fn, "name")` (keepNames) — but `__name` doesn't exist in the page, so
 * the callback throws `__name is not defined`. Define it as identity once, up
 * front, so the library works when run through tsx/ts-node (not just a bundler).
 * Passed as a string so esbuild leaves it alone.
 */
async function installEvalShim(page: EvalContext): Promise<void> {
  await page
    .evaluate('globalThis.__name = globalThis.__name || function (t) { return t; }; undefined;')
    .catch(() => {});
}

async function matchedStyles(client: any, nodeId: number): Promise<MatchedStyles | null> {
  try {
    return (await client.send('CSS.getMatchedStylesForNode', { nodeId })) as MatchedStyles;
  } catch {
    return null; // node may have gone away
  }
}

/**
 * The node's inline (`style` attr) + presentational-attribute style tiers, from
 * `CSS.getInlineStylesForNode`. The probe matcher supplies only the author
 * `matchedCSSRules` (+ `pseudoElements`), leaving these two tiers unset by design
 * — the caller assembles them here. This is browser-native (the SAME
 * `presentationAttributeStyle` backend `getMatchedStylesForNode` uses for these
 * fields, so byte-identical) and cheap: ~0.1ms/node — it does NO ancestor
 * re-match (the cost that makes `getMatchedStylesForNode` the bottleneck), so
 * calling it per node is negligible even at ~1200 nodes.
 */
async function inlineAndAttrs(client: any, nodeId: number): Promise<{ inlineStyle?: CssStyle; attributesStyle?: CssStyle }> {
  try {
    const r = (await client.send('CSS.getInlineStylesForNode', { nodeId })) as any;
    return { inlineStyle: r.inlineStyle, attributesStyle: r.attributesStyle };
  } catch {
    return {}; // node may have gone away
  }
}

// Rebuild a subject's under-force author match set from the ENGINE-TRUTH `--czp` markers
// carried in its under-force computed read (`scomp`), plus the at-rest inline/attribute
// tiers (force doesn't change those). `matchedFromComputed` extracts the lit markers and
// cascade-orders them exactly like the at-rest read.
function stateMatchedAssembled(
  matcher: ProbeMatcher,
  tiersByNode: Map<number, { inlineStyle?: CssStyle; attributesStyle?: CssStyle }>,
  nodeId: number,
  computed: Map<string, string>,
): MatchedStyles {
  const pm = matcher.matchedFromComputed(computed.keys());
  const tiers = tiersByNode.get(nodeId) || {};
  return {
    matchedCSSRules: pm.matchedCSSRules,
    pseudoElements: pm.pseudoElements,
    inlineStyle: tiers.inlineStyle,
    attributesStyle: tiers.attributesStyle,
  };
}

async function computedStyle(client: any, nodeId: number): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const cr = (await client.send('CSS.getComputedStyleForNode', { nodeId })) as any;
    for (const p of cr.computedStyle || []) map.set(p.name, p.value);
  } catch { /* node may have gone away */ }
  return map;
}

/** Computed style of a pseudo-element CDP doesn't surface (::placeholder/::marker), via getComputedStyle. */
async function computedPseudo(client: any, nodeId: number, pseudo: string): Promise<Map<string, string>> {
  try {
    const { object } = (await client.send('DOM.resolveNode', { nodeId })) as any;
    if (!object?.objectId) return new Map();
    const { result } = (await client.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      returnByValue: true,
      functionDeclaration:
        'function (pe, props) { const cs = getComputedStyle(this, "::" + pe); const o = {}; for (const p of props) o[p] = cs.getPropertyValue(p); return o; }',
      arguments: [{ value: pseudo }, { value: COMPUTED_PSEUDO_PROPS }],
    })) as any;
    await client.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
    return new Map(Object.entries((result?.value || {}) as Record<string, string>));
  } catch {
    return new Map();
  }
}

// ── browser-side helpers (run via page.evaluate) ─────────────────────────────

/**
 * Tags whose UA styling changes under the `disabled` attribute (form controls).
 * A disabled control's tag defaults must be measured on a DISABLED probe —
 * measuring an enabled bare tag makes an authored `background:white` on a
 * disabled textarea read as "== the tag default" and get dropped, letting the
 * UA disabled grey show through (context-dependent default, ARCHITECTURE §6).
 */
const DISABLEABLE_TAGS = new Set(['input', 'textarea', 'select', 'button', 'optgroup', 'option', 'fieldset']);
/** Cache key + probe attributes for a tag's UA defaults. An `<input>`'s UA
 *  style depends on its `type` (a checkbox has `margin:3px 3px 3px 4px`, a
 *  text input none), and a disabled control is painted differently — both must
 *  be measured on a matching probe, else an author reset that merely equals
 *  the WRONG variant's default gets dropped. */
function tagDefaultsSpec(tag: string, node: any): { key: string; type: string; disabled: boolean } {
  const disabled = DISABLEABLE_TAGS.has(tag) && getAttr(node, 'disabled') !== undefined;
  const type = tag === 'input' ? (getAttr(node, 'type') || '').toLowerCase() : '';
  return { key: tag + (type ? `|type=${type}` : '') + (disabled ? '|disabled' : ''), type, disabled };
}
function tagDefaultsKey(tag: string, node: any): string {
  return tagDefaultsSpec(tag, node).key;
}

/**
 * Does the subtree root's INHERITED line-height carry a unitless FACTOR?
 *
 * `getComputedStyle` reports line-height as USED px, so materialising it onto
 * the subtree root freezes it for every descendant — a descendant whose
 * font-size differs then inherits the wrong value (ARCHITECTURE §4.6).
 * The factor is unrecoverable from computed values alone (`1.5` at 16px and a
 * literal `24px` both read `24px`), so this probes BEHAVIOUR: a hidden child
 * with a huge explicit font-size inherits the root's line-height — if it
 * scaled, the inherited value is a factor (returned, 7 significant digits: a
 * float32 round-trip lands on the browser's own arithmetic); if it stayed,
 * it is a length (null → the frozen px materialisation is correct). The probe
 * tag is unstylable-by-page-CSS in practice; a `*` rule that did hit it would
 * also re-declare line-height on every real descendant, making the root
 * materialisation moot anyway. display:none — computed line-height resolves
 * without layout, so nothing flickers.
 */
async function probeLineHeightFactor(evalCtx: EvalContext, rootSel: string): Promise<string | null> {
  return evalCtx.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const rcs = getComputedStyle(el);
    const plh = rcs.lineHeight;
    if (!plh.endsWith('px')) return null;          // normal / keyword — inherits fine as-is
    const pfs = parseFloat(rcs.fontSize);
    const probe = document.createElement('css-snapshot-lh-probe');
    probe.style.cssText = 'font-size:6400px;display:none';
    el.appendChild(probe);
    try {
      const pcs = getComputedStyle(probe);
      const fsN = parseFloat(pcs.fontSize);
      const lhRaw = pcs.lineHeight;
      if (!lhRaw.endsWith('px')) return null;
      const lhN = parseFloat(lhRaw);
      const plhN = parseFloat(plh);
      if (!(fsN > pfs + 1)) return null;           // font-size didn't take — can't discriminate
      if (Math.abs(lhN - plhN) < 0.05) return null; // did not scale — a real length
      const factor = lhN / fsN;
      // Cross-check against the root's own ratio: both must be the same factor.
      if (Math.abs(factor - plhN / pfs) > 0.05) return null;
      return String(Number(factor.toPrecision(7)));
    } finally {
      probe.remove();
    }
  }, rootSel);
}

/** Computed browser-default style map for a single tag (ported getTagDefaults, base-only). */
async function getTagDefaults(page: ExtractionPage, tag: string, disabled = false, type = ''): Promise<Map<string, string> | undefined> {
  const entries = await page.evaluate(({ tagName, disabled, type }) => {
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;border:0;visibility:hidden;pointer-events:none';
    iframe.setAttribute('aria-hidden', 'true');
    document.documentElement.appendChild(iframe);
    try {
      const idoc = iframe.contentDocument!;
      const iwin = iframe.contentWindow!;
      let el: Element;
      try { el = idoc.createElement(tagName); }
      catch { return null; }
      if (disabled) el.setAttribute('disabled', '');
      if (type) el.setAttribute('type', type);
      idoc.body.appendChild(el);
      const cs = iwin.getComputedStyle(el);
      const out: [string, string][] = [];
      for (let i = 0; i < cs.length; i++) {
        const name = cs[i]!;
        out.push([name, cs.getPropertyValue(name)]);
      }
      return out;
    } finally {
      iframe.remove();
    }
  }, { tagName: tag, disabled, type });
  return entries ? new Map(entries) : undefined;
}

/** Computed browser-default style maps for a tag's pseudo-elements (`::before`, …). */
async function getPseudoDefaults(
  page: ExtractionPage,
  tag: string,
  pseudoTypes: string[],
): Promise<Map<string, Map<string, string>>> {
  const entries = await page.evaluate(({ tagName, types }) => {
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;border:0;visibility:hidden;pointer-events:none';
    iframe.setAttribute('aria-hidden', 'true');
    document.documentElement.appendChild(iframe);
    try {
      const idoc = iframe.contentDocument!;
      const iwin = iframe.contentWindow!;
      let el: Element;
      try { el = idoc.createElement(tagName); }
      catch { return null; }
      idoc.body.appendChild(el);
      const out: [string, [string, string][]][] = [];
      for (const pe of types) {
        const cs = iwin.getComputedStyle(el, '::' + pe);
        const props: [string, string][] = [];
        for (let i = 0; i < cs.length; i++) {
          const name = cs[i]!;
          props.push([name, cs.getPropertyValue(name)]);
        }
        out.push([pe, props]);
      }
      return out;
    } finally {
      iframe.remove();
    }
  }, { tagName: tag, types: pseudoTypes });
  const map = new Map<string, Map<string, string>>();
  if (entries) for (const [pe, props] of entries) map.set(pe, new Map(props));
  return map;
}

/**
 * Collect author rules styling NATIVE-WIDGET internals — selectors with a
 * `::-webkit-*` pseudo-element (`::-webkit-datetime-edit*`, `::-webkit-scrollbar*`,
 * `::-webkit-slider-*`, spin buttons, …). Those parts live in the UA shadow tree:
 * the per-element pipeline can neither match nor re-emit them (`getComputedStyle`
 * doesn't resolve them), yet they move layout — Tailwind's preflight strips the
 * UA `padding-block` off datetime fields, so losing it makes a `type=time` input
 * 2px taller. Passed through VERBATIM (cssText, with the @media/@supports stack),
 * relying on class/attr selectors surviving in the emitted tree. Excluded:
 * `::-webkit-input-placeholder` (replicated per element as `::placeholder`).
 * Accepted residual: a selector keyed on an id that got re-minted goes stale.
 */
async function collectWidgetPseudoCss(page: EvalContext): Promise<string> {
  return page.evaluate(() => {
    const out: string[] = [];
    const WIDGET_RE = /::-webkit-(?!input-placeholder)[a-z-]+/;
    const walk = (rules: CSSRuleList | undefined, wrap: (s: string) => string) => {
      if (!rules) return;
      for (let i = 0; i < rules.length; i++) {
        const rule = rules[i] as CSSRule & { cssRules?: CSSRuleList; selectorText?: string; conditionText?: string };
        if (rule.type === CSSRule.STYLE_RULE) {
          if (rule.selectorText && WIDGET_RE.test(rule.selectorText)) out.push(wrap(rule.cssText));
        } else if (rule.type === CSSRule.MEDIA_RULE || rule.type === CSSRule.SUPPORTS_RULE) {
          const cond = rule.type === CSSRule.MEDIA_RULE ? `@media ${rule.conditionText}` : `@supports ${rule.conditionText}`;
          walk(rule.cssRules, (s) => wrap(`${cond}{${s}}`));
        } else if (rule.cssRules) {
          walk(rule.cssRules, wrap); // @layer / other grouping: condition-free
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try { walk(sheet.cssRules, (s) => s); } catch { /* cross-origin — skip */ }
    }
    return out.join('\n');
  });
}

/** Collect the page's reachable @font-face / @import CSS (ported collectFontFaceCss). */
async function collectFontFaceCss(page: EvalContext): Promise<string> {
  return page.evaluate(async () => {
    const imports: string[] = [];
    const sync: string[] = [];
    const fetched: Promise<string>[] = [];
    const isGoogleFonts = (href: string) => /^https?:\/\/fonts\.googleapis\.com\//.test(href);
    const googleFamilies = new Set<string>();

    const collectGoogleFamilies = (raw: string) => {
      try {
        const url = new URL(raw);
        for (const v of url.searchParams.getAll('family')) {
          const name = v.split(':')[0]?.trim();
          if (name) googleFamilies.add(name);
        }
      } catch { /* malformed URL — ignore */ }
    };

    const collectFrom = (rules: CSSRuleList | undefined): string => {
      let s = '';
      if (!rules) return s;
      for (let i = 0; i < rules.length; i++) {
        const rule = rules[i] as CSSRule & { cssRules?: CSSRuleList };
        if (rule.type === CSSRule.FONT_FACE_RULE) {
          s += rule.cssText;
        } else if (rule.type === CSSRule.IMPORT_RULE) {
          // An `@import` NESTED in a sheet's rules (e.g. a CSS-in-JS injected
          // `<style>` that `@import`s Google Fonts) — the top-level `sheet.href`
          // check never sees it, so it must be handled here. A googleapis import
          // feeds the shared family set (one consolidated `@import` is emitted);
          // any other import is recursed into for its `@font-face` rules, with the
          // same CORS fetch fallback as a top-level sheet.
          const ir = rule as unknown as CSSImportRule;
          const importedSheet = ir.styleSheet as CSSStyleSheet | null;
          const href = importedSheet?.href || ir.href || '';
          if (href && isGoogleFonts(href)) {
            collectGoogleFamilies(href);
            continue;
          }
          let importedRules: CSSRuleList | undefined;
          try { importedRules = importedSheet?.cssRules; } catch { importedRules = undefined; }
          if (importedRules) s += collectFrom(importedRules);
          else if (href) {
            fetched.push(
              fetch(href, { credentials: 'omit' })
                .then((r) => (r.ok ? r.text() : ''))
                .then((text) => (text ? reparseFromText(text) : ''))
                .catch(() => ''),
            );
          }
        } else if (rule.cssRules) {
          s += collectFrom(rule.cssRules);
        }
      }
      return s;
    };

    const reparseFromText = (css: string): string => {
      const el = document.createElement('style');
      el.textContent = css;
      document.documentElement.appendChild(el);
      try { return collectFrom(el.sheet?.cssRules); }
      finally { el.remove(); }
    };

    for (const sheet of Array.from(document.styleSheets)) {
      if (sheet.href && isGoogleFonts(sheet.href)) {
        collectGoogleFamilies(sheet.href);
        continue;
      }
      try {
        sync.push(collectFrom(sheet.cssRules));
      } catch {
        if (!sheet.href) continue;
        fetched.push(
          fetch(sheet.href, { credentials: 'omit' })
            .then((r) => (r.ok ? r.text() : ''))
            .then((text) => (text ? reparseFromText(text) : ''))
            .catch(() => ''),
        );
      }
    }

    if (googleFamilies.size > 0) {
      const parts = [...googleFamilies].map(
        (n) => `family=${encodeURIComponent(n).replace(/%20/g, '+')}:wght@100..900`,
      );
      imports.push(`@import url("https://fonts.googleapis.com/css2?${parts.join('&')}&display=swap");`);
    }

    const remote = await Promise.all(fetched);
    return [...imports, ...sync, ...remote].join('');
  });
}
