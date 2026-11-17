// resolve.ts — resolve + de-noise the CSS for ONE element.
//
// This is `walk()` from the extension with all recursion / children /
// pseudo-element / attribute code removed, and pass 9
// (drop-inherited-from-snapshot-ancestor) dropped because this element is
// always the root of the extraction.

import { colord } from 'colord';
import './colord-names.ts'; // let colord parse named colors (gold, orange, …)
import { cascadeResolve, declBeats, type ResolvedDecl } from './cascade.ts';
import { resolveVars, simplifyCalc } from './vars.ts';
import { expandShorthand, SHORTHAND_COVERAGE } from './shorthand.ts';
import { splitTopLevel, splitTopLevelComma } from './value-tokens.ts';
import type { MatchedStyles, RuleMatch } from './cdp-types.ts';


export const INHERITABLE = new Set([
  'color', 'cursor', 'direction', 'font', 'font-family', 'font-size',
  'font-style', 'font-variant', 'font-weight', 'font-stretch',
  'letter-spacing', 'line-height', 'overflow-wrap',
  'text-align', 'text-align-last', 'text-decoration',
  'text-indent', 'text-justify', 'text-shadow', 'text-transform',
  'visibility', 'white-space', 'word-break', 'word-spacing', 'word-wrap',
  'writing-mode',
  'list-style', 'list-style-image', 'list-style-position', 'list-style-type',
  'border-collapse', 'border-spacing', 'caption-side', 'empty-cells',
  'pointer-events',
  // Genuinely CSS-inherited props that were missing → a descendant's
  // reset-to-default was dropped and the ancestor's value leaked in.
  'caret-color',
  '-webkit-text-stroke', '-webkit-text-stroke-color', '-webkit-text-stroke-width',
  'image-rendering',
  // Derived from the `lang` ATTRIBUTE, which in subtree mode sits above the cut
  // (§4.6) — materialising it as CSS is what carries the locale across.
  '-webkit-locale',
  // Inherited AND visual (moved out of ALWAYS_DROP_PROPS): form-control paint,
  // dark-theme scheme, underline placement.
  'accent-color', 'color-scheme', 'text-underline-position',
]);

/** Inherited colour props whose initial value resolves to `currentColor`. */
const CURRENT_COLOR_DEFAULTED = new Set(['caret-color', '-webkit-text-stroke-color']);

const ALWAYS_DROP_PROPS = new Set([
  'transition', 'transition-property', 'transition-duration',
  'transition-timing-function', 'transition-delay', 'transition-behavior',
  'animation', 'animation-name', 'animation-duration',
  'animation-timing-function', 'animation-delay', 'animation-iteration-count',
  'animation-direction', 'animation-fill-mode', 'animation-play-state',
  'animation-composition', 'animation-range', 'animation-range-start',
  'animation-range-end', 'animation-timeline', 'view-transition-name',
  'border-image', 'border-image-source', 'border-image-slice',
  'border-image-width', 'border-image-outset', 'border-image-repeat',
  'font-feature-settings', 'font-variation-settings', 'font-kerning',
  'font-optical-sizing', 'font-synthesis', 'font-synthesis-weight',
  'font-synthesis-style', 'font-synthesis-small-caps',
  'font-synthesis-position', 'font-language-override', 'font-size-adjust',
  'text-rendering', 'text-size-adjust', '-webkit-text-size-adjust',
  'text-emphasis', 'text-emphasis-color', 'text-emphasis-position',
  'text-emphasis-style', 'text-orientation', 'text-decoration-thickness',
  'text-underline-offset', 'paint-order',
  'hanging-punctuation', 'orphans', 'widows', 'line-break', 'hyphens',
  'tab-size',
  'text-wrap-mode', 'text-wrap-style', 'white-space-collapse',
  '-webkit-font-smoothing', '-moz-osx-font-smoothing',
  '-webkit-tap-highlight-color',
  'page', 'page-break-before', 'page-break-after', 'page-break-inside',
  'break-before', 'break-after', 'break-inside',
  'scroll-behavior', 'overscroll-behavior',
  'overscroll-behavior-x', 'overscroll-behavior-y',
  'overscroll-behavior-block', 'overscroll-behavior-inline',
  '-webkit-user-select',
]);

// TRUE geometry only. PAINT props (fill/stroke/…) are deliberately NOT here:
// they only enter the resolved map when a CSS rule declares them (attribute-only
// paint never joins the cascade), and CSS-driven paint is load-bearing for icon
// systems (e.g. `.use{fill:red}` on <use>). Dropping them → black icons.
const SVG_GEOMETRY_PROPS = new Set([
  'd', 'x', 'y', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height',
]);

/**
 * Does denoise pass 1/2 drop `prop` unconditionally on an element of this kind?
 *
 * The declared drop set of the extractor, for a consumer that compares an
 * extracted render against the original: everything NOT dropped here is claimed
 * to survive, so a fidelity harness derives its exclusions from this instead of
 * re-listing them (a hand-kept copy would drift into hiding real divergence).
 */
