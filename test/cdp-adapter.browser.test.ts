// cdp.ts re-implements the two playwright Page members reworkStyles uses
// (`evaluate`, `context().newCDPSession`). Playwright is the oracle: the same page,
// the same browser, extracted once through each, must give identical output.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reworkStyles } from '../src/extract.ts';
import { canonicalStyleJson } from '../src/diff.ts';
import { CdpConnection, CdpPage, attach } from '../src/cdp.ts';
import { extractCss, extractAllCss } from '../src/index.ts';

// Touches every evaluate site class: states (incl. relational), ::placeholder/::marker,
// @font-face, a runtime insertRule (dual-source CSSOM harvest), and a subtree whose root
// inherits a unitless line-height across the cut.
const PAGE = `<!doctype html><html><head><style id="s">
  @font-face { font-family: "Probe Font"; src: local("Arial"); }
  html { font-size: 62.5%; }
  body { font-family: "Probe Font", serif; line-height: 1.5; color: rebeccapurple; }
  .card { display: flex; gap: 4px; padding: 1rem; border: 1px solid #ccc; }
  .b { color: red; padding: 8px 12px; }
  .b:hover { color: blue; }
  .b:focus-visible { outline: 2px solid orange; }
  .card:hover .tag { opacity: 1; }
  .tag { opacity: 0.5; }
  input::placeholder { color: gray; }
  li::marker { color: teal; }
  .b::after { content: "→"; margin-left: 4px; }
</style></head><body>
  <div class="outer"><div class="card">
    <button class="b">Hi</button><span class="tag">x</span>
    <input placeholder="type"><ul><li>one</li></ul>
  </div></div>
  <script>document.getElementById('s').sheet.insertRule('.tag { font-weight: 700; }', 0);</script>
</body></html>`;

let udd: string;
let context: BrowserContext;
let conn: CdpConnection;

beforeAll(async () => {
  udd = await mkdtemp(join(tmpdir(), 'css-snapshot-adapter-'));
  context = await chromium.launchPersistentContext(udd, { args: ['--remote-debugging-port=0'] });
  const [port, path] = (await readFile(join(udd, 'DevToolsActivePort'), 'utf8')).split('\n');
  conn = await CdpConnection.connect(`ws://127.0.0.1:${port}${path}`);
});
afterAll(async () => {
  conn?.close();
  await context?.close();
  await rm(udd, { recursive: true, force: true });
});

async function freshPage(): Promise<Page> {
  const page = await context.newPage();
  await page.setContent(PAGE);
  return page;
}

async function adapterFor(page: Page): Promise<CdpPage> {
  const s = await page.context().newCDPSession(page);
  const { targetInfo } = await s.send('Target.getTargetInfo');
  await s.detach();
  return CdpPage.open(() => attach(conn, targetInfo.targetId));
}

// RAW elements, not canonicalStyleJson: canonicalisation folds the probe-vs-cdp
// representation difference, which would hide a silent probe→cdp fallback on the adapter.
const comparable = (j: Awaited<ReturnType<typeof reworkStyles>>) => ({
  elements: j.elements,
  tree: j.tree,
  fonts: j.fonts,
  widgetCss: j.widgetCss,
  rootContext: j.rootContext,
});

describe('cdp.ts CdpPage drives reworkStyles exactly like a playwright Page', () => {
  it('the fixture tells the two matchers apart (so a silent probe→cdp fallback would show)', async () => {
    const a = await freshPage();
    const b = await freshPage();
    const viaProbe = await reworkStyles(a, { matcher: 'probe' });
    const viaCdp = await reworkStyles(b, { matcher: 'cdp' });
    expect(JSON.stringify(viaProbe.elements)).not.toEqual(JSON.stringify(viaCdp.elements));
    await a.close();
    await b.close();
  });

  for (const matcher of ['probe', 'cdp'] as const) {
    for (const root of [undefined, '.card']) {
      it(`${matcher} matcher, ${root ? 'subtree' : 'whole document'}`, async () => {
        const viaPw = await freshPage();
        const expected = await reworkStyles(viaPw, { root, matcher });
        const other = await freshPage();
        const adapter = await adapterFor(other);
        const actual = await reworkStyles(adapter, { root, matcher });
        await adapter.detach();
        expect(Object.keys(expected.elements).length).toBeGreaterThan(3);
        expect(comparable(actual)).toEqual(comparable(expected));
        await viaPw.close();
        await other.close();
      });
    }
  }

  // The core entry over a foreign session factory (playwright's own CDP sessions here,
  // as a puppeteer or harness factory would be): no CdpConnection involved.
  for (const root of [undefined, '.card']) {
    it(`index.ts ${root ? 'extractCss' : 'extractAllCss'} over a playwright session factory`, async () => {
      const viaPw = await freshPage();
      const expected = await reworkStyles(viaPw, { root, matcher: 'probe' });
      const other = await freshPage();
      const open = () => other.context().newCDPSession(other);
      const actual = root ? await extractCss(open, root, { matcher: 'probe' }) : await extractAllCss(open, { matcher: 'probe' });
      expect(comparable(actual)).toEqual(comparable(expected));
      await viaPw.close();
      await other.close();
    });
  }
});

/** Inspector sheet texts as a fresh session replays them (trustworthy with one sheet). */
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

describe('CdpConnection.abortPending mid-extraction', () => {
  const moments: Array<[string, (method: string, params: any) => boolean]> = [
    // The build itself throws: catch → dispose inside buildProbeMatcher.
    ['right after the probe sheet goes in', (m, p) => m === 'CSS.setStyleSheetText' && !!p.text],
    // The build succeeded and phase-4 forces a state: finally → matcher.dispose, and the
    // force must not outlive the session (the unforce call is not teardown, so it is refused).
    ['on the first forced pseudo-state', (m, p) => m === 'CSS.forcePseudoState' && p.forcedPseudoClasses?.length > 0],
  ];
  for (const [when, trigger] of moments) {
    it(`${when}: unwinds, empties the probe sheet, leaves no forced state, tab extractable`, async () => {
      const [port, path] = (await readFile(join(udd, 'DevToolsActivePort'), 'utf8')).split('\n');
      const own = await CdpConnection.connect(`ws://127.0.0.1:${port}${path}`);
      const send = own.send.bind(own);
      let fired = false;
      own.send = (method: string, params: object = {}, sessionId?: string) => {
        const res = send(method, params, sessionId);
        if (!fired && trigger(method, params)) {
          fired = true;
          void res.then(() => own.abortPending('test abort'), () => {});
        }
        return res;
      };
      const page = await freshPage();
      const s = await page.context().newCDPSession(page);
      const { targetInfo } = await s.send('Target.getTargetInfo');
      await s.detach();
      const adapter = await CdpPage.open(() => attach(own, targetInfo.targetId));
      await expect(reworkStyles(adapter, { matcher: 'probe' })).rejects.toThrow('test abort');
      expect(fired).toBe(true);
      own.close();

      const state = await page.evaluate(() => ({
        czp: [...document.querySelectorAll('*')].some((el) => [...getComputedStyle(el)].some((p) => p.startsWith('--czp'))),
        color: getComputedStyle(document.querySelector('.b')!).color,
      }));
      expect(state).toEqual({ czp: false, color: 'rgb(255, 0, 0)' });
      expect(await inspectorSheets(page)).toEqual(['']);
      const again = await reworkStyles(page, { matcher: 'probe' });
      const fresh = await reworkStyles(await freshPage(), { matcher: 'probe' });
      expect(canonicalStyleJson(again.elements)).toEqual(canonicalStyleJson(fresh.elements));
      await page.close();
    });
  }
});
