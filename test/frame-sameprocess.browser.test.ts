// DoD for `reworkStyles({ frame })` on a SAME-PROCESS (same-site) iframe — the
// live web-UI bug: a LEFT iframe loaded from a localhost page of the SAME site as
// the app is NOT out-of-process, so `context.newCDPSession(frame)` throws
// ("This frame does not have a separate CDP session, it is a part of the parent
// frame's session"). The frame-scoped OOPIF path (frame.browser.test.ts) only
// covered cross-site, so same-site fell into the uncovered branch and crashed.
//
// Same-process setup: a DEFAULT Chromium (NO `--site-per-process`), a PARENT and
// CHILD both served from `localhost` (different ports → same eTLD+1 → same site →
// one renderer process → the child shares the parent's CDP session). Extraction
// must reach the child's document from the PAGE session via
// `DOM.getDocument({pierce:true})`, rooting the walk on the frame's content
// document (located by a `frame.evaluate` stamp, not url — see buildReworkModel).
//
// Oracle: canonicalStyleJson(sameProcess.elements) deep-equals a top-level
// control extraction of the same child. Own headless browser (no flags) — NOT
// shared with frame.browser.test.ts (which needs `--site-per-process`).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright';
import { reworkStyles, FRAME_STAMP_PREFIX } from '../src/extract.ts';
import { canonicalStyleJson } from '../src/diff.ts';

const MARKER = 'data-cssdiff-root';
const ROOT_SEL = `[${MARKER}]`;
const VW = 1000, VH = 800;

// Static, JS-free child document — identical style surface to the OOPIF test so
// the two paths are compared on the same ground (color, box model, var(),
// pseudo, nested inheritance).
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
      <p class="body">Resolved through a same-process iframe.</p>
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

describe('reworkStyles({ frame }) — same-process (same-site) iframe extraction', () => {
  let browser: Browser;
  let ctx: BrowserContext;
  let child: { url: string; close: () => void };
  let parent: { url: string; close: () => void };

  beforeAll(async () => {
    // NO `--site-per-process`: a same-site child stays in the parent's process.
    browser = await chromium.launch();
    child = await serve(CHILD_HTML, 'localhost');
    // Parent embeds the child; both on `localhost` (only the port differs) → same
    // site → same renderer process. Parent <html> font-size (20px) differs from
    // the child's (16px) so a regression reading the PARENT document's font-size
    // for `rootFontSize` (instead of the frame's) would diverge from the control.
    const parentHtml = `<!doctype html><html><head><meta charset=utf-8>` +
      `<style>html{font-size:20px}html,body{margin:0}iframe{border:0;display:block}</style></head>` +
      `<body><iframe src="${child.url}" width="${VW}" height="${VH}"></iframe></body></html>`;
    parent = await serve(parentHtml, 'localhost');
    ctx = await browser.newContext({ viewport: { width: VW, height: VH } });
  });

  afterAll(async () => {
    await ctx?.close();
    await browser?.close();
    child?.close();
    parent?.close();
  });

  it('is byte-identical to a top-level control extraction of the same document', async () => {
    // ── Same-process path: load parent, grab the child frame, extract via `frame` ──
    const page: Page = await ctx.newPage();
    await page.goto(parent.url, { waitUntil: 'load' });
    const frame: Frame | undefined = page
      .frames()
      .find((f) => f !== page.mainFrame() && f.url().startsWith(child.url));
    expect(frame, 'child frame present').toBeTruthy();
    await frame!.waitForSelector(ROOT_SEL, { timeout: 15_000 });

    // Guard: this frame really IS same-process — `newCDPSession(frame)` must throw,
    // so the test exercises the same-process branch (not a mislabelled OOPIF).
    await expect(ctx.newCDPSession(frame!)).rejects.toThrow(/separate CDP session/);

    // states:['hover'] exercises the Phase-4 `stateSelTexts` evaluate site.
    // Both sides pinned to CDP: frame mode ships on the CDP path (probe frame
    // support deferred — ARCHITECTURE §4.7/§10, t-4ycjsr); the frame==wholedoc
    // invariant is matcher-orthogonal, so the control uses the SAME matcher.
    const sameProc = await reworkStyles(page, { root: ROOT_SEL, frame, states: ['hover'], matcher: 'cdp' });
    await page.close();

    // ── Control: same child document, loaded top-level, extracted directly ──
    const ctrlPage: Page = await ctx.newPage();
    await ctrlPage.goto(child.url, { waitUntil: 'load' });
    await ctrlPage.waitForSelector(ROOT_SEL, { timeout: 15_000 });
    const control = await reworkStyles(ctrlPage, { root: ROOT_SEL, states: ['hover'], matcher: 'cdp' });
    await ctrlPage.close();

    // Sanity: extraction actually produced styles (guards a silently-empty pass).
    expect(Object.keys(sameProc.elements).length).toBeGreaterThan(0);
    // Oracle: same-process extraction canonically equals the top-level control.
    expect(canonicalStyleJson(sameProc.elements)).toEqual(canonicalStyleJson(control.elements));
    // rem anchor read from the FRAME (16px), not the parent (20px).
    expect(sameProc.rootContext).toEqual(control.rootContext);
  });

  it('does not leak the locator stamp into the emitted tree (whole-frame mode)', async () => {
    // Whole-frame mode (no `root`) walks the frame's <html> as the tree root — the
    // exact node the same-process locator stamps. The stamp is captured in the
    // pierced snapshot before the live-DOM `finally` clears it, so this discriminates
    // a snapshot-side leak that subtree mode (which roots on `.card`) never touches.
    const page: Page = await ctx.newPage();
    await page.goto(parent.url, { waitUntil: 'load' });
    const frame: Frame | undefined = page
      .frames()
      .find((f) => f !== page.mainFrame() && f.url().startsWith(child.url));
    await frame!.waitForSelector(ROOT_SEL, { timeout: 15_000 });
    const json = await reworkStyles(page, { frame, states: [] }); // whole-frame, no root
    await page.close();

    const hasStamp = (n: { attrs?: Record<string, string>; children?: unknown[] }): boolean =>
      Object.keys(n.attrs || {}).some((k) => k.startsWith(FRAME_STAMP_PREFIX)) ||
      (n.children || []).some((c) => hasStamp(c as typeof n));
    // The detector sees a stamp where there is one.
    expect(hasStamp({ children: [{ attrs: { [`${FRAME_STAMP_PREFIX}1`]: '1' } }] })).toBe(true);
    expect(hasStamp(json.tree)).toBe(false);
  });
});
