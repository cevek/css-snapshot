// Dual-source rule-inventory differential (t-0a7afv): the probe matcher's CSSOM-harvest
// path vs the CDP ground truth on a SYNTHETIC page that reproduces the silent-miss bug.
//
// THE BUG: `CSS.getStyleSheetText` returns a sheet's SOURCE text, which MISSES rules a
// page adds at runtime via `insertRule` on a URL-BACKED sheet (the real Vite/Tailwind dev
// mechanism — CSS is served from a URL, and utilities are inserted into the live CSSOM).
// The call SUCCEEDS, so the miss is silent → a text-only probe drops those rules and
// snapshots a broken (mobile-looking) render. The dual-source inventory detects the
// text-vs-CSSOM count mismatch and HARVESTS the sheet from the live CSSOM instead.
//
// WHY a URL-backed `data:` link (not an inline `<style>`): verified empirically that CDP
// RESERIALIZES the live CSSOM back into `getStyleSheetText` for an inline `<style>` AND a
// constructed sheet (so an inline insertRule IS reflected in the text there) — only a
// URL-backed sheet serves the stale FETCHED source. That is the faithful reproduction.
//
// WHY a whole-extraction canonical compare (not a raw getMatchedStylesForNode selector
// join): native CSS nesting makes the raw join fragile — CDP returns a nested rule as
// `&:hover` + nestingSelectors while the probe desugars it to `:is(.a):hover`, so a
// selector-text key would spuriously mismatch. `canonicalStyleJson` compares the RESOLVED
// per-element winners (representation-agnostic), which is strictly STRONGER (a wrong
// cascade order surfaces as a wrong winner) and sidesteps the entire join-normalization
// surface. The reference-page raw differential lives in probe-matcher.browser.test.ts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { reworkStyles, type StyleJson } from '../src/extract.ts';
import { canonicalStyleJson } from '../src/diff.ts';

// The initial (fetched) source of the URL-backed sheet — only `.base` is present at fetch.
const INITIAL_CSS = '.base{color:rgb(1,2,3)}';
const DATA_HREF = `data:text/css,${encodeURIComponent(INITIAL_CSS)}`;

// A pristine inline `<style>` with AUTHORED native nesting — stays on the text path (its
// text-parse count matches the census), exercising the text-parser `&`-desugar (the
// harvest path exercises nesting too; this covers pristine-text nesting, otherwise
// uncovered). Values chosen so probe (authored) and CDP (reserialized) canonicalise equal.
const PRISTINE_STYLE = '.pris{color:rgb(7,7,7); & .kid{color:rgb(6,6,6)}}';

const HTML = `<!doctype html><html><head>
<link rel="stylesheet" href="${DATA_HREF}">
<style>${PRISTINE_STYLE}</style>
</head><body>
<div class="base grid">grid</div>
<div class="card">card</div>
<div class="wrap"><span class="inner">inner</span></div>
<div class="pris"><span class="kid">kid</span></div>
</body></html>`;

// Load the page, then MUTATE the URL-backed sheet at runtime (the bug scenario). The four
// inserts exercise every dual-source facet: a layout utility (the canonical Tailwind case),
// a FLAT `:hover` (harvested rule, under-force marker re-read), a `::before` (harvested pseudo), and a
// NESTED descendant (harvest-path `&`-desugar).
async function buildPage(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.setContent(HTML, { waitUntil: 'load' });
  // The data: link resolves asynchronously — wait until its CSSOM carries `.base`.
  await page.waitForFunction(() => [...document.styleSheets].some((s) => {
    try { return [...s.cssRules].some((r) => /\.base/.test(r.cssText)); } catch { return false; }
  }));
  await page.evaluate(() => {
    const sheet = [...document.styleSheets].find((s) => (s.href || '').startsWith('data:'))!;
    sheet.insertRule('.grid{grid-template-columns:repeat(3,1fr)}', sheet.cssRules.length);
    sheet.insertRule('.card::before{content:"x";color:rgb(9,8,7)}', sheet.cssRules.length);
    sheet.insertRule('.card:hover{color:rgb(4,5,6)}', sheet.cssRules.length);
    sheet.insertRule('.wrap{& .inner{color:rgb(2,4,8)}}', sheet.cssRules.length);
  });
}

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

async function extract(mode: 'probe' | 'cdp'): Promise<StyleJson> {
  const page = await browser.newPage();
  try {
    await buildPage(page);
    const { elements } = await reworkStyles(page, { matcher: mode, states: ['hover'] });
    return elements;
  } finally {
    await page.close();
  }
}

