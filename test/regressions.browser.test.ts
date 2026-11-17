// Synthetic guards for extraction defects first caught by css-diff's page-capture
// corpus harness. Each pins one class on the RENDERED
// computed value of the reworked document, with an original-side sanity anchor.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { reworkHtml, reworkStyles, jsonToHtml } from '../src/extract.ts';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

const page$ = async (html: string, sel: string, prop: string): Promise<string> => {
  const p = await browser.newPage();
  try {
    await p.setContent(html, { waitUntil: 'load' });
    return await p.$eval(sel, (el, k) => getComputedStyle(el).getPropertyValue(k), prop);
  } finally {
    await p.close();
  }
};

async function bothRendersOf(body: string, sel: string, prop: string): Promise<{ orig: string; reworked: string }> {
  const orig = await page$(body, sel, prop);
  const p1 = await browser.newPage();
  let html: string;
  try {
    await p1.setContent(body, { waitUntil: 'load' });
    html = await reworkHtml(p1);
  } finally {
    await p1.close();
  }
  return { orig, reworked: await page$(html, sel, prop) };
}

/** The same comparison for a SUBTREE extraction: `root` is the cut, `sel` the node read. */
async function subtreeRendersOf(body: string, root: string, sel: string, prop: string): Promise<{ orig: string; reworked: string }> {
  const orig = await page$(body, sel, prop);
  const p1 = await browser.newPage();
  let html: string;
  try {
    await p1.setContent(body, { waitUntil: 'load' });
    html = jsonToHtml(await reworkStyles(p1, { root, states: [] }));
  } finally {
    await p1.close();
  }
  return { orig, reworked: await page$(html, sel, prop) };
}

