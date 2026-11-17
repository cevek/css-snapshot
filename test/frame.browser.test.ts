// DoD for `reworkStyles({ frame })` — extraction from a cross-origin iframe
// (OOPIF) must be byte-identical to extracting the same document top-level.
//
// OOPIF setup (proven by spike t-zj6zs4): a `--site-per-process` Chromium, a
// PARENT page served from `localhost:*` embedding a CHILD served from
// `127.0.0.1:*`. `localhost` and `127.0.0.1` differ by eTLD+1 → cross-site →
// the child renders in its OWN renderer process (a genuine OOPIF), so the
// top-frame CDP session cannot descend into it — only a frame-scoped session
// (`context.newCDPSession(frame)`) can. The child is a STATIC HTML fixture (no
// JS) so both extractions see identical DOM/styles with no render flake.
//
// Oracle: canonicalStyleJson(oopif.elements) deep-equals the same for a
// top-level control extraction of the child. Own headless browser with the
// `--site-per-process` flag — NOT shared with the other test files' launches.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright';
import { reworkStyles } from '../src/extract.ts';
import { canonicalStyleJson } from '../src/diff.ts';

const MARKER = 'data-cssdiff-root';
const ROOT_SEL = `[${MARKER}]`;
const VW = 1000, VH = 800;

// Static, JS-free child document. The marked subtree is flow content (a <div>)
// with a non-trivial style surface (color, box model, var(), pseudo, nested
// inheritance) so a broken frame-scoped extraction would actually diverge.
const CHILD_HTML = `<!doctype html><html><head><meta charset=utf-8><style>
  :root { --brand: #3366ff; --pad: 12px; }
  html { font-size: 16px; }
  body { margin: 0; font-family: Georgia, serif; color: #222; }
  .card { color: var(--brand); background: #f4f6ff; padding: var(--pad) 8px;
          border: 2px solid var(--brand); border-radius: 7px; font-size: 15px; }
  .card .title { font-weight: 700; font-size: 1.2em; letter-spacing: 1px; }
  .card .title:hover { color: crimson; }
  .card .body  { color: #556; line-height: 1.6; }
  .card .body::before { content: "» "; color: gold; }
</style></head><body>
  <main>
    <div class="card" ${MARKER}>
      <h3 class="title">Frame Extraction</h3>
      <p class="body">Resolved through a cross-origin OOPIF.</p>
    </div>
  </main>
</body></html>`;

function serve(html: string, host: string): Promise<{ url: string; close: () => void }> {
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolve) => {
    srv.listen(0, host, () => {
      const { port } = srv.address() as AddressInfo;
      resolve({ url: `http://${host}:${port}/`, close: () => srv.close() });
    });
  });
}

// Strip iframe-blocking response headers so the child embeds. `route.fetch()` +
// `fulfill` (a passthrough that mutates only headers) — never blocks the load.
async function stripFrameHeaders(ctx: BrowserContext) {
  await ctx.route('**/*', async (route) => {
    const resp = await route.fetch().catch(() => null);
    if (!resp) return route.continue();
    const headers = { ...resp.headers() };
    delete headers['x-frame-options'];
    delete headers['content-security-policy'];
    delete headers['content-security-policy-report-only'];
    // `route.fetch()` decodes the body but keeps raw headers — a stale
    // content-encoding/length would corrupt a compressed target (see browser.ts).
    delete headers['content-encoding'];
    delete headers['content-length'];
    const body = await resp.body();
    route.fulfill({ response: resp, headers, body }).catch(() => route.continue());
  });
}

describe('reworkStyles({ frame }) — cross-origin OOPIF extraction', () => {
  let browser: Browser;
  let child: { url: string; close: () => void };
  let parent: { url: string; close: () => void };

  beforeAll(async () => {
    browser = await chromium.launch({ args: ['--site-per-process'] });
    child = await serve(CHILD_HTML, '127.0.0.1');
    // Parent embeds the child by full URL; localhost parent vs 127.0.0.1 child
    // → cross-site → the child is a real OOPIF.
    // Parent <html> font-size differs from the child's (20px vs 16px) so a
    // regression reading the PARENT document's font-size for `rootFontSize`
    // (instead of the frame's) would diverge from the control.
    const parentHtml = `<!doctype html><html><head><meta charset=utf-8>` +
      `<style>html{font-size:20px}html,body{margin:0}iframe{border:0;display:block}</style></head>` +
      `<body><iframe src="${child.url}" width="${VW}" height="${VH}"></iframe></body></html>`;
    parent = await serve(parentHtml, 'localhost');
  });

  afterAll(async () => {
    await browser?.close();
    child?.close();
    parent?.close();
  });

  it('is byte-identical to a top-level control extraction of the same document', async () => {
    const ctx = await browser.newContext({ viewport: { width: VW, height: VH } });
    await stripFrameHeaders(ctx);

    // ── OOPIF path: load parent, grab the child frame, extract via `frame` ──
    const page: Page = await ctx.newPage();
    await page.goto(parent.url, { waitUntil: 'load' });
    const frame: Frame | undefined = page
      .frames()
      .find((f) => f !== page.mainFrame() && f.url().startsWith(child.url));
    expect(frame, 'child OOPIF frame present').toBeTruthy();
    await frame!.waitForSelector(ROOT_SEL, { timeout: 15_000 });
    // states:['hover'] exercises the Phase-4 `stateSelTexts` evaluate site (a
    // `states:[]` run skips it, so it wouldn't discriminate a regression there).
    // Both sides pinned to the CDP matcher: frame mode ships on the CDP path (the
    // probe matcher's frame support is deferred — ARCHITECTURE §4.7/§10, t-4ycjsr),
    // and the frame==wholedoc invariant is matcher-orthogonal, so the control must
    // use the SAME matcher (else probe-vs-cdp representation differences would fail
    // this byte-level compare — that gap is covered by the differential guard).
    const oopif = await reworkStyles(page, { root: ROOT_SEL, frame, states: ['hover'], matcher: 'cdp' });

    // ── Control: same child document, loaded top-level, extracted directly ──
    const ctrlPage: Page = await ctx.newPage();
    await ctrlPage.goto(child.url, { waitUntil: 'load' });
    await ctrlPage.waitForSelector(ROOT_SEL, { timeout: 15_000 });
    const control = await reworkStyles(ctrlPage, { root: ROOT_SEL, states: ['hover'], matcher: 'cdp' });

    await ctx.close();

    // Sanity: extraction actually produced styles (guards a silently-empty pass).
    expect(Object.keys(oopif.elements).length).toBeGreaterThan(0);
    // Oracle: frame-scoped extraction canonically equals the top-level control.
    expect(canonicalStyleJson(oopif.elements)).toEqual(canonicalStyleJson(control.elements));
    // rem anchor carried out of the frame identically.
    expect(oopif.rootContext).toEqual(control.rootContext);
  });
});
