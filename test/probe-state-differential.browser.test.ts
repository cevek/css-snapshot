// FORCE-path differential for the probe matcher (src/probe-matcher.ts).
//
// The committed probe-matcher.browser.test proved AT-REST match-sets (441/441 on the
// reference page). This suite validates the UNDER-FORCE match set. In the engine-truth
// model the matched-under-force set is obtained by RE-READING the raw `--czp` markers
// under `CSS.forcePseudoState` (no static synthesis) — the driver piggybacks this on the
// per-subject computed read (`matchedUnderForce` mirrors it). Because BOTH the probe read
// and CDP `getMatchedStylesForNode` are the SAME real engine under the SAME force, the two
// are EXACT for EVERY state-selector class — `:not(...)` (incl. impure/nested args), states
// inside `:is/:where`, `:has(:state)` — with NO risk gate (the former `negatedState` gate is
// gone). A regression that silently under-/over-matches a forced rule fails here.
//
// The fixtures are the DISCRIMINATORS: each is designed so the forced state TOGGLES a rule,
// so a broken re-read (one that ignored the force / returned the at-rest set) would diverge
// from CDP. Relational fixtures force the TRIGGER and read the SUBJECT — exactly as the
// driver forces triggers and reads subjects.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { buildProbeMatcher } from '../src/internal/probe-matcher.ts';
import { walkElements, regularActive, listKey, bagEq, matchedUnderForce } from './probe-test-utils.ts';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

// `forceSel` = the element to force the state on (the TRIGGER — its own compound for a self
// state, an ancestor/:has-host for a relational one). `readSel` = the subject to read+compare
// (== forceSel for a self state). Every fixture must be EXACT and must NOT gate.
interface Fixture { name: string; css: string; forceSel: string; state: string; readSel: string; }

const FIXTURES: Fixture[] = [
  // Pure `:not(:state)` on the subject compound (Tailwind Preflight `button:not(:disabled)`).
  { name: 'pure :not(:disabled) .s1', css: `.s1{color:#000} .s1:not(:disabled){color:rgb(1,2,3)}`, forceSel: '.s1', state: 'disabled', readSel: '.s1' },
  // Positive state + negated state in one compound (old strip → `:not()` invalid → MISS).
  { name: 'positive+negated .s2:focus:not(:hover)', css: `.s2{color:#000} .s2:focus:not(:hover){color:rgb(0,0,255)}`, forceSel: '.s2', state: 'focus', readSel: '.s2' },
  // Negated + positive (old strip dropped both tokens → no probe).
  { name: 'negated+positive button.s3:not(:disabled):hover', css: `button.s3{color:#000} button.s3:not(:disabled):hover{color:rgb(0,128,0)}`, forceSel: '.s3', state: 'hover', readSel: '.s3' },
  // Negation in a NON-subject compound — RELATIONAL: force the ANCESTOR, read the subject.
  // Under force-hover-on-.anc the rule un-matches (`.anc:not(:hover)` false); both engine
  // reads agree (old selector-wide raw-drop over-dropped).
  { name: 'non-subject-compound .anc:not(:hover) .s4', css: `.s4{color:#000} .anc:not(:hover) .s4{color:rgb(9,9,9)}`, forceSel: '.anc', state: 'hover', readSel: '.s4' },
  // State inside :is() (old token-deletion corrupted `:is(:hover)` → `:is()`).
  { name: 'state in :is() .s5:is(:hover)', css: `.s5{color:#000} .s5:is(:hover){color:rgb(5,5,5)}`, forceSel: '.s5', state: 'hover', readSel: '.s5' },
  // Nested negation inside a functional pseudo within :not (the classic unproven case).
  { name: 'nested :not(:is(:hover)) .s6', css: `.s6{color:#000} .s6:not(:is(:hover)){color:rgb(6,6,6)}`, forceSel: '.s6', state: 'hover', readSel: '.s6' },
  // Impure :not arg (state ∧ structure) on an element matching BOTH — under force the arg is
  // TRUE so :not UN-matches; the old purity-anchored flat drop OVER-KEPT it.
  { name: 'impure :not arg .s7:not(:hover.y)', css: `.s7{color:#000} .s7:not(:hover.y){color:rgb(7,7,7)}`, forceSel: '.s7', state: 'hover', readSel: '.s7' },
  // Tailwind v4 `focus:**:` — state inside `:is(<complex> *)`: focus on `.gp`, styles ALL
  // descendants. RELATIONAL: force focus on the TRIGGER `.gp`, read a descendant subject.
  { name: 'descendant-relational :is(.gp:focus *)', css: `.gp .gd{color:#000} :is(.gp:focus *){color:rgb(1,1,1)}`, forceSel: '.gp', state: 'focus', readSel: '.gd' },
  // `group-has-disabled` — state inside `:has()` on the trigger compound: force disabled on
  // the control inside `.grp`, read a descendant subject. Engine evaluates :has under force.
  { name: 'group-has :has(:disabled)', css: `.grp .hd{color:#000} .grp:has(:disabled) .hd{color:rgb(2,2,2)}`, forceSel: '.grp button', state: 'disabled', readSel: '.hd' },
];

