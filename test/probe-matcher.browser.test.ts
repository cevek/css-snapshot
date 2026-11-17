// Differential oracle for the probe matcher (src/probe-matcher.ts): the probe path
// vs CDP CSS.getMatchedStylesForNode on the SAME page, per element. Promotes the
// throwaway spike's assertions (t-fhs59y) to a committed test.
//
// Per node we assert, against the browser's own matcher as ground truth:
//   • match SET equality (which author rules matched)          — regular, active only
//   • cascade ORDER equality (glue sort == CDP's returned order)
//   • matchingSelectors equality (which selector-in-list matched)
//   • per-prop WINNER equality (cascadeResolve on each side agrees)
//   • ::before / ::after pseudo-element set equality
//   • under-force marker re-read == getMatchedStylesForNode under forcePseudoState([state])
//
// Oracles: synthetic setContent fixtures
// that EXPLICITLY exercise nested @layer (incl. the parent-direct-vs-sublayer order
// the spike never hit), @media, @container, @supports, and an escaped Tailwind
// arbitrary-variant selector whose specificity is winner-DECISIVE (proving the
// @csstools/selector-specificity dependency — parsel throws → falls back to 0 →
// would flip the winner). The spike's production site is LIVE, NOT reachable
// in CI, so it is deliberately NOT a dependency here.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page, type CDPSession } from 'playwright';
import { buildProbeMatcher, type ProbeElement } from '../src/internal/probe-matcher.ts';
import { cascadeResolve } from '../src/internal/cascade.ts';
import type { MatchedStyles, RuleMatch, PseudoElementMatch } from '../src/internal/cdp-types.ts';
import { walkElements, regularActive, normSel, listKey, multiset, matchedUnderForce } from './probe-test-utils.ts';

const VW = 1000, VH = 800;

// The element list AND the DOM root from ONE DOM.getDocument (a second fetch would
// invalidate these nodeIds), reusing the shared walk (`probe-test-utils`).
async function elementList(client: CDPSession): Promise<{ els: ProbeElement[]; root: any }> {
  const { root } = (await client.send('DOM.getDocument', { depth: -1 })) as any;
  return { els: walkElements(root), root };
}

// SET + ORDER + matchingSelectors parity between two RuleMatch arrays.
function assertRuleParity(probe: RuleMatch[], cdp: RuleMatch[], label: string) {
  const pKeys = probe.map(listKey);
  const cKeys = cdp.map(listKey);
  // SET (multiset, order-independent)
  expect(multiset(pKeys), `${label}: match SET`).toEqual(multiset(cKeys));
  // ORDER (exact sequence — the cascade order is what cascadeResolve trusts)
  expect(pKeys, `${label}: cascade ORDER`).toEqual(cKeys);
  // matchingSelectors, grouped by selector-list key (handles duplicate list texts)
  const bySel = (arr: RuleMatch[]) => {
    const m = new Map<string, string[]>();
    for (const rm of arr) {
      const k = listKey(rm);
      (m.get(k) || m.set(k, []).get(k)!).push([...rm.matchingSelectors].sort((a, b) => a - b).join(','));
    }
    for (const v of m.values()) v.sort();
    return m;
  };
  expect(bySel(probe), `${label}: matchingSelectors`).toEqual(bySel(cdp));
}

// Per-prop WINNER parity: run cascadeResolve on each side (author cascade only) and
// compare the resolved value+importance per property. This is the real seam consumer.
// The CDP side is pre-filtered to regular origin so the INSPECTOR-origin probe sheet's
// own `--m*` markers (cascadeResolve honours 'inspector') don't leak in as winners.
// Values are whitespace-normalised: CDP reserialises `rgb(0,128,0)` → `rgb(0, 128, 0)`,
// but the module preserves the authored text (both canonicalise identically downstream).
const normVal = (v: string) => v.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').trim();
// CDP's getMatchedStylesForNode expands shorthands into rangeless longhand entries
// (`border-color:#e5e7eb` → a rangeless `border-left-color:rgb(...)`, etc.); css-tree's
// declared parse emits only the authored shorthand. Keep only range-BEARING (physically
// declared) properties so both sides compare at the DECLARED level (downstream
// expandShorthand/denoise reconciles representation — that's the Track I end-to-end check).
function declaredOnly(rms: RuleMatch[]): RuleMatch[] {
  return rms.map((rm) => ({
    ...rm,
    rule: { ...rm.rule, style: { cssProperties: rm.rule.style.cssProperties.filter((p) => (p as any).range != null) } },
  }));
}
function assertWinnerParity(probe: MatchedStyles, cdpMatched: RuleMatch[], label: string) {
  const wp = cascadeResolve(probe.matchedCSSRules || [], undefined, undefined);
  const wc = cascadeResolve(declaredOnly(cdpMatched), undefined, undefined);
  const flat = (m: Map<string, { value: string; important: boolean }>) => {
    const o: Record<string, string> = {};
    for (const [k, v] of m) o[k] = `${normVal(v.value)}${v.important ? ' !important' : ''}`;
    return o;
  };
  expect(flat(wp), `${label}: per-prop WINNERS`).toEqual(flat(wc));
}