export function extractionDropsProperty(
  prop: string,
  kind: 'none' | 'svg-root' | 'svg-inner',
): boolean {
  if (ALWAYS_DROP_PROPS.has(prop) || prop.startsWith('--')) return true;
  if (kind === 'none') return false;
  // The ROOT <svg> participates in normal (flex/grid/inline) layout: its CSS
  // width/height AND box props (margin/padding/border/background/box-sizing/
  // outline) are load-bearing (an icon's `ml-1` is a real 4px of flex row).
  // Only INNER primitives get the geometry+layout strip.
  if (kind === 'svg-root') return prop !== 'width' && prop !== 'height' && SVG_GEOMETRY_PROPS.has(prop);
  return SVG_GEOMETRY_PROPS.has(prop) || isSvgLayoutNoise(prop);
}

// Sizing properties whose bare-tag computed "default" is unreliable, so a
// declared value that happens to equal it is still load-bearing:
//   • width/height — a bare (empty) element computes height:0 / a block width,
//     but the real element has content, so `height:0` (a collapsed accordion:
//     `overflow:hidden;height:0`) reads as "== default 0px" yet is NOT droppable.
//   • min-* — initial `auto` reports as computed 0px on a block, but in a
//     flex/grid item `auto` means min-content, so `min-h-0`/`min-w-0` (the
//     classic flex-shrink fix) is load-bearing.
// Same "context-dependent default" class as the border-width case below.
const CONTEXT_DEFAULT_PROPS = new Set([
  'width', 'height', 'inline-size', 'block-size',
  'min-width', 'min-height', 'min-inline-size', 'min-block-size',
  // box-sizing's "default" varies by element type AND browser UA (Chrome sets
  // form controls to border-box, Firefox uses content-box) — so a declared
  // `box-sizing:border-box` that matches the Chromium-computed default here is
  // still load-bearing when the output is viewed in another browser.
  'box-sizing',
  // Computed as ABSOLUTE px derived from the element's own box (50% 50% of a
  // bare probe's ~0×0 box computes to `0px 0px`), so an authored `0% 0px` on a
  // real element false-matches the probe's "default". Box-dependent, never
  // comparable against a bare-tag probe.
  'transform-origin', 'perspective-origin',
]);

/** Cascade order of a decl materialised from computed style — below every author
 *  declaration (whose counter starts at 0), so emission never has to guess. */
export const MATERIALISED_ORDER = -1;

const SVG_TAGS = new Set([
  'svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon',
  'ellipse', 'g', 'defs', 'use', 'symbol', 'text', 'tspan',
  'mask', 'clippath', 'pattern', 'lineargradient', 'radialgradient',
  'stop', 'image', 'foreignobject', 'marker', 'filter',
]);

export function resolveElementStyles(
  tag: string,
  matched: MatchedStyles | null,
  computedMap: Map<string, string>,
  tagDefaults: Map<string, string> | undefined,
  includeInherited: boolean,
  // When false, the tag-default drop passes (3 & 4) are skipped. Used when
  // building maps for a STATE diff: a :hover rule that resets a base-declared
  // property back to its tag default must stay visible, otherwise the delta
  // silently fails to reproduce the reset.
  dropDefaults = true,
  // When true, INHERITABLE properties are never dropped by the tag-default
  // passes. Used in full-DOCUMENT mode: inheritance flows through the emitted
  // rules, so a declared inherited value equal to the bare-tag default may
  // still be overriding a DIFFERENT value inherited from the parent — dropping
  // it would let the parent's value leak in. (Same "context-dependent default"
  // class as the border-width/border-style case.)
  protectInherited = false,
): Map<string, ResolvedDecl> {
  const resolved = matched
    ? cascadeResolve(matched.matchedCSSRules || [], matched.inlineStyle, matched.attributesStyle)
    : new Map<string, ResolvedDecl>();
  return denoiseResolved(tag, resolved, computedMap, tagDefaults, includeInherited, dropDefaults, protectInherited);
}

/**
 * De-noise a resolved author-cascade map — the passes that run AFTER
 * cascadeResolve (inherited materialise, var/calc, drop-noise 1–8). Shared by
 * resolveElementStyles (CDP getMatchedStylesForNode) and the in-page matcher,
 * which produces the same resolved map from document.styleSheets + el.matches.
 */
