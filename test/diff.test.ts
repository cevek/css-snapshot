// DoD for the style PATCH (diff.ts) — GOLDEN BATTERY level (pure, no browser).
//
// Hand-authored StyleJson A/B, asserting the EXACT patch AND the EXACT applied
// output. This is the independent oracle for states / pseudos / relational (which
// a static screenshot can't see). Deterministic and fast — this is the `unit`
// vitest project.
//
// The RENDER-IDENTITY + ROUND-TRIP level (real extraction, Firefox pixel oracle)
// lives in ./diff.browser.test.ts (the `browser` project).
import { describe, it, expect } from 'vitest';
import { type SelfContainedStyles, type StyleJson } from '../src/extract.ts';
import { diffStyles, diffElements, applyStylePatch, canonicalStyleJson } from '../src/diff.ts';

// Wrap a StyleJson into a minimal SelfContainedStyles for apply.
const sc = (elements: StyleJson, rootContext?: { fontSize: string }, fonts = ''): SelfContainedStyles => {
  const o: SelfContainedStyles = { tree: { tag: 'html' }, fonts, elements };
  if (rootContext) o.rootContext = rootContext;
  return o;
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. GOLDEN BATTERY — pure, deterministic, exact patch + exact applied output.
// ─────────────────────────────────────────────────────────────────────────────
describe('golden battery — exact patch + exact applied', () => {
  // Each case: [name, A.elements, B.elements, expected patch.elements, expected applied.elements]
  const cases: Array<[string, StyleJson, StyleJson, Record<string, unknown>, StyleJson]> = [
    [
      'color-change',
      { el1: { base: { color: 'red' } } },
      { el1: { base: { color: 'blue' } } },
      { el1: { base: { set: { color: 'blue' }, delete: [] } } },
      { el1: { base: { color: 'blue' } } },
    ],
    [
      'length-change (shorthand → longhand set)',
      { el1: { base: { padding: '8px' } } },
      { el1: { base: { padding: '12px' } } },
      {
        el1: {
          base: {
            set: { 'padding-top': '12px', 'padding-right': '12px', 'padding-bottom': '12px', 'padding-left': '12px' },
            delete: [],
          },
        },
      },
      {
        el1: {
          base: { 'padding-top': '12px', 'padding-right': '12px', 'padding-bottom': '12px', 'padding-left': '12px' },
        },
      },
    ],
    [
      'prop-add',
      { el1: { base: { color: 'red' } } },
      { el1: { base: { color: 'red', 'border-radius': '4px' } } },
      {
        el1: {
          base: {
            set: {
              'border-top-left-radius': '4px',
              'border-top-right-radius': '4px',
              'border-bottom-right-radius': '4px',
              'border-bottom-left-radius': '4px',
            },
            delete: [],
          },
        },
      },
      {
        el1: {
          base: {
            color: 'red',
            'border-top-left-radius': '4px',
            'border-top-right-radius': '4px',
            'border-bottom-right-radius': '4px',
            'border-bottom-left-radius': '4px',
          },
        },
      },
    ],
    [
      'prop-remove',
      { el1: { base: { color: 'red', 'text-decoration-line': 'underline' } } },
      { el1: { base: { color: 'red' } } },
      { el1: { base: { set: {}, delete: ['text-decoration-line'] } } },
      { el1: { base: { color: 'red' } } },
    ],
    [
      'shorthand↔longhand-equal → EMPTY patch',
      { el1: { base: { margin: '8px' } } },
      { el1: { base: { 'margin-top': '8px', 'margin-right': '8px', 'margin-bottom': '8px', 'margin-left': '8px' } } },
      {},
      // apply of an empty patch keeps A's representation verbatim (canonically == B).
      { el1: { base: { margin: '8px' } } },
    ],
    [
      '!important toggle (add)',
      { el1: { base: { color: 'red' } } },
      { el1: { base: { color: 'red !important' } } },
      { el1: { base: { set: { color: 'red !important' }, delete: [] } } },
      { el1: { base: { color: 'red !important' } } },
    ],
    [
      '!important toggle (remove)',
      { el1: { base: { color: 'red !important' } } },
      { el1: { base: { color: 'red' } } },
      { el1: { base: { set: { color: 'red' }, delete: [] } } },
      { el1: { base: { color: 'red' } } },
    ],
    [
      'state-delta',
      { el1: { states: { hover: { 'background-color': 'red' } } } },
      { el1: { states: { hover: { 'background-color': 'blue' } } } },
      { el1: { states: { hover: { set: { 'background-color': 'blue' }, delete: [] } } } },
      { el1: { states: { hover: { 'background-color': 'blue' } } } },
    ],
    [
      'pseudo-delta (case-sensitive content)',
      { el1: { pseudos: { after: { base: { content: '"x"' } } } } },
      { el1: { pseudos: { after: { base: { content: '"y"' } } } } },
      { el1: { pseudos: { after: { base: { set: { content: '"y"' }, delete: [] } } } } },
      { el1: { pseudos: { after: { base: { content: '"y"' } } } } },
    ],
    [
      'relational-delta',
      { el2: { relational: [{ trigger: 'el1', state: 'hover', combinator: ' ', delta: { opacity: '0' } }] } },
      { el2: { relational: [{ trigger: 'el1', state: 'hover', combinator: ' ', delta: { opacity: '1' } }] } },
      {
        el2: {
          relational: {
            upsert: [{ trigger: 'el1', state: 'hover', combinator: ' ', delta: { opacity: '1' } }],
          },
        },
      },
      { el2: { relational: [{ trigger: 'el1', state: 'hover', combinator: ' ', delta: { opacity: '1' } }] } },
    ],
    [
      'url() case-only change is a real diff (case-sensitive host)',
      { el1: { base: { 'background-image': 'url(A.png)' } } },
      { el1: { base: { 'background-image': 'url(a.png)' } } },
      { el1: { base: { set: { 'background-image': 'url(a.png)' }, delete: [] } } },
      { el1: { base: { 'background-image': 'url(a.png)' } } },
    ],
    [
      'same-case url() → empty patch (no false diff)',
      { el1: { base: { 'background-image': 'url(a.png)' } } },
      { el1: { base: { 'background-image': 'url(a.png)' } } },
      {},
      { el1: { base: { 'background-image': 'url(a.png)' } } },
    ],
    // ── box-shadow / text-shadow: representation-invariant equality ──
    // Each EQUAL pair → empty patch (applied keeps A's string; canonically == B).
    [
      'box-shadow: color reorder + hex8↔rgba + 0↔0px → EMPTY patch (user report)',
      { el1: { base: { 'box-shadow': 'rgba(17, 17, 17, 0.03) 0px 1px 2px' } } },
      { el1: { base: { 'box-shadow': '0 1px 2px #11111108' } } },
      {},
      { el1: { base: { 'box-shadow': 'rgba(17, 17, 17, 0.03) 0px 1px 2px' } } },
    ],
    [
      'box-shadow: named↔rgb color, color before/after → EMPTY patch',
      { el1: { base: { 'box-shadow': '0px 1px 2px red' } } },
      { el1: { base: { 'box-shadow': 'rgb(255, 0, 0) 0 1px 2px' } } },
      {},
      { el1: { base: { 'box-shadow': '0px 1px 2px red' } } },
    ],
    [
      'box-shadow: inset preserved both sides, color reorder → EMPTY patch',
      { el1: { base: { 'box-shadow': 'inset red 0 1px 2px' } } },
      { el1: { base: { 'box-shadow': 'inset 0 1px 2px #ff0000' } } },
      {},
      { el1: { base: { 'box-shadow': 'inset red 0 1px 2px' } } },
    ],
    [
      'box-shadow: 4 lengths (spread) + color reorder → EMPTY patch',
      { el1: { base: { 'box-shadow': '0 1px 2px 3px #111111' } } },
      { el1: { base: { 'box-shadow': '#111 0px 1px 2px 3px' } } },
      {},
      { el1: { base: { 'box-shadow': '0 1px 2px 3px #111111' } } },
    ],
    [
      'box-shadow: multi-layer, both layers reordered → EMPTY patch',
      { el1: { base: { 'box-shadow': 'red 0 1px 2px, blue 0 2px 4px' } } },
      { el1: { base: { 'box-shadow': '0 1px 2px red, 0 2px 4px blue' } } },
      {},
      { el1: { base: { 'box-shadow': 'red 0 1px 2px, blue 0 2px 4px' } } },
    ],
    [
      'text-shadow: color reorder + 0↔0px → EMPTY patch',
      { el1: { base: { 'text-shadow': '0 1px 2px red' } } },
      { el1: { base: { 'text-shadow': 'red 0px 1px 2px' } } },
      {},
      { el1: { base: { 'text-shadow': '0 1px 2px red' } } },
    ],
    [
      // KNOWN LIMITATION (pinned): shadow color alpha is compared at colord precision
      // (2 decimals ⇒ ≤~1/255), IDENTICAL to how `effectivelyEqual`/`canonValue` treat
      // EVERY color in the tool. `#00000007` (α .0275) and `#00000008` (α .0314) both
      // parse to α .03 → EMPTY patch. Within the render-identity contract (sub-pixel,
      // below the pixelmatch threshold); RGB channels stay integer-exact. See
      // ARCHITECTURE §9.
      'box-shadow: sub-1/255 alpha delta → EMPTY (colord 2dp precision, consistent w/ single-color)',
      { el1: { base: { 'box-shadow': '0 1px 2px #00000007' } } },
      { el1: { base: { 'box-shadow': '0 1px 2px #00000008' } } },
      {},
      { el1: { base: { 'box-shadow': '0 1px 2px #00000007' } } },
    ],
    [
      // PROOF that the alpha fuzz above is TOOL-WIDE, not a shadow quirk: the SAME
      // `#07`/`#08` alpha delta on a plain single-color prop ALSO diffs to EMPTY on
      // main behaviour (effectivelyEqual/canonValue route every color through colord,
      // which rounds alpha to 2dp at parse). Independent of `canonicalizeShadow`.
      'single color: sub-1/255 alpha delta → EMPTY (pre-existing colord behaviour, tool-wide)',
      { el1: { base: { color: '#00000007' } } },
      { el1: { base: { color: '#00000008' } } },
      {},
      { el1: { base: { color: '#00000007' } } },
    ],
    // Each DIFFERENT pair → non-empty patch (one per parsed dimension).
    [
      'box-shadow: different blur → patch (set B)',
      { el1: { base: { 'box-shadow': '0 1px 2px #111' } } },
      { el1: { base: { 'box-shadow': '0 1px 4px #111' } } },
      { el1: { base: { set: { 'box-shadow': '0 1px 4px #111' }, delete: [] } } },
      { el1: { base: { 'box-shadow': '0 1px 4px #111' } } },
    ],
    [
      'box-shadow: different spread → patch (set B)',
      { el1: { base: { 'box-shadow': '0 1px 2px 3px #111' } } },
      { el1: { base: { 'box-shadow': '0 1px 2px 5px #111' } } },
      { el1: { base: { set: { 'box-shadow': '0 1px 2px 5px #111' }, delete: [] } } },
      { el1: { base: { 'box-shadow': '0 1px 2px 5px #111' } } },
    ],
    [
      'box-shadow: different offset-y → patch (set B)',
      { el1: { base: { 'box-shadow': '0 1px 2px #111' } } },
      { el1: { base: { 'box-shadow': '0 2px 2px #111' } } },
      { el1: { base: { set: { 'box-shadow': '0 2px 2px #111' }, delete: [] } } },
      { el1: { base: { 'box-shadow': '0 2px 2px #111' } } },
    ],
    [
      'box-shadow: inset flag toggled → patch (set B)',
      { el1: { base: { 'box-shadow': 'inset 0 1px 2px #111' } } },
      { el1: { base: { 'box-shadow': '0 1px 2px #111' } } },
      { el1: { base: { set: { 'box-shadow': '0 1px 2px #111' }, delete: [] } } },
      { el1: { base: { 'box-shadow': '0 1px 2px #111' } } },
    ],
    [
      'box-shadow: different color → patch (set B)',
      { el1: { base: { 'box-shadow': '0 1px 2px red' } } },
      { el1: { base: { 'box-shadow': '0 1px 2px blue' } } },
      { el1: { base: { set: { 'box-shadow': '0 1px 2px blue' }, delete: [] } } },
      { el1: { base: { 'box-shadow': '0 1px 2px blue' } } },
    ],
    [
      'box-shadow: different layer-count → patch (set B)',
      { el1: { base: { 'box-shadow': 'red 0 1px 2px' } } },
      { el1: { base: { 'box-shadow': 'red 0 1px 2px, blue 0 2px 4px' } } },
      { el1: { base: { set: { 'box-shadow': 'red 0 1px 2px, blue 0 2px 4px' }, delete: [] } } },
      { el1: { base: { 'box-shadow': 'red 0 1px 2px, blue 0 2px 4px' } } },
    ],
    [
      'box-shadow: swapped layer-order → patch (set B)',
      { el1: { base: { 'box-shadow': 'red 0 1px 2px, blue 0 2px 4px' } } },
      { el1: { base: { 'box-shadow': 'blue 0 2px 4px, red 0 1px 2px' } } },
      { el1: { base: { set: { 'box-shadow': 'blue 0 2px 4px, red 0 1px 2px' }, delete: [] } } },
      { el1: { base: { 'box-shadow': 'blue 0 2px 4px, red 0 1px 2px' } } },
    ],
    [
      'box-shadow: unparseable token (currentColor) → falls back, real diff shows',
      { el1: { base: { 'box-shadow': 'currentColor 0 1px 2px' } } },
      { el1: { base: { 'box-shadow': '0 1px 4px currentColor' } } },
      { el1: { base: { set: { 'box-shadow': '0 1px 4px currentColor' }, delete: [] } } },
      { el1: { base: { 'box-shadow': '0 1px 4px currentColor' } } },
    ],
    // ── guardrail 1: every "bucket disappeared in B" is covered ──
    [
      'element removed',
      { el1: { base: { color: 'red' } }, el2: { base: { color: 'blue' } } },
      { el1: { base: { color: 'red' } } },
      { el2: { removed: true } },
      { el1: { base: { color: 'red' } } },
    ],
    [
      'state fully removed',
      { el1: { base: { color: 'red' }, states: { hover: { 'background-color': 'blue' } } } },
      { el1: { base: { color: 'red' } } },
      { el1: { states: { hover: { set: {}, delete: ['background-color'] } } } },
      { el1: { base: { color: 'red' } } },
    ],
    [
      'pseudo fully removed',
      { el1: { base: { color: 'red' }, pseudos: { after: { base: { content: '"x"' } } } } },
      { el1: { base: { color: 'red' } } },
      { el1: { pseudos: { after: { base: { set: {}, delete: ['content'] } } } } },
      { el1: { base: { color: 'red' } } },
    ],
    [
      'relational removed',
      { el2: { base: { color: 'red' }, relational: [{ trigger: 'el1', state: 'hover', combinator: ' ', delta: { opacity: '0' } }] } },
      { el2: { base: { color: 'red' } } },
      { el2: { relational: { remove: [{ trigger: 'el1', state: 'hover', combinator: ' ' }] } } },
      { el2: { base: { color: 'red' } } },
    ],
  ];

  for (const [name, A, B, expectedPatch, expectedApplied] of cases) {
    it(name, () => {
      const patch = diffElements(A, B);
      expect(patch, 'patch.elements').toEqual(expectedPatch);
      const applied = applyStylePatch(sc(A), { elements: patch });
      expect(applied.elements, 'applied.elements').toEqual(expectedApplied);
      // And the applied result is canonically identical to B.
      expect(canonicalStyleJson(applied.elements), 'canonical(applied) == canonical(B)').toEqual(
        canonicalStyleJson(B),
      );
    });
  }

  it('rem-anchor change → rootContext-only patch (elements empty)', () => {
    const A = sc({ el1: { base: { 'font-size': '1rem' } } }, { fontSize: '16px' });
    const B = sc({ el1: { base: { 'font-size': '1rem' } } }, { fontSize: '20px' });
    const patch = diffStyles(A, B);
    expect(patch.elements).toEqual({});
    expect(patch.rootContext).toEqual({ fontSize: '20px' });
    const applied = applyStylePatch(A, patch);
    expect(applied.rootContext).toEqual({ fontSize: '20px' });
    expect(applied.elements).toEqual({ el1: { base: { 'font-size': '1rem' } } });
  });

  // ── rem→px representation-invariant equality (guarded by rootContext) ──
  it('rem==px, SAME rootContext → SUPPRESSED (empty elements patch)', () => {
    // `16px` and `1rem`@16 both resolve to 16px; anchors equal ⇒ safe to suppress.
    const A = sc({ el1: { base: { 'font-size': '16px' } } }, { fontSize: '16px' });
    const B = sc({ el1: { base: { 'font-size': '1rem' } } }, { fontSize: '16px' });
    const patch = diffStyles(A, B);
    expect(patch.elements).toEqual({});
    expect(patch.rootContext).toBeUndefined(); // anchors equal → no rootContext patch
    const applied = applyStylePatch(A, patch);
    expect(applied.elements).toEqual({ el1: { base: { 'font-size': '16px' } } }); // keeps A
  });

  it('rem≠px → SHOWN (real length change)', () => {
    // `12px` vs `0.875rem`@16 = 14px → different render ⇒ must show.
    const A = sc({ el1: { base: { 'font-size': '12px' } } }, { fontSize: '16px' });
    const B = sc({ el1: { base: { 'font-size': '0.875rem' } } }, { fontSize: '16px' });
    const patch = diffStyles(A, B);
    expect(patch.elements).toEqual({ el1: { base: { set: { 'font-size': '0.875rem' }, delete: [] } } });
    const applied = applyStylePatch(A, patch);
    expect(applied.elements).toEqual({ el1: { base: { 'font-size': '0.875rem' } } });
  });

  it('rem-equal-px but DIFFERENT rootContext → SHOWN (guard: re-anchor would break)', () => {
    // A=`1rem`@16=16px, B=`0.8rem`@20=16px: px equal NOW, but apply re-anchors to 20 →
    // `1rem` would become 20px ≠ B. Anchors differ ⇒ token-compare ⇒ show.
    const A = sc({ el1: { base: { 'font-size': '1rem' } } }, { fontSize: '16px' });
    const B = sc({ el1: { base: { 'font-size': '0.8rem' } } }, { fontSize: '20px' });
    const patch = diffStyles(A, B);
    expect(patch.elements).toEqual({ el1: { base: { set: { 'font-size': '0.8rem' }, delete: [] } } });
    expect(patch.rootContext).toEqual({ fontSize: '20px' });
    const applied = applyStylePatch(A, patch);
    expect(applied.elements).toEqual({ el1: { base: { 'font-size': '0.8rem' } } });
    expect(applied.rootContext).toEqual({ fontSize: '20px' }); // re-anchored; 0.8rem@20 = 16px = B
  });

  it('rem→px float noise is rounded (0.3rem@16 == 4.8px → suppressed)', () => {
    // 0.3*16 = 4.800000000000001 in IEEE-754; must still equal an authored 4.8px.
    const A = sc({ el1: { base: { 'margin-top': '4.8px' } } }, { fontSize: '16px' });
    const B = sc({ el1: { base: { 'margin-top': '0.3rem' } } }, { fontSize: '16px' });
    expect(diffStyles(A, B).elements).toEqual({});
  });

  it('pure px, no rem → unaffected by rem logic (equal → empty)', () => {
    const A = sc({ el1: { base: { 'font-size': '16px' } } }, { fontSize: '16px' });
    const B = sc({ el1: { base: { 'font-size': '16px' } } }, { fontSize: '20px' });
    const patch = diffStyles(A, B);
    expect(patch.elements).toEqual({}); // px is anchor-independent → no false diff
  });

  it('composite key includes trigger — two triggers on one subject do not collide', () => {
    const A: StyleJson = {
      bar: {
        relational: [
          { trigger: 'foo', state: 'hover', combinator: ' ', delta: { opacity: '0' } },
          { trigger: 'baz', state: 'hover', combinator: ' ', delta: { color: 'red' } },
        ],
      },
    };
    // B changes only the `baz`-triggered entry; the `foo`-triggered one is untouched.
    const B: StyleJson = {
      bar: {
        relational: [
          { trigger: 'foo', state: 'hover', combinator: ' ', delta: { opacity: '0' } },
          { trigger: 'baz', state: 'hover', combinator: ' ', delta: { color: 'green' } },
        ],
      },
    };
    const patch = diffElements(A, B);
    expect(patch).toEqual({
      bar: { relational: { upsert: [{ trigger: 'baz', state: 'hover', combinator: ' ', delta: { color: 'green' } }] } },
    });
    const applied = applyStylePatch(sc(A), { elements: patch });
    expect(canonicalStyleJson(applied.elements)).toEqual(canonicalStyleJson(B));
  });

  it('identical inputs → empty patch (no false diff)', () => {
    const J: StyleJson = {
      el1: {
        base: { color: 'red', padding: '8px' },
        states: { hover: { 'background-color': 'blue' } },
        pseudos: { after: { base: { content: '"x"' } } },
      },
    };
    expect(diffElements(J, structuredClone(J))).toEqual({});
  });
});