// ::before / ::after set parity.
function assertPeParity(probe: MatchedStyles, cdpPe: PseudoElementMatch[] | undefined, label: string) {
  for (const type of ['before', 'after'] as const) {
    const p = (probe.pseudoElements || []).find((x) => x.pseudoType === type);
    const c = (cdpPe || []).find((x) => x.pseudoType === type);
    const pKeys = p ? p.matches.map(listKey) : [];
    const cKeys = c ? regularActive(c.matches).map(listKey) : [];
    expect(multiset(pKeys), `${label}: ::${type} SET`).toEqual(multiset(cKeys));
    expect(pKeys, `${label}: ::${type} ORDER`).toEqual(cKeys);
  }
}

// ── shared browser ────────────────────────────────────────────────────────────────
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

async function withPage<T>(load: (page: Page) => Promise<void>, body: (ctx: {
  page: Page; client: CDPSession; els: ProbeElement[]; matcher: Awaited<ReturnType<typeof buildProbeMatcher>>;
}) => Promise<T>): Promise<T> {
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH } });
  const page = await ctx.newPage();
  try {
    await load(page);
    const client = await page.context().newCDPSession(page);
    const { els, root } = await elementList(client);
    const matcher = await buildProbeMatcher(client, page, els, { domRoot: root });
    return await body({ page, client, els, matcher });
  } finally {
    await ctx.close();
  }
}

// ── the whole-page differential (matchedFor vs CDP, at rest) ─────────────────────
async function diffAtRest(ctx: {
  page: Page; client: CDPSession; els: ProbeElement[]; matcher: Awaited<ReturnType<typeof buildProbeMatcher>>;
}, opts: { onlySelector?: string } = {}) {
  const { client, els, matcher } = ctx;
  let checked = 0;
  for (const e of els) {
    const cdp = (await client.send('CSS.getMatchedStylesForNode', { nodeId: e.nodeId })) as any;
    const probe = matcher.matchedFor(e.nodeId);
    const label = `<${e.tag}> node ${e.nodeId}`;
    assertRuleParity(probe.matchedCSSRules || [], regularActive(cdp.matchedCSSRules), label);
    assertWinnerParity(probe, regularActive(cdp.matchedCSSRules), label);
    assertPeParity(probe, cdp.pseudoElements, label);
    checked++;
  }
  return checked;
}