export function denoiseResolved(
  tag: string,
  resolved: Map<string, ResolvedDecl>,
  computedMap: Map<string, string>,
  tagDefaults: Map<string, string> | undefined,
  includeInherited: boolean,
  dropDefaults = true,
  protectInherited = false,
): Map<string, ResolvedDecl> {
  const isSvg = SVG_TAGS.has(tag);

  // Materialise inherited props (font/color/line-height/…) from the element's
  // *computed* style. On a live page the computed value already reflects the
  // real ancestor chain, so this is literally "inherited from parents".
  // (extension snapshot.ts:338–352, `isRoot` branch — gated by the 4th flag.)
  if (includeInherited) {
    for (const prop of INHERITABLE) {
      const declared = resolved.get(prop);
      const isPassThrough = !declared || isPassThroughKeyword(declared.value);
      if (!isPassThrough) continue;
      const v = computedMap.get(prop);
      if (v && !isPassThroughKeyword(v) && v !== 'normal' && v !== '') {
        // order MATERIALISED_ORDER, not 0: the cascade counter starts at 0, so a
        // zero here would tie with a real author declaration and let map position
        // decide the emit order (`cascadeOrdered`). An inherited value is what the
        // element falls back to, so it belongs below every author declaration —
        // load-bearing because INHERITABLE holds shorthands (`font`,
        // `text-decoration`, `list-style`) that a longhand may legitimately beat.
        // A `currentColor`-defaulting inherited colour computes to the element's
        // own `color`, and `getComputedStyle` cannot tell that default from an
        // authored colour that happens to equal it. Materialising the CONCRETE
        // value freezes it for every descendant, so a descendant with its own
        // `color` stops resolving — re-emit the default form instead, which
        // renders identically here and keeps the per-element resolution.
        const materialised = CURRENT_COLOR_DEFAULTED.has(prop) && v === computedMap.get('color') ? 'currentcolor' : v;
        resolved.set(prop, { value: materialised, important: false, specificity: 0, order: MATERIALISED_ORDER });
      }
    }
  }

  // Props whose emitted value would render DIFFERENTLY in the standalone output
  // and cannot be materialised from computed (e.g. `all`, which getComputedStyle
  // reports as empty) — dropping is safer than emitting a layer/origin-relative
  // keyword that resolves to UA defaults once the @layers are stripped.
  const unmaterialisable: string[] = [];
  for (const [prop, d] of resolved) {
    let iacvt = false;
    if (d.value.includes('var(')) {
      const flags = { invalid: false };
      d.value = resolveVars(d.value, computedMap, 0, flags);
      iacvt = flags.invalid;
    }
    if (d.value.includes('calc(')) d.value = simplifyCalc(d.value);
    if (prop === 'box-shadow') d.value = stripTransparentShadows(d.value);
    d.value = d.value.replace(/calc\(infinity\s*\*\s*1px\)/gi, '9999px');
    // A `border-radius` that RESOLVED to a near-infinite number (a pill built
    // with `calc(infinity*1px)` computes to FLT_MAX = 3.40282e38px) sails past
    // the literal-calc replace above. Clamp any absurdly-large radius component
    // to the same `9999px` token: render-equivalent (both max out the corner on
    // any real box) AND it makes the shorthand `3.40282e38px` string-equal to
    // its `3.40282e+38px` longhands so Pass 5 can collapse them.
    if (
      prop === 'border-radius' ||
      /^border-(top|bottom)-(left|right)-radius$/.test(prop) || // physical corners
      /^border-(start|end)-(start|end)-radius$/.test(prop) // logical corners
    ) {
      d.value = clampHugeRadius(d.value);
    }

    // Materialise from the browser's COMPUTED value when the value we'd emit
    // would render differently in the standalone (single-origin, layerless)
    // output. The browser already resolved these correctly:
    //   • IACVT — an undefined var() with no usable fallback invalidated the
    //     decl; the leftover tokens are a valid-but-wrong remainder. Computed
    //     holds the real fallen-back value (cascade runner-up / inherited /
    //     initial), which cascadeResolve already collapsed away.
    //   • layer/origin-relative pass-through keywords (`revert-layer`, `revert`)
    //     reference @layers/origins that were stripped from the output, so they
    //     roll back to the wrong place. (Plain inherit/initial/unset reproduce
    //     fine in the standalone doc, so they are deliberately NOT materialised.)
    if (iacvt || isLayerRelativeKeyword(d.value)) {
      const cv = computedMap.get(prop);
      if (cv !== undefined && cv !== '') d.value = cv;
      else if (!iacvt) unmaterialisable.push(prop);
    }
  }
  for (const p of unmaterialisable) resolved.delete(p);
  { const bs = resolved.get('box-shadow'); if (bs && !bs.value) resolved.delete('box-shadow'); }

  // 1. Always-drop props + custom properties.
  for (const prop of [...resolved.keys()]) {
    if (ALWAYS_DROP_PROPS.has(prop) || prop.startsWith('--')) resolved.delete(prop);
  }

  // 2. SVG geometry / layout noise.
  if (isSvg) {
    // The ROOT <svg> is commonly CSS-sized (Tailwind w-4/h-4), so keep its
    // width/height; only inner primitives (path/circle/rect/…) carry geometry
    // via attributes and can have their CSS geometry stripped. The root also
    // KEEPS its box/layout props (margin/padding/border/background/box-sizing):
    // it participates in normal flex/grid/inline layout, so an icon's `ml-1`
    // is a real 4px of row width (extractionDropsProperty mirrors this split).
    const isRootSvg = tag === 'svg';
    for (const prop of [...resolved.keys()]) {
      if (isRootSvg && (prop === 'width' || prop === 'height')) continue;
      if (isRootSvg ? SVG_GEOMETRY_PROPS.has(prop) : (SVG_GEOMETRY_PROPS.has(prop) || isSvgLayoutNoise(prop))) resolved.delete(prop);
    }
  }

  // A visible border-style makes the *effective* default border-width `medium`
  // (3px), not the tag's `0px` (which assumes border-style:none). So a zero
  // `border-width` / `border-*-width` declaration is load-bearing here — it
  // suppresses phantom borders — and must survive the default-drop passes.
  // (Common Tailwind/preflight reset: `*{border-width:0;border-style:solid}`.)
  const borderStyleActive = hasActiveBorderStyle(resolved);
  // `min-width`/`min-height` initial value is `auto`, which the browser reports
  // as computed `0px` on a normal block — but in a FLEX/GRID item `auto` means
  // min-content, so an explicit `min-*:0` (the classic `min-h-0`/`min-w-0`
  // flex-shrink fix) is load-bearing and must NOT be dropped as "== default".
  // Same "context-dependent default" class as the border-width case above.

  // Passes 3/4 compare against the BARE-TAG default, which is the wrong baseline
  // when another SURVIVING declaration already re-bases the property group in the
  // emitted rule set: on a tag whose UA default is non-zero (form controls —
  // `button{border-width:2px;padding:1px 6px}`) a preflight `*{border:0 solid}`
  // makes 0px the effective base, so a `border-bottom-width:2px` that merely
  // COINCIDES with the UA 2px is load-bearing, not noise. The base index below
  // answers with that effective base (a covering shorthand's expansion first, the
  // tag default as the fallback); it is built ONCE, off a snapshot taken before
  // either pass mutates `resolved`, so the outcome can't depend on key order.
  const preDropSnapshot = dropDefaults && tagDefaults ? new Map(resolved) : null;
  // The logical↔physical bridge holds only under a horizontal writing-mode:
  // `vertical-*` and `sideways-*` (Chrome reports both verbatim) put the INLINE
  // axis on top/bottom. Swapping the map to match is NOT enough there, because the
  // OTHER side of the comparison is wrong too — `getTagDefaults` measures in a
  // horizontal iframe, so a tag whose UA default is logical (`p{margin-block:1em}`,
  // `input{padding:1px 2px}`) reports it on the wrong physical sides, and a swapped
  // bridge turns that into a dropped declaration (fuzz witness: `margin:0` +
  // `margin-inline:0` on a vertical `<p>` loses the 0 and renders the UA 16px).
  // So the bridge is OFF under a vertical mode, which degrades to comparing against
  // the tag default — the pre-existing behaviour, keep-biased and render-safe.
  // Re-enable it WITH the swap once the defaults are measured per writing-mode
  // (backlog `t-hv97va`). Unknown (the prop isn't in the computed union) means no
  // rule declares it, i.e. the initial `horizontal-tb`.
  const horizontalWm = !/^(vertical|sideways)/.test(computedMap.get('writing-mode') || '');
  interface BaseCandidate { prop: string; value: string; decl: ResolvedDecl }
  const baseIndex = new Map<string, BaseCandidate[]>();
  if (preDropSnapshot) {
    for (const [shProp, shDecl] of preDropSnapshot) {
      const exp = expandShorthand(shProp, shDecl.value);
      if (!exp) continue;
      for (const [lh, v] of exp) {
        // A CSS-wide keyword names no concrete base (tailwind preflight puts
        // `font:inherit` on form controls, and `expandShorthand` DOES expand that
        // form) — treating it as one would keep every font longhand alive in the
        // single-element path, where INHERITABLE isn't protected.
        if (isPassThroughKeyword(v)) continue;
        const cand = { prop: shProp, value: v, decl: shDecl };
        for (const k of [lh, horizontalWm ? boxSlot(lh) : null]) {
          if (k === null) continue;
          const bucket = baseIndex.get(k);
          if (bucket) bucket.push(cand); else baseIndex.set(k, [cand]);
        }
      }
    }
  }
  /**
   * Is `value` (for slot `key`, declared by `selfProp`) what the emitted rules
   * would produce anyway — i.e. is the declaration noise?
   *
   * Only a shorthand the candidate BEATS supplies a base. That asymmetry is what
   * stops two shorthands covering one slot (`margin:0` + `margin-block:0`) from
   * proving each other redundant and BOTH disappearing, taking the value with
   * them: the strongest carrier of a slot never finds a base and so falls back to
   * the tag default, which is exactly the "would the UA give us this anyway?"
   * question. A candidate that LOSES to a covering shorthand is dead either way
   * (Pass 6/6b removes it), so the extra keep it gets here costs nothing.
   *
   * With several bases the drop needs EVERY one to agree — the logical↔physical
   * bridge is axis-level, so a `padding` shorthand offers `padding-inline-start`
   * both physical sides and the ambiguity resolves toward keep.
   */
  const equalsEffectiveBase = (key: string, self: ResolvedDecl, selfProp: string, value: string): boolean => {
    // A key that HAS a slot reads the slot bucket — it already holds every
    // candidate indexed under the exact name too (same name ⇒ same slot).
    const slot = horizontalWm ? boxSlot(key) : null;
    const bases = baseIndex.get(slot ?? key)?.filter((c) => c.prop !== selfProp && declBeats(self, c.decl));
    if (bases && bases.length > 0) return bases.every((b) => effectivelyEqual(value, b.value));
    const def = tagDefaults!.get(key);
    return def !== undefined && effectivelyEqual(value, def);
  };

  // 3. Drop decls whose computed effect equals the effective default for the tag.
  if (dropDefaults && tagDefaults) {
    for (const prop of [...resolved.keys()]) {
      if (borderStyleActive && isZeroBorderWidth(prop, resolved.get(prop)!.value)) continue;
      if (protectInherited && INHERITABLE.has(prop)) continue;
      if (CONTEXT_DEFAULT_PROPS.has(prop)) continue;
      const cur = computedMap.get(prop);
      if (cur === undefined || tagDefaults.get(prop) === undefined) continue;
      if (equalsEffectiveBase(prop, resolved.get(prop)!, prop, cur)) resolved.delete(prop);
    }
  }

  // 4. Drop shorthands whose expansion is fully equal to the effective defaults.
  if (dropDefaults && tagDefaults) {
    for (const prop of [...resolved.keys()]) {
      const decl = resolved.get(prop)!;
      if (borderStyleActive && isZeroBorderWidth(prop, decl.value)) continue;
      if (protectInherited && INHERITABLE.has(prop)) continue;
      if (CONTEXT_DEFAULT_PROPS.has(prop)) continue;
      const expansion = expandShorthand(prop, decl.value);
      if (!expansion) continue;
      let allDefault = true;
      for (const [lh, expValue] of expansion) {
        if (tagDefaults.get(lh) === undefined) { allDefault = false; break; }
        if (!equalsEffectiveBase(lh, decl, prop, expValue)) { allDefault = false; break; }
      }
      if (allDefault) resolved.delete(prop);
    }
  }

  // 5. Drop longhands whose value matches a captured shorthand's expansion.
  for (const [shProp, shDecl] of resolved) {
    const expansion = expandShorthand(shProp, shDecl.value);
    if (!expansion) continue;
    for (const [lh, expValue] of expansion) {
      const lhDecl = resolved.get(lh);
      if (!lhDecl || lhDecl.important !== shDecl.important) continue;
      if (effectivelyEqual(lhDecl.value, expValue)) resolved.delete(lh);
    }
  }

  // 5b. Drop shorthand B whose entire expansion is already covered by shorthand A.
  {
    const toDelete = new Set<string>();
    for (const [shPropA, shDeclA] of resolved) {
      if (toDelete.has(shPropA)) continue;
      const expansionA = expandShorthand(shPropA, shDeclA.value);
      if (!expansionA) continue;
      for (const [shPropB, shDeclB] of resolved) {
        if (shPropB === shPropA || toDelete.has(shPropB)) continue;
        if (shDeclB.important !== shDeclA.important) continue;
        const expansionB = expandShorthand(shPropB, shDeclB.value);
        if (!expansionB || expansionB.size > expansionA.size) continue;
        let covered = true;
        for (const [lh, val] of expansionB) {
          const aVal = expansionA.get(lh);
          if (aVal === undefined || !effectivelyEqual(aVal, val)) { covered = false; break; }
        }
        if (covered) toDelete.add(shPropB);
      }
    }
    for (const p of toDelete) resolved.delete(p);
  }

  // 6. Drop dead-on-arrival longhands beaten by a covering shorthand.
  for (const prop of [...resolved.keys()]) {
    const decl = resolved.get(prop)!;
    const computed = computedMap.get(prop);
    if (!computed || effectivelyEqual(decl.value, computed)) continue;
    if (anyOverridingShorthandPresent(prop, decl, resolved)) resolved.delete(prop);
  }

  // 6b. Drop dead-on-arrival longhands beaten by a covering shorthand that
  // `expandShorthand` can't model (background/font/list-style/…). Pass 6 handles
  // the box/border/flex families; this closes the gap for the rest. VALUE-
  // INDEPENDENT: a shorthand fully determines ALL its component longhands (an
  // omitted one resets to its initial), so a covered longhand at LOWER cascade
  // order than the shorthand is dead. This is what lets the emit-shorthand-
  // before-longhand order (extract.ts / style-string.ts) never surface
  // a stale loser — after this pass a co-present longhand is always the winner.
  for (const [sh, longhands] of Object.entries(SHORTHAND_COVERAGE)) {
    const shDecl = resolved.get(sh);
    if (!shDecl) continue;
    for (const lh of longhands) {
      const lhDecl = resolved.get(lh);
      if (lhDecl && declBeats(shDecl, lhDecl)) resolved.delete(lh);
    }
  }

  // 7. All border widths 0 → style/color longhands are noise (keep shorthands).
  const allBorderZero = ['top', 'right', 'bottom', 'left'].every(
    (s) => computedMap.get(`border-${s}-width`) === '0px',
  );
  if (allBorderZero) {
    for (const prop of [...resolved.keys()]) {
      const isStyle = prop === 'border-style' || /^border-(top|right|bottom|left)-style$/.test(prop);
      const isColor = prop === 'border-color' || /^border-(top|right|bottom|left)-color$/.test(prop);
      if (isStyle) {
        // `none`/`hidden` is the SUPPRESSOR (it forces the width to 0) — keep it,
        // else the UA default style (e.g. a button's `outset`) reappears next to
        // a non-zero `border-width` and paints a phantom native border.
        const v = resolved.get(prop)!.value.trim().toLowerCase();
        if (v !== 'none' && v !== 'hidden') resolved.delete(prop);
      } else if (isColor) {
        resolved.delete(prop);
      }
    }
  }

  // 8. Outline that doesn't render → drop outline noise.
  const outlineStyle = computedMap.get('outline-style');
  const outlineWidth = computedMap.get('outline-width');
  if (outlineStyle === 'none' || outlineWidth === '0px') {
    for (const prop of ['outline', 'outline-color', 'outline-style', 'outline-width', 'outline-offset']) {
      resolved.delete(prop);
    }
  }

  return resolved;
}