describe('probe dual-source inventory — CSSOM harvest for runtime-mutated sheets', () => {
  // PRECONDITION (makes the differential DISCRIMINATING): prove the bug is real on this
  // page — the URL-backed sheet's `getStyleSheetText` really MISSES the inserted rule while
  // the live CSSOM has it. If this ever stops holding (a Chromium that reserializes URL
  // sheets), the harvest path is untested and the main assertion is vacuous.
  it('getStyleSheetText silently MISSES the runtime-inserted rule (the CSSOM has it)', async () => {
    const page = await browser.newPage();
    try {
      await buildPage(page);
      const client = await page.context().newCDPSession(page);
      const headers: any[] = [];
      client.on('CSS.styleSheetAdded' as any, (e: any) => headers.push(e.header));
      await client.send('DOM.enable');
      await client.send('CSS.enable');
      await new Promise((r) => setTimeout(r, 200));
      const urlSheet = headers.find((h) => h.origin === 'regular' && (h.sourceURL || '').startsWith('data:'));
      expect(urlSheet, 'the URL-backed author sheet').toBeTruthy();
      const { text } = (await client.send('CSS.getStyleSheetText', { styleSheetId: urlSheet.styleSheetId })) as any;
      // The fetched source is exactly the initial CSS — the inserted utilities are ABSENT.
      expect(text.includes('grid-template-columns'), `text: ${JSON.stringify(text)}`).toBe(false);
      // …yet the live CSSOM census has them (source text 1 rule, CSSOM 5).
      const cssomCount = await page.evaluate(() => {
        const s = [...document.styleSheets].find((sh) => (sh.href || '').startsWith('data:'))!;
        return s.cssRules.length;
      });
      expect(cssomCount).toBeGreaterThan(1);
    } finally {
      await page.close();
    }
  });

  it('dual-source probe == CDP (harvest recovers inserted / pseudo / state / nested rules)', async () => {
    const probe = await extract('probe');
    const cdp = await extract('cdp');
    const cProbe = canonicalStyleJson(probe) as Record<string, unknown>;
    const cCdp = canonicalStyleJson(cdp) as Record<string, unknown>;

    // Every element resolves identically under both matchers (representation-agnostic).
    const ids = [...new Set([...Object.keys(cProbe), ...Object.keys(cCdp)])];
    for (const id of ids) {
      expect(cProbe[id], `#${id} probe vs cdp`).toEqual(cCdp[id]);
    }

    // SANITY ANCHORS (guard a vacuously-green pass where BOTH paths silently miss a rule):
    // the harvested facets actually landed in the probe output.
    const byDecl = (bucket: Record<string, string> | undefined, prop: string) => bucket?.[prop];
    // find the ids carrying each expected class (ids are minted el1.., stable per run)
    const find = (pred: (e: StyleJson[string]) => boolean) => Object.entries(probe).find(([, e]) => pred(e))?.[1];
    const gridEl = find((e) => byDecl(e.base, 'grid-template-columns') != null);
    expect(gridEl?.base?.['grid-template-columns'], 'inserted layout utility recovered').toBe('repeat(3, 1fr)');
    const cardEl = find((e) => e.states?.hover?.['color'] != null && e.pseudos?.before != null);
    expect(cardEl?.states?.hover?.['color'], 'inserted FLAT :hover delta (harvested rule, marker re-read)').toBeTruthy();
    expect(cardEl?.pseudos?.before?.base?.['content'], 'inserted ::before (harvested pseudo)').toBeTruthy();
    // a nested-descendant rule reached its subject in BOTH the harvest (`rgb(2,4,8)`) and
    // pristine text-desugar (`rgb(6,6,6)`) paths (whitespace-robust — authored vs CSSOM).
    const norm = (v: string | undefined) => v?.replace(/\s+/g, '');
    const nestedSubjects = Object.values(probe).filter(
      (e) => norm(e.base?.['color']) === 'rgb(2,4,8)' || norm(e.base?.['color']) === 'rgb(6,6,6)',
    );
    expect(nestedSubjects.length, 'nested-descendant subjects (harvest + pristine text desugar)').toBe(2);
  });

  // A PRISTINE (un-mutated) sheet with a TRAILING declaration AFTER a nested rule — the common
  // Tailwind-v4 `.card{ color; &:hover{} prop }` pattern. Chrome wraps that trailing run in a
  // `CSSNestedDeclarations` (census counts it as an extra rule), so a text parser that folded
  // trailing decls into the parent would count SHORT → `census > text` → the sheet false-
  // harvests → its authored values get swapped for CSSOM-reserialized ones. This asserts the
  // directional detector + count-aligned parseSheet keep it on the TEXT path: the authored,
  // whitespace-free `rgb(7,8,9)` survives (a CSSOM harvest would spatialize it to `rgb(7, 8, 9)`),
  // AND the trailing decl WINS over the leading one (source order preserved).
  it('pristine trailing-decl-after-nesting sheet stays text-parsed (no false harvest)', async () => {
    const runTrail = async (mode: 'probe' | 'cdp') => {
      const page = await browser.newPage();
      try {
        await page.setViewportSize({ width: 1000, height: 800 });
        await page.setContent(
          `<!doctype html><html><head><style>
            .trail{ background-color:rgb(1,2,3); &:hover{color:rgb(9,9,9)} background-color:rgb(7,8,9) }
          </style></head><body><div class="trail">t</div></body></html>`,
          { waitUntil: 'load' },
        );
        return (await reworkStyles(page, { matcher: mode, states: ['hover'] })).elements;
      } finally { await page.close(); }
    };
    const probe = await runTrail('probe');
    const cdp = await runTrail('cdp');
    const el = Object.values(probe).find((e) => e.base?.['background-color']);
    // trailing decl won (source order) AND kept its AUTHORED whitespace-free form (⇒ text-parsed).
    expect(el?.base?.['background-color'], 'trailing decl wins, authored representation kept').toBe('rgb(7,8,9)');
    // render-equal to CDP.
    const cp = canonicalStyleJson(probe) as Record<string, unknown>;
    const cc = canonicalStyleJson(cdp) as Record<string, unknown>;
    for (const id of new Set([...Object.keys(cp), ...Object.keys(cc)])) {
      expect(cp[id], `#${id} probe vs cdp`).toEqual(cc[id]);
    }
  });
});