describe('probe-matcher — UNDER-FORCE differential vs CDP (marker re-read, engine-truth)', () => {
  for (const fx of FIXTURES) {
    it(`${fx.name}: marker re-read == CDP-under-force, EXACT, no gate`, async () => {
      const html = `<!doctype html><html><head><meta charset=utf-8><style>${fx.css}</style></head>`
        + `<body><div class="anc"><button class="s3">b</button><span class="s5">z</span>`
        + `<i class="s4">i</i><em class="s6">n</em></div>`
        + `<div class="s1">a</div><div class="s2" tabindex="0">a</div><b class="s7 y">y</b>`
        + `<div class="gp" tabindex="0"><span class="gd">d</span></div>`
        + `<div class="grp"><button>c</button><span class="hd">h</span></div></body></html>`;
      const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
      const page: Page = await ctx.newPage();
      try {
        await page.setContent(html, { waitUntil: 'networkidle' });
        const client = await page.context().newCDPSession(page);
        await client.send('DOM.enable');
        await client.send('CSS.enable');
        const { root } = (await client.send('DOM.getDocument', { depth: -1 })) as any;
        const els = walkElements(root);
        // Dedicated session for the matcher (CSS.enable replay precondition); the injected
        // sheet SURVIVES the detach, so the under-force marker re-read still works.
        const mClient = await page.context().newCDPSession(page);
        const matcher = await buildProbeMatcher(mClient, page, els, { domRoot: root });
        await mClient.detach().catch(() => {});

        // No state-selector class gates anymore.
        expect(matcher.risk.mustFallbackToCdp, `${fx.name}: must not fall back to CDP`).toBe(false);

        const forceId = (await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: fx.forceSel })).nodeId;
        const readId = (await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: fx.readSel })).nodeId;
        expect(forceId, `${fx.forceSel} resolves`).toBeTruthy();
        expect(readId, `${fx.readSel} resolves`).toBeTruthy();

        // Baseline: the read node's AT-REST match set (proves the force actually toggles it).
        const atRest = (matcher.matchedFor(readId).matchedCSSRules || []).map(listKey);

        await client.send('CSS.forcePseudoState', { nodeId: forceId, forcedPseudoClasses: [fx.state] });
        const cdp = (await client.send('CSS.getMatchedStylesForNode', { nodeId: readId })) as any;
        const probe = await matchedUnderForce(client, matcher, readId);
        await client.send('CSS.forcePseudoState', { nodeId: forceId, forcedPseudoClasses: [] });

        const pKeys = (probe.matchedCSSRules || []).map(listKey);
        const cKeys = regularActive(cdp.matchedCSSRules).map(listKey);
        const detail = `\n  atRest=${JSON.stringify(atRest)}\n  probe=${JSON.stringify(pKeys)}\n  cdp=${JSON.stringify(cKeys)}`;
        expect(bagEq(pKeys, cKeys), `${fx.name} @${fx.state}: probe==CDP under force${detail}`).toBe(true);
        // Discrimination: the forced set differs from at-rest (the state rule toggled), so a
        // re-read that ignored the force would show `atRest` and FAIL the bagEq above.
        expect(bagEq(pKeys, atRest), `${fx.name}: force must TOGGLE the match set${detail}`).toBe(false);
      } finally {
        await ctx.close();
      }
    });
  }

  // The driver CO-FORCES `['focus','focus-visible']` for the focus-visible pass (STATE_FORCE).
  // Pin the marker re-read against CDP under the SAME co-forced set: both `:focus` and
  // `:focus-visible` fire; `:hover:focus` (needs hover too) must NOT.
  it('co-forced [focus, focus-visible]: marker re-read == CDP under the same set', async () => {
    const html = `<!doctype html><html><head><meta charset=utf-8><style>
      .cf { color: rgb(0,0,0) }
      .cf:focus { color: rgb(1,1,1) }
      .cf:focus-visible { color: rgb(2,2,2) }
      .cf:hover:focus { color: rgb(3,3,3) }
    </style></head><body><div class="cf" tabindex="0">c</div></body></html>`;
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    const page: Page = await ctx.newPage();
    try {
      await page.setContent(html, { waitUntil: 'networkidle' });
      const client = await page.context().newCDPSession(page);
      await client.send('DOM.enable');
      await client.send('CSS.enable');
      const { root } = (await client.send('DOM.getDocument', { depth: -1 })) as any;
      const els = walkElements(root);
      const mClient = await page.context().newCDPSession(page);
      const matcher = await buildProbeMatcher(mClient, page, els, { domRoot: root });
      await mClient.detach().catch(() => {});
      const { nodeId } = (await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.cf' })) as any;
      const forced = ['focus', 'focus-visible'];
      await client.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: forced });
      const cdp = (await client.send('CSS.getMatchedStylesForNode', { nodeId })) as any;
      const probe = await matchedUnderForce(client, matcher, nodeId);
      await client.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
      const pKeys = (probe.matchedCSSRules || []).map(listKey);
      const cKeys = regularActive(cdp.matchedCSSRules).map(listKey);
      expect(bagEq(pKeys, cKeys), `probe=${JSON.stringify(pKeys)}\ncdp=${JSON.stringify(cKeys)}`).toBe(true);
      // Sanity: the co-force pulled in `:focus-visible` (not just `:focus`); `:hover:focus` not.
      expect(pKeys.some((k) => k.includes(':focus-visible'))).toBe(true);
      expect(pKeys.some((k) => k.includes(':hover'))).toBe(false);
    } finally {
      await ctx.close();
    }
  });
});