// ── reference page ────────────────────────────────────────────────────────────────
describe('probe-matcher — differential vs CDP getMatchedStylesForNode', () => {

  // ── synthetic fixtures — each DISCRIMINATING (competitors equal-spec/same-state so the
  //    tested axis is the sole tiebreak; a bug can't hide behind another tiebreak) ──

  it('nested @layer: parent-direct vs sublayer + sibling sublayers + block form (order + winner)', async () => {
    // All competitors are single-class (equal specificity), unlayered-free, no states —
    // so @layer order is the SOLE discriminator. If CDP disagrees with cmpLayerKey the
    // winner/order check fails and pins the true direction.
    const html = `<!doctype html><html><head><meta charset=utf-8><style>
      @layer a, b;                        /* declare a before b */
      @layer b { .sib { color: rgb(2,2,2) } }   /* used out of declared order */
      @layer a { .sib { color: rgb(1,1,1) } }   /* b must still win (declared later) */

      @layer outer {
        .nest { color: rgb(10,10,10) }     /* parent-direct rules of outer */
        @layer inner {
          .nest { color: rgb(11,11,11) }   /* outer.inner sublayer */
        }
      }

      @layer p.q { .blk { color: rgb(20,20,20) } }   /* block form a.b */
      @layer p { .blk { color: rgb(21,21,21) } }     /* parent-direct of p */
    </style></head><body>
      <div class="sib">sib</div><div class="nest">nest</div><div class="blk">blk</div>
    </body></html>`;
    await withPage(
      async (page) => { await page.setContent(html, { waitUntil: 'networkidle' }); },
      (ctx) => diffAtRest(ctx),
    );
  });

  it('anonymous @layer {} block: same-block rules share ONE layer (higher specificity wins)', async () => {
    // Two rules in ONE anonymous layer block: `.foo.bar` (spec 2) must beat `.foo` (spec 1)
    // by specificity, NOT lose to it as a "later fake sub-layer". Regression guard for the
    // per-rule anonName() bug (each same-block rule got its own layer index).
    const html = `<!doctype html><html><head><meta charset=utf-8><style>
      @layer { .foo.bar { color: rgb(1,1,1) } .foo { color: rgb(2,2,2) } }
    </style></head><body><div class="foo bar">x</div></body></html>`;
    await withPage(
      async (page) => { await page.setContent(html, { waitUntil: 'networkidle' }); },
      (ctx) => diffAtRest(ctx),
    );
  });

  it('FLAT negated state (:not(:hover)): engine-exact under force, NO risk gate', async () => {
    // `.a:not(:hover)` matches at rest but goes DARK under forced hover (non-monotonic).
    // The under-force marker RE-READ is engine-truth, so it drops `.a:not(:hover)` exactly
    // as CDP does — no synthesis, no gate (the removed `negatedState` flag would have gated
    // the Tailwind Preflight `button:not(:disabled)` reset to the slow CDP path).
    const html = `<!doctype html><html><head><meta charset=utf-8><style>
      .a { color: rgb(0,0,0) }
      .a:hover { color: rgb(0,128,0) }
      .a:not(:hover) { color: rgb(0,0,255) }
    </style></head><body><div class="a" tabindex="0">a</div></body></html>`;
    await withPage(
      async (page) => { await page.setContent(html, { waitUntil: 'networkidle' }); },
      async ({ client, els, matcher }) => {
        expect(matcher.risk.mustFallbackToCdp).toBe(false);
        // at rest: matchedFor still matches `.a` + `.a:not(:hover)` (both sides agree)
        await diffAtRest({ page: null as any, client, els, matcher });
        // under forced hover: the marker re-read must equal CDP (drops `.a:not(:hover)`).
        // Read the probe markers WHILE forced (mirrors the driver's phase-4 piggyback).
        const target = els.find((e) => e.tag === 'DIV')!;
        await client.send('CSS.forcePseudoState', { nodeId: target.nodeId, forcedPseudoClasses: ['hover'] });
        const cdp = (await client.send('CSS.getMatchedStylesForNode', { nodeId: target.nodeId })) as any;
        const probe = await matchedUnderForce(client, matcher, target.nodeId);
        await client.send('CSS.forcePseudoState', { nodeId: target.nodeId, forcedPseudoClasses: [] });
        const label = 'negated-state @hover';
        assertRuleParity(probe.matchedCSSRules || [], regularActive(cdp.matchedCSSRules), label);
        assertWinnerParity(probe, regularActive(cdp.matchedCSSRules), label);
      },
    );
  });

  it('NESTED negated state (:not(:is(:hover))): engine-exact under force, NO risk gate', async () => {
    // A state nested inside a functional pseudo within `:not()` was UNPROVEN under the old
    // static synthesis (it flagged `negatedState` → phase-4 CDP fallback). The under-force
    // marker re-read evaluates it via the real engine, so it is now EXACT with no gate.
    const html = `<!doctype html><html><head><meta charset=utf-8><style>
      .b { color: rgb(0,0,0) }
      .b:not(:is(:hover)) { color: rgb(0,0,255) }
    </style></head><body><div class="b" tabindex="0">b</div></body></html>`;
    await withPage(
      async (page) => { await page.setContent(html, { waitUntil: 'networkidle' }); },
      async ({ client, els, matcher }) => {
        expect(matcher.risk.mustFallbackToCdp, 'nested negation stays on probe').toBe(false);
        const target = els.find((e) => e.tag === 'DIV')!;
        await client.send('CSS.forcePseudoState', { nodeId: target.nodeId, forcedPseudoClasses: ['hover'] });
        const cdp = (await client.send('CSS.getMatchedStylesForNode', { nodeId: target.nodeId })) as any;
        const probe = await matchedUnderForce(client, matcher, target.nodeId);
        await client.send('CSS.forcePseudoState', { nodeId: target.nodeId, forcedPseudoClasses: [] });
        const label = 'nested-negated-state @hover';
        assertRuleParity(probe.matchedCSSRules || [], regularActive(cdp.matchedCSSRules), label);
        assertWinnerParity(probe, regularActive(cdp.matchedCSSRules), label);
      },
    );
  });

  it('@media / @container / @supports: only true-condition rules match, ordered vs CDP', async () => {
    const html = `<!doctype html><html><head><meta charset=utf-8><style>
      @media (min-width: 300px) { .m { color: rgb(0,128,0) } }   /* TRUE at 1000 */
      @media (min-width: 5000px){ .m { color: rgb(255,0,0) } }   /* FALSE */

      @supports (display: grid)      { .s { outline-color: rgb(0,128,0) } }  /* TRUE */
      @supports (display: ludicrous) { .s { outline-color: rgb(255,0,0) } }  /* FALSE */

      @container (min-width: 400px) { .c { color: rgb(0,128,0) } }   /* TRUE (container 500px) */
      @container (min-width: 900px) { .c { color: rgb(255,0,0) } }   /* FALSE */
    </style></head><body>
      <div class="m">m</div><div class="s">s</div>
      <div style="container-type: inline-size; width: 500px"><div class="c">c</div></div>
    </body></html>`;
    await withPage(
      async (page) => { await page.setContent(html, { waitUntil: 'networkidle' }); },
      (ctx) => diffAtRest(ctx),
    );
  });

  it('escaped Tailwind arbitrary-variant selector: specificity is winner-DECISIVE (proves @csstools dep)', async () => {
    // `.\[\&_svg\]\:x svg` has class+element specificity (1001); it appears BEFORE the
    // plain `svg` rule (spec 1) in source. Correct cascade: the higher-specificity
    // escaped rule WINS despite being earlier. parsel THROWS on the escaped class →
    // falls back to 0 → glue would order it first → the later plain `svg` wins → WRONG.
    // So the WINNER check itself proves @csstools/selector-specificity.
    const html = `<!doctype html><html><head><meta charset=utf-8><style>
      .\\[\\&_svg\\]\\:text svg { color: rgb(0,128,0) }   /* spec 1001, earlier */
      svg { color: rgb(255,0,0) }                          /* spec 1,    later  */
    </style></head><body>
      <div class="[&_svg]:text"><svg width="10" height="10"><rect/></svg></div>
    </body></html>`;
    await withPage(
      async (page) => { await page.setContent(html, { waitUntil: 'networkidle' }); },
      (ctx) => diffAtRest(ctx),
    );
  });

  // ── under-force marker re-read == CDP under forcePseudoState([state]) ──
  it('marker re-read under force == CDP getMatchedStylesForNode under forcePseudoState([state])', async () => {
    // SELF-state selectors only (the state pseudo is on the tested node's own compound),
    // so forcing the state ON THE NODE is the correct oracle. Includes `.a:hover:focus`
    // to prove the required-set ⊆ {state} exclusion under hover-only, and `.a:hover::after`
    // for pseudo-element-under-state.
    // Covers every DEFAULT_STATES member (hover/focus/focus-visible/active/disabled) so
    // the focus-visible↔focus force interplay is empirically pinned, not assumed.
    const html = `<!doctype html><html><head><meta charset=utf-8><style>
      .a { color: rgb(0,0,0) }
      .a:hover { color: rgb(0,128,0) }
      .a:focus { color: rgb(0,0,255) }
      .a:focus-visible { color: rgb(0,200,200) }
      .a:active { color: rgb(200,0,0) }
      .a:hover:focus { color: rgb(255,0,255) }   /* must NOT fire under hover-only */
      .a:hover::after { content: "x"; color: rgb(255,128,0) }
      button.b:disabled { color: rgb(128,128,128) }
    </style></head><body>
      <div class="a" tabindex="0">a</div>
      <button class="b">b</button>
    </body></html>`;
    await withPage(
      async (page) => { await page.setContent(html, { waitUntil: 'networkidle' }); },
      async ({ client, els, matcher }) => {
        const states = ['hover', 'focus', 'focus-visible', 'active', 'disabled'];
        for (const e of els) {
          for (const state of states) {
            await client.send('CSS.forcePseudoState', { nodeId: e.nodeId, forcedPseudoClasses: [state] });
            const cdp = (await client.send('CSS.getMatchedStylesForNode', { nodeId: e.nodeId })) as any;
            const probe = await matchedUnderForce(client, matcher, e.nodeId);
            await client.send('CSS.forcePseudoState', { nodeId: e.nodeId, forcedPseudoClasses: [] });
            const label = `<${e.tag}> node ${e.nodeId} @${state}`;
            assertRuleParity(probe.matchedCSSRules || [], regularActive(cdp.matchedCSSRules), label);
            assertWinnerParity(probe, regularActive(cdp.matchedCSSRules), label);
            assertPeParity(probe, cdp.pseudoElements, label);
          }
        }
      },
    );
  });
});
