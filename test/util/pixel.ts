// Reusable Firefox-screenshot + pixelmatch comparison util.
//
// Firefox is the pixel oracle: it renders deterministically (self-consistent to
// 0.000%), whereas Chromium has sub-pixel AA noise. Screenshot logic + the
// crop-to-min-dimensions pixelmatch comparison are ported verbatim from the
// original verify-json-html.mjs harness.
//
// Downstream tracks (e.g. apply→render-identical) reuse `screenshot` +
// `pixelDiff` directly: screenshot a page, screenshot the reworked output,
// assert `pixelDiff(a, b).pct === 0`.
import fs from 'node:fs';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { Browser } from 'playwright';

export interface ScreenshotOpts {
  /** Viewport width (default 1280). */
  width?: number;
  /** Viewport height (default 900). */
  height?: number;
  /** Settle delay after networkidle before capture, ms (default 300). */
  settleMs?: number;
}

/** Launch a page in `browser`, load `url`, and return a full-page PNG screenshot. */
export async function screenshot(browser: Browser, url: string, opts: ScreenshotOpts = {}): Promise<Buffer> {
  const { width = 1280, height = 900, settleMs = 300 } = opts;
  const p = await browser.newPage({ viewport: { width, height } });
  await p.goto(url, { waitUntil: 'networkidle' });
  await p.waitForTimeout(settleMs);
  const s = await p.screenshot({ fullPage: true });
  await p.close();
  return s;
}

export interface DiffResult {
  /** Mismatch percentage over the compared (cropped) area, 3-decimal rounded. */
  pct: number;
  /** Raw mismatched-pixel count from pixelmatch. */
  diffPixels: number;
  /** Compared width (min of both images). */
  width: number;
  /** Compared height (min of both images). */
  height: number;
}

export interface PixelDiffOpts {
  /** pixelmatch matching threshold, 0–1 (default 0.1). */
  threshold?: number;
  /** If set, write the diff PNG to this path (for debugging a mismatch). */
  diffPngPath?: string;
}

/**
 * Pixel-diff two PNG buffers. Crops both to their common (min) dimensions before
 * comparing, so differently-sized screenshots still compare over their overlap.
 */
export function pixelDiff(a: Buffer, b: Buffer, opts: PixelDiffOpts = {}): DiffResult {
  const { threshold = 0.1, diffPngPath } = opts;
  const A = PNG.sync.read(a);
  const B = PNG.sync.read(b);
  const w = Math.min(A.width, B.width);
  const h = Math.min(A.height, B.height);
  const crop = (s: PNG): PNG => {
    const o = new PNG({ width: w, height: h });
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const i = (yy * s.width + xx) * 4;
        const j = (yy * w + xx) * 4;
        o.data[j] = s.data[i]!;
        o.data[j + 1] = s.data[i + 1]!;
        o.data[j + 2] = s.data[i + 2]!;
        o.data[j + 3] = s.data[i + 3]!;
      }
    }
    return o;
  };
  const ca = crop(A);
  const cb = crop(B);
  const d = new PNG({ width: w, height: h });
  const mm = pixelmatch(ca.data, cb.data, d.data, w, h, { threshold });
  if (diffPngPath) fs.writeFileSync(diffPngPath, PNG.sync.write(d));
  const pct = Number((mm / (w * h) * 100).toFixed(3));
  return { pct, diffPixels: mm, width: w, height: h };
}