// ── pseudo-classes (:hover / :focus / …) — state delta ───────────────────────

/**
 * Properties a forced pseudo-class STATE changes relative to the normal state:
 * every prop whose state-resolved value differs from (or is absent in) the base.
 * Both maps must be produced by resolveElementStyles with the SAME options
 * (typically includeInherited:false) so only real overrides survive.
 */
export function diffResolved(
  base: Map<string, ResolvedDecl>,
  state: Map<string, ResolvedDecl>,
): Map<string, ResolvedDecl> {
  const out = new Map<string, ResolvedDecl>();
  for (const [prop, d] of state) {
    const b = base.get(prop);
    if (!b || !effectivelyEqual(b.value, d.value) || b.important !== d.important) {
      out.set(prop, d);
    }
  }
  return out;
}

// ── pseudo-elements (::before / ::after / ::placeholder / …) ──────────────────

/** Pseudo-element types we can faithfully replicate as a rule. */
export const REPLICABLE_PSEUDOS = new Set([
  'before', 'after', 'first-line', 'first-letter', 'marker', 'placeholder', 'selection',
]);

/**
 * Resolve + de-noise the CSS of ONE pseudo-element (ported from the extension's
 * pseudo branch, snapshot.ts:528–584). Returns the decl map, or null when the
 * pseudo-element carries nothing worth emitting (e.g. ::before with no content).
 */