describe('corpus regressions', () => {
  it('a box-shadow layer whose color is a wide-gamut function survives (t-ns8fxx)', async () => {
    // The word `transparent` INSIDE color-mix()/an oklab color must not read as
    // a transparent layer; only a provably zero-alpha color token may strip.
    const body = `<!doctype html><html><head><style>
      #t{width:40px;height:40px;box-shadow:rgba(0,0,0,0) 0 0 0 0, oklab(0.141 0.001 -0.005 / 0.35) 0 0 0 2px, rgba(17,17,17,0.18) 0 6px 18px 0}
      #u{width:40px;height:40px;box-shadow:color-mix(in oklab, #111 10%, transparent) 0 0 0 1px}
    </style></head><body><div id="t"></div><div id="u"></div></body></html>`;
    const t = await bothRendersOf(body, '#t', 'box-shadow');
    expect(t.orig).toContain('oklab');
    expect(t.reworked).toContain('oklab');            // visible ring layer kept
    expect(t.reworked).not.toMatch(/rgba\(0, 0, 0, 0\)/); // zero-alpha layer still stripped
    const u = await bothRendersOf(body, '#u', 'box-shadow');
    expect(u.reworked).toBe(u.orig);
  });

  it("a disabled control's authored background survives the tag-default drop (t-f3vcn2)", async () => {
    const body = `<!doctype html><html><head><style>
      .bg-white{background-color:#fff}
    </style></head><body><textarea id="t" class="bg-white" disabled></textarea></body></html>`;
    const { orig, reworked } = await bothRendersOf(body, '#t', 'background-color');
    expect(orig).toBe('rgb(255, 255, 255)');
    expect(reworked).toBe('rgb(255, 255, 255)');
  });

  it("a checkbox's authored margin:0 survives — UA defaults are per input type", async () => {
    // A checkbox's UA margin is 3px 3px 3px 4px; measuring the tag default on
    // a bare (text) <input> reads the preflight margin:0 as "== default" and
    // drops it, letting the UA margins back in.
    const body = `<!doctype html><html><head><style>
      *{margin:0}
    </style></head><body><label><input id="t" type="checkbox">on</label></body></html>`;
    const { orig, reworked } = await bothRendersOf(body, '#t', 'margin-left');
    expect(orig).toBe('0px');
    expect(reworked).toBe('0px');
  });

  it('a transform-origin fed by an inline custom-prop chain survives (t-kd8psv)', async () => {
    const body = `<!doctype html><html><head><style>
      .pop{transform-origin:var(--menu-origin);transform:scale(1);width:100px;height:50px}
    </style></head><body><div style="--popper-origin: 0% 0px">
      <div id="t" class="pop" style="--menu-origin: var(--popper-origin)">x</div>
    </div></body></html>`;
    const { orig, reworked } = await bothRendersOf(body, '#t', 'transform-origin');
    expect(orig).toBe('0px 0px');
    expect(reworked).toBe('0px 0px');
  });

  it("a root <svg>'s box props (margin) survive — it is a real flex item (t-hgbkn5)", async () => {
    // The svg-layout-noise strip may fire on INNER primitives only: an icon's
    // `ml-1` on the root <svg> is 4px of real row width.
    const body = `<!doctype html><html><head><style>
      #t{display:inline-flex}
      .icon{width:16px;height:16px;margin-left:4px;box-sizing:border-box}
    </style></head><body><button id="t">Add<svg class="icon" viewBox="0 0 16 16"><path d="M2 8h12"/></svg></button></body></html>`;
    const { orig, reworked } = await bothRendersOf(body, '#t svg', 'margin-left');
    expect(orig).toBe('4px');
    expect(reworked).toBe('4px');
  });

  it('whitespace-only text between inline children survives the tree build', async () => {
    // CDP DOM.getDocument silently omits whitespace-only text nodes; the space
    // between two inline-block spans is real layout width.
    const p1 = await browser.newPage();
    let json: Awaited<ReturnType<typeof reworkStyles>>;
    try {
      await p1.setContent(
        `<!doctype html><html><head></head><body><div id="t"><span>a</span> <span>b</span></div></body></html>`,
        { waitUntil: 'load' },
      );
      json = await reworkStyles(p1, { states: [] });
    } finally {
      await p1.close();
    }
    const div = JSON.stringify(json.tree);
    expect(div).toContain('{"text":" "}');
  });

  it('native-widget internal rules pass through (::-webkit-datetime-edit padding)', async () => {
    // Tailwind's preflight strips the UA padding-block off datetime shadow
    // fields; without the verbatim widgetCss pass-through a type=time input
    // renders 2px taller than the original.
    const body = `<!doctype html><html><head><style>
      input{font:inherit;padding:0;border:0;font-size:14px;line-height:21px}
      ::-webkit-datetime-edit{display:inline-flex}
      ::-webkit-datetime-edit,::-webkit-datetime-edit-hour-field,::-webkit-datetime-edit-minute-field{padding-block:0}
      ::-webkit-datetime-edit-fields-wrapper{padding:0}
    </style></head><body><input id="t" type="time" value="08:00"></body></html>`;
    const p0 = await browser.newPage();
    let origH: number, html: string;
    try {
      await p0.setContent(body, { waitUntil: 'load' });
      origH = await p0.$eval('#t', (el) => el.getBoundingClientRect().height);
      html = await reworkHtml(p0);
    } finally {
      await p0.close();
    }
    const p1 = await browser.newPage();
    try {
      await p1.setContent(html, { waitUntil: 'load' });
      const reH = await p1.$eval('#t', (el) => el.getBoundingClientRect().height);
      expect(reH).toBe(origH);
    } finally {
      await p1.close();
    }
  });

  it('an inherited unitless line-height crosses the subtree cut as a factor (t-mansc0)', async () => {
    // Ancestor sets line-height:1.5 ABOVE the cut; the root materialises it.
    // A frozen `27px` would give the 20px-font descendant 27px instead of 30px.
    const body = `<!doctype html><html><head><style>
      body{line-height:1.5;font-size:18px}
      .big{font-size:20px}
      .fixed-anc{line-height:24px}
    </style></head><body>
      <div id="cut"><p class="big" id="t">scaled</p></div>
      <div class="fixed-anc"><div id="cut2"><p class="big" id="u">frozen-correctly</p></div></div>
    </body></html>`;
    const factor = await subtreeRendersOf(body, '#cut', '#t', 'line-height');
    expect(factor.orig).toBe('30px');
    expect(factor.reworked).toBe('30px');
    // A genuinely-fixed inherited length must STAY frozen (24px for every font size).
    const fixed = await subtreeRendersOf(body, '#cut2', '#u', 'line-height');
    expect(fixed.orig).toBe('24px');
    expect(fixed.reworked).toBe('24px');
  });

  // PROBE-ONLY: the cdp matcher receives values Chrome already reserialized to
  // ~6 significant digits (`calc(1/0.75)` → `1.33333`), so the precision is
  // lost before simplifyCalc ever runs — unrecoverable on that path (§10
  // representation class). The probe path reduces the AUTHORED text at
  // precision 12 and must stay exact.
  it.skipIf(process.env.CSS_DIFF_MATCHER === 'cdp')('a unitless line-height division keeps browser precision (t-tapdjv)', async () => {
    // Tailwind text-xs: line-height calc(1/0.75) on font-size 12px must render
    // a 16px line box, not floor a LayoutUnit down to 15.9844px.
    const body = `<!doctype html><html><head><style>
      #t{font-size:12px;line-height:calc(1/0.75);margin:0}
    </style></head><body><p id="t">x</p></body></html>`;
    const { orig, reworked } = await bothRendersOf(body, '#t', 'height');
    expect(orig).toBe('16px');
    expect(reworked).toBe('16px');
  });

  // The two below are SUBTREE-mode guards (`reworkStyles({root})`, §4.6): what
  // the standalone reproduction inherits across the cut. Caught by the subtree
  // corpus harness (test/corpus-subtree.corpus.test.ts).
  it('a currentColor-defaulting inherited colour is not frozen at the subtree root', async () => {
    // `caret-color`'s initial resolves to the element's own `color`, and
    // getComputedStyle reports it already resolved — materialising the ROOT's
    // concrete value would hand it to every descendant.
    const body = `<!doctype html><html><head><style>
      #r{color:#111} #c{color:#f00}
    </style></head><body><div id="r"><span id="c">x</span></div></body></html>`;
    const { orig, reworked } = await subtreeRendersOf(body, '#r', '#c', 'caret-color');
    expect(orig).toBe('rgb(255, 0, 0)');
    expect(reworked).toBe(orig);
  });

  it("the document's `lang` reaches a subtree cut off from <html>", async () => {
    // `-webkit-locale` comes from the `lang` ATTRIBUTE, which sits above the cut.
    const body = `<!doctype html><html lang="en"><body><div id="r"><span id="c">x</span></div></body></html>`;
    const { orig, reworked } = await subtreeRendersOf(body, '#r', '#c', '-webkit-locale');
    expect(orig).toBe('"en"');
    expect(reworked).toBe(orig);
  });
});
