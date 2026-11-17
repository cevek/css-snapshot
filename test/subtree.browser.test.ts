// Ported from verify-subtree.mjs — DoD for reworkStyles({ root }) subtree extraction.
//
// Oracle = COMPUTED-STYLE EQUIVALENCE (not pixel diff — pulling a subtree into a
// fresh containing block legally changes layout-dependent computeds). For every
// element of the reconstructed standalone subtree, getComputedStyle over the
// INHERITABLE set must equal the original.
//
// The page is built so a BROKEN inheritance chain would actually show: inherited
// values above the cut are non-default, and html{font-size:62.5%} makes rem != em
// != px. An inherited UNITLESS line-height is probed and carried across the cut
// as its factor (§9), so the oracle checks line-height on EVERY descendant.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { reworkStyles, jsonToHtml } from '../src/extract.ts';

const ROOT_SEL = '.card';

// Non-layout inherited props to compare. Layout-dependent computeds (width/
// height/position/…) are deliberately excluded — they legally diverge standalone.
const CHECK_PROPS = [
  'color', 'font-family', 'font-size', 'font-weight', 'font-style',
  'letter-spacing', 'word-spacing', 'text-align', 'text-transform',
  'text-indent', 'white-space', 'visibility', 'cursor', 'direction',
  'list-style-type', 'caret-color', 'line-height',
];

const PAGE = `<!doctype html><html><head><style>
  html { font-size: 62.5%; }                       /* 1rem = 10px */
  body { color: rebeccapurple; font-family: Georgia, "Times New Roman", serif;
         letter-spacing: 2px; line-height: 1.5; text-transform: uppercase; margin: 0; }
  .outer { font-size: 20px; padding: 1rem; }        /* OUTSIDE the subtree */
  .card  { font-size: 16px; }                       /* subtree ROOT; em anchors here */
  .title { font-size: 2rem; }                       /* rem → 20px, parent-independent */
  .body  { font-size: 1.5em; }                      /* em → 1.5·16 = 24px */
  .nested{ font-size: 12px; letter-spacing: 4px; }  /* different font-size → line-height caveat */
</style></head><body>
  <div class="outer">
    <div class="card">
      <h2 class="title">Title</h2>
      <p class="body">Body text <span class="nested">nested</span></p>
    </div>
  </div>
</body></html>`;

interface WalkEntry {
  tag: string;
  fontSize: string;
  props: Record<string, string>;
}

// One in-page walk of the subtree at `sel` (root + descendants, document order),
// skipping the tags jsonToHtml's tree strips (script/style/link[stylesheet]), so
// the walk matches the reconstructed doc. An independent oracle by design — it
// does NOT import product internals.
async function walkSubtree(page: Page, content: string, sel: string, props: string[]): Promise<WalkEntry[]> {
  await page.setContent(content, { waitUntil: 'load' });
  return page.evaluate(({ sel, props }) => {
    const skip = new Set(['SCRIPT', 'STYLE']);
    const out: WalkEntry[] = [];
    const walk = (el: Element) => {
      if (el.tagName === 'LINK' && (el.getAttribute('rel') || '').toLowerCase().split(/\s+/).includes('stylesheet')) return;
      if (skip.has(el.tagName)) return;
      const cs = getComputedStyle(el);
      const m: Record<string, string> = {};
      for (const p of props) m[p] = cs.getPropertyValue(p);
      out.push({ tag: el.tagName.toLowerCase(), fontSize: cs.getPropertyValue('font-size'), props: m });
      for (const c of Array.from(el.children)) walk(c);
    };
    const root = document.querySelector(sel);
    if (root) walk(root);
    return out;
  }, { sel, props }) as Promise<WalkEntry[]>;
}