export function resolvePseudoElement(
  pseudoType: string,
  matches: RuleMatch[],
  computedMap: Map<string, string>,
  peDefaults: Map<string, string> | undefined,
): Map<string, ResolvedDecl> | null {
  const resolved = cascadeResolve(matches || [], undefined, undefined);
  if (resolved.size === 0) return null;

  for (const [, d] of resolved) {
    if (d.value.includes('var(')) d.value = resolveVars(d.value, computedMap);
    if (d.value.includes('calc(')) d.value = simplifyCalc(d.value);
  }

  for (const prop of [...resolved.keys()]) {
    if (ALWAYS_DROP_PROPS.has(prop) || prop.startsWith('--')) resolved.delete(prop);
  }

  if (peDefaults) {
    for (const prop of [...resolved.keys()]) {
      const decl = resolved.get(prop)!;
      const def = peDefaults.get(prop);
      if (def === undefined) continue;
      // The bare pseudo default is the wrong baseline when a SURVIVING shorthand
      // the candidate BEATS re-bases the property — the same context-dependent
      // default the element path resolves in `equalsEffectiveBase` (§6). A
      // `list-style-position:outside` that merely coincides with the default is
      // load-bearing under a `list-style:square inside` it out-ranks: drop it and
      // the shorthand's `inside` takes over. Only a LOSING shorthand counts, so
      // two covering declarations can't prove each other redundant.
      if (rebasedByBeatenShorthand(prop, decl, resolved)) continue;
      if (decl.value === def || effectivelyEqual(decl.value, def)) resolved.delete(prop);
    }
  }

  // Collapse shorthand + longhand duplicates.
  for (const [shProp, shDecl] of resolved) {
    const expansion = expandShorthand(shProp, shDecl.value);
    if (!expansion) continue;
    for (const [lh, expValue] of expansion) {
      const lhDecl = resolved.get(lh);
      if (!lhDecl || lhDecl.important !== shDecl.important) continue;
      if (effectivelyEqual(lhDecl.value, expValue)) resolved.delete(lh);
    }
  }

  // Pass 6/6b, the pseudo copy. `denoiseResolved` never runs here, so without
  // this a longhand a shorthand BEATS survives to emission, and the flat rule
  // then depends on their relative position — which the safety net in
  // `declsToDeclString` is free to change (it cannot tell who won). Dropping the
  // dead one removes the dependency at the source. VALUE-INDEPENDENT and safe for
  // both halves: a shorthand sets every component it covers (an omitted one
  // resets to its initial), so a covered longhand at LOWER cascade order paints
  // nothing. The element-path Pass 6 additionally consults `computedMap`; here it
  // holds the HOST's computed style, not the pseudo's, so it must not be used.
  const dropCoveredLosers = (covered: (sh: string, v: string) => Iterable<string>): void => {
    for (const [sh, shDecl] of [...resolved]) {
      for (const lh of covered(sh, shDecl.value)) {
        if (lh === sh) continue;
        const lhDecl = resolved.get(lh);
        if (lhDecl && declBeats(shDecl, lhDecl)) resolved.delete(lh);
      }
    }
  };
  dropCoveredLosers((sh, v) => expandShorthand(sh, v)?.keys() ?? []);
  dropCoveredLosers((sh) => SHORTHAND_COVERAGE[sh] ?? []);

  // ::before / ::after only render with a real `content`.
  if (pseudoType === 'before' || pseudoType === 'after') {
    const content = resolved.get('content')?.value?.trim();
    if (!content || content === 'none' || content === 'normal') return null;
  }

  return resolved.size ? resolved : null;
}

