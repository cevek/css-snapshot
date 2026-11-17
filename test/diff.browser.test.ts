// DoD for the style PATCH (diff.ts) — RENDER-IDENTITY + ROUND-TRIP level.
//
// The pixel oracle only sees the RESTING state, so this file validates the patch
// against real extraction: same-DOM synthetic pairs are extracted for real, and
//   jsonToHtml(applyStylePatch(A, diff(A,B))) is Firefox-pixel-identical to
//   jsonToHtml(B), and canonicalStyleJson(applied) deep-equals canonicalStyleJson(B)
//   (canonicalStyleJson is written independently of diff/apply — a diff bug cannot
//   hide in both the patch and its own equality check).
//
// The GOLDEN BATTERY (pure, no browser) lives in ./diff.test.ts. This is the
// `browser` vitest project (Chromium extraction + Firefox pixel oracle).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, firefox, type Browser } from 'playwright';
import { reworkStyles, jsonToHtml, type SelfContainedStyles } from '../src/extract.ts';
import { diffStyles, applyStylePatch, canonicalStyleJson, parseRootPx } from '../src/diff.ts';
import { screenshot, pixelDiff } from './util/pixel.ts';

// ─────────────────────────────────────────────────────────────────────────────
// RENDER-IDENTITY + ROUND-TRIP — real extraction, Firefox pixel oracle.
// ─────────────────────────────────────────────────────────────────────────────
const VW = 1280;
const VH = 900;

const wrapDoc = (fontSize: string, css: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><style>
  html{font-size:${fontSize}}
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Arial,Helvetica,sans-serif;padding:24px}
  ${css}
</style></head><body>
  <div class="card">
    <h2 class="t">Title</h2>
    <p class="b">Body copy <span class="x">word</span></p>
    <button class="btn">Click</button>
  </div>
