// reworkStyles must leave the LIVE page as it found it, style-wise: the extraction adapter
// extracts from a tab the agent keeps using (chrome-devtools `get_css_styles`,
// computed-style reads), and the probe matcher's inspector sheet outlives the CDP
// session that injected it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { reworkStyles } from '../src/extract.ts';
import { canonicalStyleJson } from '../src/diff.ts';

const PAGE = `<!doctype html><html><head><style>
  .card { display: flex; gap: 4px; padding: 8px; }
  .b { color: red; }
  .b:hover { color: blue; }
  .card:hover .b { background: yellow; }
</style></head><body>
  <div class="card"><button class="b">Hi</button><span>x</span></div>
</body></html>`;

// `@scope` is a `mustFallbackToCdp` surface: the probe sheet is built, then rejected.
const SCOPE_PAGE = `<!doctype html><html><head><style>
  .b { color: red; }
  @scope (.card) { .b { color: green; } }
</style></head><body>
  <div class="card"><button class="b">Hi</button></div>
</body></html>`;

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

async function czpOnPage(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const hits: string[] = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      for (let i = 0; i < cs.length; i++) if (cs.item(i).startsWith('--czp')) hits.push(`${el.tagName}:${cs.item(i)}`);
    }
    return hits;
  });
}

/** Inspector sheets on the page with their text, as a fresh session's CSS.enable replays
 *  them. Only trustworthy with ONE inspector sheet on the frame: a fresh session reports
 *  every foreign inspector sheet with the text of the last one. */
async function inspectorSheets(page: Page): Promise<string[]> {
  const s = await page.context().newCDPSession(page);
  const ids: string[] = [];
  s.on('CSS.styleSheetAdded', (e) => {
    if (e.header.origin === 'inspector') ids.push(e.header.styleSheetId);
  });
  await s.send('DOM.enable');
  await s.send('CSS.enable');
  const texts = await Promise.all(ids.map(async (styleSheetId) => (await s.send('CSS.getStyleSheetText', { styleSheetId })).text));
  await s.detach();
  return texts;
}

/** A sheet left by a session that is gone, as an aborted extraction leaves its probe. */
async function orphanSheet(page: Page, text: string): Promise<void> {
  const s = await page.context().newCDPSession(page);
  await s.send('DOM.enable');
  await s.send('CSS.enable');
  const frameId = (await s.send('Page.getFrameTree')).frameTree.frame.id;
  const { styleSheetId } = await s.send('CSS.createStyleSheet', { frameId });
  await s.send('CSS.setStyleSheetText', { styleSheetId, text });
  await s.detach();
}

// Lights marker 0 on every element, as a stale probe sheet whose rule 0 matched broadly.
const STALE_PROBE = "@property --czp0{syntax:'*';inherits:false;} *{--czp0:1}";

describe('reworkStyles leaves the page clean (probe matcher)', () => {
  it('the detector sees a --czp marker that is there', async () => {
    const page = await browser.newPage();
    await page.setContent(PAGE);
    await orphanSheet(page, "@property --czp0{syntax:'*';inherits:false;} .b{--czp0:1}");
    expect(await czpOnPage(page)).toEqual(['BUTTON:--czp0']);
    await page.close();
  });

  it('no --czp marker survives the extraction; the probe sheet was injected and emptied', async () => {
    const page = await browser.newPage();
    await page.setContent(PAGE);
    await reworkStyles(page, { matcher: 'probe' });
    expect(await czpOnPage(page)).toEqual([]);
    expect(await inspectorSheets(page)).toEqual(['']);
    await page.close();
  });

  it('a probe build rejected for CDP fallback leaves no marker either', async () => {
    const page = await browser.newPage();
    await page.setContent(SCOPE_PAGE);
    await reworkStyles(page, { matcher: 'probe' });
    expect(await czpOnPage(page)).toEqual([]);
    expect(await inspectorSheets(page)).toEqual(['']);
    await page.close();
  });

  it("another client's inspector sheet keeps applying after the extraction", async () => {
    const page = await browser.newPage();
    await page.setContent(PAGE);
    await orphanSheet(page, '.b { --foreign: 1; }');
    await reworkStyles(page, { matcher: 'probe' });
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.b')!).getPropertyValue('--foreign'))).toBe('1');
    await page.close();
  });

  it('a stale probe sheet left on the page does not leak into a later extraction', async () => {
    const clean = await browser.newPage();
    await clean.setContent(PAGE);
    const expected = await reworkStyles(clean, { matcher: 'probe' });
    const stale = await browser.newPage();
    await stale.setContent(PAGE);
    await orphanSheet(stale, STALE_PROBE);
    const actual = await reworkStyles(stale, { matcher: 'probe' });
    expect(canonicalStyleJson(actual.elements)).toEqual(canonicalStyleJson(expected.elements));
    await clean.close();
    await stale.close();
  });
});