// ── helpers (ported verbatim) ────────────────────────────────────────────────

function stripTransparentShadows(value: string): string {
  if (!value || value === 'none') return value;
  const layers = splitTopLevelComma(value);
  const visible = layers.filter((l) => !isTransparentShadowLayer(l));
  if (visible.length === layers.length) return value;
  return visible.join(',');
}
/**
 * A layer is transparent only when its COLOR TOKEN provably has zero alpha.
 * Word-level matching is unsound: a visible ring's color can be
 * `color-mix(in oklab, #111 10%, transparent)` — the word `transparent` inside
 * a function is not the layer's transparency. Unparseable color ⇒ KEEP.
 */
function isTransparentShadowLayer(layer: string): boolean {
  for (const tok of splitTopLevel(layer)) {
    const lo = tok.toLowerCase();
    if (lo === 'transparent') return true;
    if (lo.startsWith('#')) {
      // Only a ZERO-ALPHA hex: #RGBA / #RRGGBBAA with all-zero alpha digits.
      // #000/#000000 are OPAQUE black.
      if (/^#(?:[0-9a-f]{3}0|[0-9a-f]{6}00)$/.test(lo)) return true;
      continue;
    }
    const fn = /^([a-z-]+)\(([^]*)\)$/.exec(lo);
    if (!fn) continue; // lengths / inset keyword
    if (fn[1] === 'rgb' || fn[1] === 'rgba' || fn[1] === 'hsl' || fn[1] === 'hsla') {
      const c = colord(lo);
      if (c.isValid() && c.alpha() === 0) return true;
    } else if (['oklab', 'oklch', 'lab', 'lch', 'hwb', 'color'].includes(fn[1])) {
      // slash-alpha syntax: transparent only at an explicit literal 0 alpha
      const m = /\/\s*(-?[\d.]+%?)\s*$/.exec(fn[2]);
      if (m && parseFloat(m[1]) === 0) return true;
    }
    // color-mix / var remainder / anything else: not provably transparent — keep
  }
  return false;
}
/** A `border-width` shorthand or `border-{side}-width` longhand that is all-zero. */
function isZeroBorderWidth(prop: string, value: string): boolean {
  if (prop === 'border-width') return splitTopLevel(value).every(isZeroLength);
  if (/^border-(top|right|bottom|left)-width$/.test(prop)) return isZeroLength(value);
  return false;
}
function isZeroLength(v: string): boolean {
  return /^0(px|em|rem|%|pt|pc|cm|mm|in|q|ch|ex|vh|vw|vmin|vmax)?$/i.test(v.trim());
}

/**
 * Replace any near-infinite length component of a border-radius value with the
 * `9999px` token (the same one the calc(infinity*1px) replace uses). Threshold
 * 1e6px is far above any real layout, so this only ever fires on a degenerate
 * pill radius (FLT_MAX 3.40282e38px, or a scientific-notation resolved value).
 * Handles the `/` elliptical form and multi-corner lists token-wise.
 */
function clampHugeRadius(value: string): string {
  // Consume ANY trailing unit ([a-z%]*) into the match so a huge value in an
  // exotic unit (svh/dvh/…) collapses cleanly to `9999px` rather than leaving a
  // stray unit (`9999pxsvh`). border-radius values are only lengths/percents/`/`,
  // so nothing else can be caught. parseFloat reads the numeric prefix (with
  // scientific notation, `+` or not); NaN never trips the guard.
  return value.replace(/-?\d*\.?\d+(?:e[+-]?\d+)?[a-z%]*/gi, (m) => {
    const n = parseFloat(m);
    return Number.isFinite(n) && Math.abs(n) >= 1e6 ? '9999px' : m;
  });
}

/** True if the resolved set asserts a rendered (non-none/hidden) border-style on any side. */
function hasActiveBorderStyle(resolved: Map<string, ResolvedDecl>): boolean {
  const visible = (v: string) => {
    const t = v.trim().toLowerCase();
    return t !== '' && t !== 'none' && t !== 'hidden';
  };
  for (const [prop, d] of resolved) {
    if (prop === 'border-style' || /^border-(top|right|bottom|left)-style$/.test(prop)) {
      if (splitTopLevel(d.value).some(visible)) return true;
    } else if (
      prop === 'border' || prop === 'border-inline' || prop === 'border-block' ||
      /^border-(top|right|bottom|left)$/.test(prop)
    ) {
      const exp = expandShorthand(prop, d.value);
      if (exp) for (const [k, val] of exp) if (k.endsWith('-style') && visible(val)) return true;
    }
  }
  return false;
}

/** Does a surviving shorthand that `decl` BEATS cover `prop`, i.e. is the property's
 *  fallback something other than the bare default? Coverage spans both sources the
 *  emitter knows (`expandShorthand` ∪ `SHORTHAND_COVERAGE`). */
function rebasedByBeatenShorthand(prop: string, decl: ResolvedDecl, resolved: Map<string, ResolvedDecl>): boolean {
  for (const [sh, shDecl] of resolved) {
    if (sh === prop || !declBeats(decl, shDecl)) continue;
    const covered = expandShorthand(sh, shDecl.value)?.has(prop) || (SHORTHAND_COVERAGE[sh] ?? []).includes(prop);
    if (covered) return true;
  }
  return false;
}

/**
 * The axis-level box slot a longhand addresses, or null when it addresses none.
 * It is what lets the logical and physical spellings of one slot meet:
 * `getTagDefaults` enumerates the computed style, which reports LOGICAL longhands
 * (`padding-inline-start`, `border-inline-start-width`), while
 * `expandShorthand('padding'|'border', …)` emits PHYSICAL ones. Pinning a logical
 * side to ONE physical side needs `direction` as well, so the mapping stops at
 * the axis and the caller resolves the ambiguity toward keep. The map assumes a
 * HORIZONTAL writing-mode (the caller gates on that — see `horizontalWm`);
 * `direction:rtl` does not enter, it only reorders start/end within an axis.
 */
const AXIS: Record<string, string> = { top: 'block', bottom: 'block', left: 'inline', right: 'inline' };
function boxSlot(prop: string): string | null {
  const axis = AXIS;
  let m = /^(margin|padding)-(top|right|bottom|left)$/.exec(prop);
  if (m) return `${m[1]}|${axis[m[2]]}`;
  m = /^(margin|padding)-(inline|block)-(start|end)$/.exec(prop);
  if (m) return `${m[1]}|${m[2]}`;
  m = /^border-(top|right|bottom|left)-(width|style|color)$/.exec(prop);
  if (m) return `border|${axis[m[1]]}|${m[2]}`;
  m = /^border-(inline|block)-(start|end)-(width|style|color)$/.exec(prop);
  if (m) return `border|${m[1]}|${m[3]}`;
  if (axis[prop]) return `inset|${axis[prop]}`;
  m = /^inset-(inline|block)-(start|end)$/.exec(prop);
  if (m) return `inset|${m[1]}`;
  return null;
}

function isPassThroughKeyword(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === 'inherit' || v === 'initial' || v === 'unset' || v === 'revert' || v === 'revert-layer';
}
/**
 * Pass-through keywords that roll a property back RELATIVE to @layers/origins
 * that don't exist in the standalone output, so they render differently there:
 *   • `revert-layer` → previous @layer (all layers stripped in output).
 *   • `revert`       → previous origin (author origin flattened in output).
 * These must be materialised from computed; plain inherit/initial/unset don't
 * reference layers/origins and reproduce faithfully, so are excluded.
 */
function isLayerRelativeKeyword(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === 'revert' || v === 'revert-layer';
}
function isSvgLayoutNoise(prop: string): boolean {
  if (prop === 'box-sizing') return true;
  if (prop.startsWith('margin') || prop.startsWith('padding')) return true;
  if (prop.startsWith('outline')) return true;
  if (prop.startsWith('background')) return true;
  if (prop.startsWith('border')) return true;
  return false;
}
function anyOverridingShorthandPresent(
  longhand: string,
  lhDecl: ResolvedDecl,
  resolved: Map<string, ResolvedDecl>,
): boolean {
  for (const sh of resolved.keys()) {
    if (sh === longhand) continue;
    const shDecl = resolved.get(sh)!;
    const exp = expandShorthand(sh, shDecl.value);
    if (!exp || !exp.has(longhand)) continue;
    if (declBeats(shDecl, lhDecl)) return true;
  }
  return false;
}
export function effectivelyEqual(a: string, b: string): boolean {
  if (a === b) return true;
  if (normaliseValue(a) === normaliseValue(b)) return true;
  // Colour equivalence across formats (#ececf0 == rgb(236,236,240) == names).
  const ca = colord(a);
  const cb = colord(b);
  return ca.isValid() && cb.isValid() && ca.toRgbString() === cb.toRgbString();
}
function normaliseValue(v: string): string {
  return v.trim().toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/(^|[^a-z0-9])0(?:px|em|rem|%)\b/g, '$10');
}
