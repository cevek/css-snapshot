// css-snapshot/playwright (`playwright.ts`): a Locator / selector target is extracted from
// the document it lives in, and the marker attribute that addresses it is gone from both
// the output and the live DOM. Oracle: plain `reworkStyles({ root })` on a fresh page
// (extraction mints ids on the live DOM, so each side gets its own page).
//
// The parent (localhost) holds a `.card` of its own AND two iframes with a differently
// styled `.card`: a same-site child (same-process frame) and a 127.0.0.1 child (cross-site
// → OOPIF under --site-per-process). Extracting the wrong document cannot pass.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type CDPSession, type Frame, type Locator, type Page } from 'playwright';
import { reworkStyles, type ExtractionSession, type FrameLike } from '../src/extract.ts';
import { canonicalStyleJson } from '../src/diff.ts';
import { extractCss, extractAllCss, type LocatorLike, type PageLike } from '../src/playwright.ts';

// Compile-time: the real playwright types satisfy the structural ones the adapter and
// the core are typed with (no `playwright` import there).
const _types = (p: Page, l: Locator, f: Frame, s: CDPSession): void => {
  const page: PageLike = p;
  const loc: LocatorLike = l;
  const frame: FrameLike = f;
  const session: ExtractionSession = s;
  void [page, loc, frame, session];
};
void _types;

const CHILD = `<!doctype html><html><head><style>
  html { font-size: 16px; }
  body { margin: 0; font-family: Georgia, serif; color: #222; }
  .card { color: #3366ff; background: #f4f6ff; padding: 12px 8px; border: 2px solid #3366ff; border-radius: 7px; }
  .card .t { font-weight: 700; }
  .card .t:hover { color: crimson; }
</style></head><body><main><div class="card"><h3 class="t">Frame</h3><p>child body</p></div></main></body></html>`;

const parent = (crossUrl: string) => `<!doctype html><html><head><style>
  body { font-family: Arial, sans-serif; }
  .card { color: green; padding: 4px; border: 1px dashed green; }
  .card b:hover { color: orange; }
  iframe { width: 400px; height: 200px; border: 0; }
</style></head><body>
  <div class="card"><b>main</b> card</div>
  <iframe id="same" src="/child"></iframe>
  <iframe id="cross" src="${crossUrl}"></iframe>
</body></html>`;

let browser: Browser;
const servers: http.Server[] = [];
let parentUrl: string;
let childUrl: string;

function serve(host: string, routes: (path: string) => string): Promise<string> {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(routes(req.url ?? '/'));
  });
  servers.push(srv);
  return new Promise((resolve) => srv.listen(0, host, () => resolve(`http://${host}:${(srv.address() as AddressInfo).port}`)));
}

beforeAll(async () => {
  childUrl = `${await serve('127.0.0.1', () => CHILD)}/`;
  parentUrl = `${await serve('localhost', (p) => (p === '/child' ? CHILD : parent(childUrl)))}/`;
  browser = await chromium.launch({ args: ['--site-per-process'] });
});
afterAll(async () => {
  await browser?.close();
  for (const s of servers) s.close();
});

async function open(url: string): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'load' });
  return page;
}

/** Every frame's live DOM, searched for a leftover marker attribute. */
async function markerLeft(page: Page): Promise<boolean> {
  for (const f of page.frames()) {
    const hit = await f.evaluate(() =>
      [...document.querySelectorAll('*')].some((el) => el.getAttributeNames().some((n) => n.startsWith('data-css-snapshot-extract'))),
    );
    if (hit) return true;
  }
  return false;
}

const comparable = (j: Awaited<ReturnType<typeof reworkStyles>>) => ({
  elements: j.elements,
  tree: j.tree,
  fonts: j.fonts,
  widgetCss: j.widgetCss,
  rootContext: j.rootContext,
});

describe('css-snapshot/playwright', () => {
  it('a main-document Locator and the same selector string both equal reworkStyles({ root })', async () => {
    const oracle = await open(parentUrl);
    const expected = await reworkStyles(oracle, { root: 'body > .card', matcher: 'probe' });
    expect(expected.tree.attrs?.class).toBe('card');

    const a = await open(parentUrl);
    const viaLocator = await extractCss(a, a.locator('body > .card'), { matcher: 'probe' });
    const b = await open(parentUrl);
    const viaString = await extractCss(b, 'body > .card', { matcher: 'probe' });

    expect(comparable(viaLocator)).toEqual(comparable(expected));
    expect(comparable(viaString)).toEqual(comparable(expected));
    expect(await markerLeft(a)).toBe(false);
    expect(await markerLeft(b)).toBe(false);
    for (const p of [oracle, a, b]) await p.close();
  });

  for (const [kind, frameSel] of [['same-process', '#same'], ['cross-origin OOPIF', '#cross']] as const) {
    it(`a Locator inside a ${kind} iframe extracts the iframe's element`, async () => {
      const top = await open(childUrl);
      const expected = await reworkStyles(top, { root: '.card', matcher: 'cdp' });

      const page = await open(parentUrl);
      const actual = await extractCss(page, page.frameLocator(frameSel).locator('.card'), { matcher: 'cdp' });

      expect(Object.keys(actual.elements).length).toBeGreaterThan(1);
      expect(canonicalStyleJson(actual.elements)).toEqual(canonicalStyleJson(expected.elements));
      expect(actual.tree.attrs).toEqual(expected.tree.attrs);
      expect(await markerLeft(page)).toBe(false);
      await top.close();
      await page.close();
    });
  }

  it('an extraction that throws after the stamp still removes the marker', async () => {
    const page = await open(parentUrl);
    const broken: PageLike = Object.assign(Object.create(page) as Page, {
      context: () => ({ newCDPSession: () => Promise.reject(new Error('no session')) }),
    });
    await expect(extractCss(broken, page.locator('body > .card'))).rejects.toThrow('no session');
    expect(await markerLeft(page)).toBe(false);
    await page.close();
  });

  it('extractAllCss equals whole-document reworkStyles', async () => {
    const oracle = await open(parentUrl);
    const expected = await reworkStyles(oracle, { matcher: 'probe' });
    const page = await open(parentUrl);
    const actual = await extractAllCss(page, { matcher: 'probe' });
    expect(comparable(actual)).toEqual(comparable(expected));
    await oracle.close();
    await page.close();
  });
});