</body></html>`;

// Same DOM, different styles (color / length / border / bg / font-size / state).
const CSS_A = `
  .card{padding:8px;background:#ffffff;border:1px solid #cccccc;border-radius:4px;width:320px}
  .t{color:#333333;font-size:20px;margin-bottom:8px}
  .b{color:#666666;line-height:1.4}
  .x{color:red;font-weight:bold}
  .btn{padding:6px 10px;background:#eeeeee;color:#222222;border:1px solid #999999}
  .btn:hover{background:#dddddd;color:#000000}`;
const CSS_B = `
  .card{padding:16px;background:#eeeeee;border:2px solid #999999;border-radius:8px;width:320px}
  .t{color:#111111;font-size:24px;margin-bottom:12px}
  .b{color:#444444;line-height:1.6}
  .x{color:blue;font-weight:600}
  .btn{padding:8px 14px;background:#cccccc;color:#000000;border:1px solid #555555}
  .btn:hover{background:#bbbbbb;color:#111111}`;

async function extract(browser: Browser, html: string, opts?: { root?: string; states?: string[] }): Promise<SelfContainedStyles> {
  const p = await browser.newPage({ viewport: { width: VW, height: VH } });
  await p.setContent(html, { waitUntil: 'load' });
  const json = await reworkStyles(p, opts as any);
  await p.close();
  return json;
}

describe('render-identity + round-trip (whole document)', () => {
  let A: SelfContainedStyles;
  let B: SelfContainedStyles;
  let applied: SelfContainedStyles;
  let shotApplied: Buffer;
  let shotB: Buffer;
  let shotBorig: Buffer;
  const files: string[] = [];

  beforeAll(async () => {
    const cr = await chromium.launch();
    try {
      A = await extract(cr, wrapDoc('100%', CSS_A));
      B = await extract(cr, wrapDoc('100%', CSS_B));
    } finally {
      await cr.close();
    }
    applied = applyStylePatch(A, diffStyles(A, B));

    const fApplied = join(tmpdir(), 'diff_applied.html');
    const fB = join(tmpdir(), 'diff_b.html');
    const fBorig = join(tmpdir(), 'diff_b_orig.html');
    writeFileSync(fApplied, jsonToHtml(applied));
    writeFileSync(fB, jsonToHtml(B));
    writeFileSync(fBorig, wrapDoc('100%', CSS_B));
    files.push(fApplied, fB, fBorig);

    const fx = await firefox.launch();
    try {
      shotApplied = await screenshot(fx, 'file://' + fApplied, { width: VW, height: VH });
      shotB = await screenshot(fx, 'file://' + fB, { width: VW, height: VH });
      shotBorig = await screenshot(fx, 'file://' + fBorig, { width: VW, height: VH });
    } finally {
      await fx.close();
    }
  });

  afterAll(() => {
    for (const f of files) { try { unlinkSync(f); } catch { /* ignore */ } }
  });

  it('sanity anchor: jsonToHtml(B) renders == original B page (fixture is valid)', () => {
    expect(pixelDiff(shotB, shotBorig).pct).toBe(0);
  });

  it('render-identity: applyStylePatch(A, diff(A,B)) renders == B (Firefox 0.000%)', () => {
    expect(pixelDiff(shotApplied, shotB).pct).toBe(0);
  });

  it('round-trip: canonical(applied.elements) == canonical(B.elements)', () => {
    // Resolve each artifact's `rem` against its OWN anchor (lockstep with `valuesEqual`).
    expect(canonicalStyleJson(applied.elements, parseRootPx(applied.rootContext?.fontSize))).toEqual(
      canonicalStyleJson(B.elements, parseRootPx(B.rootContext?.fontSize)),
    );
  });

  it('round-trip: rootContext matches B', () => {
    expect(applied.rootContext).toEqual(B.rootContext);
  });

  it('the patch is non-trivial (the pair actually differs)', () => {
    expect(Object.keys(diffStyles(A, B).elements).length).toBeGreaterThan(0);
  });
});

describe('render-identity — subtree mode (rootContext / rem-anchor patched to B)', () => {
  let A: SelfContainedStyles;
  let B: SelfContainedStyles;
  let applied: SelfContainedStyles;
  let shotApplied: Buffer;
  let shotB: Buffer;
  const files: string[] = [];

  // Same subtree CSS, but the DOCUMENT root font-size differs (62.5% vs 100%) and
  // .t uses `rem` — so correct rendering requires patching rootContext to B's.
  const SUB_CSS = `
    .card{padding:12px;background:#f4f4f4;border:1px solid #ddd;width:300px}
    .t{color:#222;font-size:2rem;margin-bottom:8px}
    .b{color:#555}
    .x{color:teal}
    .btn{padding:6px 10px}`;

  beforeAll(async () => {
    const cr = await chromium.launch();
    try {
      A = await extract(cr, wrapDoc('62.5%', SUB_CSS), { root: '.card', states: [] });
      B = await extract(cr, wrapDoc('100%', SUB_CSS), { root: '.card', states: [] });
    } finally {
      await cr.close();
    }
    applied = applyStylePatch(A, diffStyles(A, B));

    const fApplied = join(tmpdir(), 'diff_sub_applied.html');
    const fB = join(tmpdir(), 'diff_sub_b.html');
    writeFileSync(fApplied, jsonToHtml(applied));
    writeFileSync(fB, jsonToHtml(B));
    files.push(fApplied, fB);

    const fx = await firefox.launch();
    try {
      shotApplied = await screenshot(fx, 'file://' + fApplied, { width: VW, height: VH });
      shotB = await screenshot(fx, 'file://' + fB, { width: VW, height: VH });
    } finally {
      await fx.close();
    }
  });

  afterAll(() => {
    for (const f of files) { try { unlinkSync(f); } catch { /* ignore */ } }
  });

  it('rootContext differs A↔B and the patch carries B\'s', () => {
    expect(A.rootContext?.fontSize).not.toBe(B.rootContext?.fontSize);
    expect(diffStyles(A, B).rootContext).toEqual(B.rootContext);
  });

  it('render-identity: applied renders == B (Firefox 0.000%)', () => {
    expect(pixelDiff(shotApplied, shotB).pct).toBe(0);
  });

  it('round-trip: canonical(applied.elements) == canonical(B.elements)', () => {
    // Resolve each artifact's `rem` against its OWN anchor (lockstep with `valuesEqual`).
    expect(canonicalStyleJson(applied.elements, parseRootPx(applied.rootContext?.fontSize))).toEqual(
      canonicalStyleJson(B.elements, parseRootPx(B.rootContext?.fontSize)),
    );
  });
});

// An EXTRACTED bucket carries its keys in cascade order, but a PATCHED one does
// not: `applyBucket` keeps an existing key's position and appends a new one to
// the tail. So a patch that adds a shorthand `expandShorthand` cannot model
// (`background`) to a bucket whose `background-color` beats it lands that
// shorthand LAST, where it would repaint the element — which is why
// `declsToDeclString` keeps the shorthand-first re-order as a safety net for
// buckets with no cascade provenance. This pins that behaviour on rendered pixels.
describe('apply path: a patched bucket still renders correctly', () => {
  const page = (css: string) =>
    `<!doctype html><html><head><style>*{margin:0;padding:0}` +
    `body{background:#fff}.box{width:200px;height:80px}${css}</style></head><body>` +
    `<div id="t" class="box on">x</div></body></html>`;
  // A: only the longhand. B: adds a LOSING `background` shorthand under the same
  // winning `background-color`, so the patch carries `background` alone.
  const A_CSS = `.box{background-color:#3366ff}`;
  const B_CSS = `.box{background:#ff0000}.box.on{background-color:#3366ff}`;

  let files: string[] = [];
  let shotApplied: Buffer;
  let shotB: Buffer;
  let patched: SelfContainedStyles;
  let A: SelfContainedStyles;
  let B: SelfContainedStyles;

  beforeAll(async () => {
    const cr = await chromium.launch();
    try {
      A = await extract(cr, page(A_CSS));
      B = await extract(cr, page(B_CSS));
    } finally {
      await cr.close();
    }
    patched = applyStylePatch(A, diffStyles(A, B));

    const fApplied = join(tmpdir(), 'apply_order_applied.html');
    const fB = join(tmpdir(), 'apply_order_b.html');
    writeFileSync(fApplied, jsonToHtml(patched));
    writeFileSync(fB, jsonToHtml(B));
    files = [fApplied, fB];

    const fx = await firefox.launch();
    try {
      shotApplied = await screenshot(fx, 'file://' + fApplied, { width: VW, height: VH });
      shotB = await screenshot(fx, 'file://' + fB, { width: VW, height: VH });
    } finally {
      await fx.close();
    }
  });

  afterAll(() => {
    for (const f of files) { try { unlinkSync(f); } catch { /* ignore */ } }
  });

  it('the patch really adds a background declaration (fixture is non-trivial)', () => {
    // Which KEY carries it is matcher-dependent (CDP expands `background` into
    // longhands, probe keeps the authored shorthand), so assert only that the
    // patch touches the background at all; the render assertion below is the
    // matcher-agnostic part.
    const patch = diffStyles(A, B);
    const touched = Object.values(patch.elements).some((e) =>
      Object.keys(e.base?.set ?? {}).some((k) => k.startsWith('background')));
    expect(touched).toBe(true);
  });

  it('render-identity: the patched left renders == B (Firefox 0.000%)', () => {
    expect(pixelDiff(shotApplied, shotB).pct).toBe(0);
  });
});