describe('reworkStyles({ root }) subtree — computed-style equivalence DoD', () => {
  let browser: Browser;
  let original: WalkEntry[];
  let standalone: WalkEntry[];
  let hasRootCtx: boolean;

  beforeAll(async () => {
    browser = await chromium.launch();

    // Original
    const p1 = await browser.newPage();
    original = await walkSubtree(p1, PAGE, ROOT_SEL, CHECK_PROPS);
    await p1.close();

    // Extract subtree → JSON → offline HTML
    const p2 = await browser.newPage();
    await p2.setContent(PAGE, { waitUntil: 'load' });
    const json = await reworkStyles(p2, { root: ROOT_SEL, states: [] });
    await p2.close();

    hasRootCtx = !!json.rootContext && typeof json.rootContext.fontSize === 'string';
    const html = jsonToHtml(json);

    // Standalone (reconstructed) — measured by the SAME walkSubtree.
    const p3 = await browser.newPage();
    standalone = await walkSubtree(p3, html, ROOT_SEL, CHECK_PROPS);
    await p3.close();
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('rootContext present with a string font-size', () => {
    expect(hasRootCtx).toBe(true);
  });

  it('element count + per-element INHERITABLE props match original', () => {
    expect(standalone.length).toBe(original.length);
    const rootFont = original[0]!.fontSize; // subtree root's font-size
    for (let i = 0; i < original.length; i++) {
      const o = original[i]!;
      const s = standalone[i]!;
      expect(s.tag, `[${i}] tag`).toBe(o.tag);
      for (const p of CHECK_PROPS) {
        expect(s.props[p], `[${i}] <${o.tag}> ${p}`).toBe(o.props[p]);
      }
    }
  });

  const byTag = (arr: WalkEntry[], tag: string) => arr.find((e) => e.tag === tag);

  it('rem regression: .title 2rem == 20px in both (62.5% root)', () => {
    const titleO = byTag(original, 'h2');
    const titleS = byTag(standalone, 'h2');
    expect(titleO?.fontSize).toBe('20px');
    expect(titleS?.fontSize).toBe('20px');
  });

  it('em anchor: .body 1.5em == 24px in both (materialised root 16px)', () => {
    const bodyO = byTag(original, 'p');
    const bodyS = byTag(standalone, 'p');
    expect(bodyO?.fontSize).toBe('24px');
    expect(bodyS?.fontSize).toBe('24px');
  });
});

// Phase-4 subtree scoping (token pre-filter + subtree-scoped querySelectorAll).
// The whole-doc subtree tests above run with states:[] so they NEVER exercise
// Phase 4; this block does, with states:['hover'], and guards the two invariants
// pure reasoning can't: (1) the subtree ROOT's own self-state survives the
// scoped-QSA-excludes-the-scope-node caveat (root-union), and (2) an in-subtree
// relational trigger is still paired. It also pins the ONE intended divergence
// from whole-doc behaviour (ARCHITECTURE.md §9): an ABOVE-CUT relational trigger
// no longer leaks into the subject's self-state.
describe('reworkStyles({ root }) subtree — Phase-4 state scoping', () => {
  // Stable ids so json.elements can be looked up by name (reworkStyles reuses a
  // unique existing id). `.outer` is ABOVE the `.card` cut.
  const P = `<!doctype html><html><head><style>
    #card:hover        { background: rgb(255,0,0); }        /* (1) ROOT self-hover */
    #item:hover #label { color: rgb(0,128,0); }             /* (2) in-subtree relational */
    .outer:hover #special { color: rgb(255,165,0); }        /* (3) ABOVE-CUT trigger */
    #special:hover     { font-weight: bold; }               /* (3) subject also self-hovered */
    .unrelated:hover   { color: rgb(1,2,3); }               /* pre-filter must drop */
  </style></head><body>
    <div class="outer">
      <div id="card">
        <div id="item"><span id="label">lbl</span></div>
        <span id="special">sp</span>
      </div>
    </div>
    <div class="unrelated">x</div>
  </body></html>`;

  let els: Record<string, any>;
  let browser2: Browser;
  beforeAll(async () => {
    browser2 = await chromium.launch();
    const p = await browser2.newPage();
    await p.setContent(P, { waitUntil: 'load' });
    els = (await reworkStyles(p, { root: '#card', states: ['hover'] })).elements as any;
    await p.close();
  });
  afterAll(async () => { await browser2?.close(); });

  it('(1) subtree ROOT self-state survives scoped QSA (root-union)', () => {
    // Without re-adding the scope node, the scoped querySelectorAll would exclude
    // #card and this delta would vanish.
    expect(els.card?.states?.hover).toBeTruthy();
    expect(JSON.stringify(els.card.states.hover)).toContain('255');
  });

  it('(2) in-subtree relational trigger is paired', () => {
    const rel = els.label?.relational ?? [];
    const hit = rel.find((r: any) => r.trigger === 'item' && r.state === 'hover' && r.combinator === ' ');
    expect(hit, 'relational #item:hover #label').toBeTruthy();
    // Whitespace-agnostic: the probe path emits css-tree's authored `rgb(0,128,0)`,
    // the CDP path Chrome's reserialised `rgb(0, 128, 0)` — render-identical.
    expect(JSON.stringify(hit.delta).replace(/\s/g, '')).toContain('0,128,0');
  });

  it('(3) above-cut relational trigger does NOT leak into self-state (§9)', () => {
    // #special is self-hovered (font-weight) AND targeted by .outer:hover (above
    // the cut). The cut trigger is no longer forced, so its color must NOT appear
    // in #special:hover — the intended, more-correct divergence from whole-doc.
    const sh = els.special?.states?.hover ?? {};
    expect(sh['font-weight']).toBeTruthy();     // own self-state kept
    expect(sh.color).toBeUndefined();           // above-cut effect consistently dropped
  });

  it('unrelated whole-page state selectors never surface in the subtree', () => {
    // `.unrelated` is outside the subtree; its id is absent from the output.
    for (const e of Object.values(els)) {
      expect(JSON.stringify((e as any).states ?? {})).not.toContain('1, 2, 3');
    }
  });
});
