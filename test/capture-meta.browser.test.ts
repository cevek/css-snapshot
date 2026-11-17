// Capture-time meta, the half only a browser can judge: are the VALUES right.
// (Plumbing — who keeps the meta and who must not — is capture-meta.test.ts.)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { reworkStyles, type SelfContainedStyles, type StyleTreeNode } from '../src/extract.ts';
import { INHERITABLE } from '../src/internal/resolve.ts';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

const PAGE =
  `<!doctype html><html><head><style>` +
  `*{margin:0;padding:0;box-sizing:border-box}body{height:3000px}` +
  `#wrap{padding:8px;width:240px;font-size:1.25rem;color:rgb(20,30,40)}` +
  `.row{height:30px;margin-top:5px;background:red;width:100%}` +
  `</style></head><body><div id="wrap"><div class="row" id="a">a</div><div class="row" id="b">b</div></div></body></html>`;

async function capture(opts?: { scrollTo?: number }): Promise<SelfContainedStyles> {
  const p = await browser.newPage({ viewport: { width: 800, height: 600 } });
  try {
    await p.setContent(PAGE, { waitUntil: 'load' });
    if (opts?.scrollTo) await p.evaluate((y) => window.scrollTo(0, y), opts.scrollTo);
    return await reworkStyles(p, { root: '#wrap' });
  } finally {
    await p.close();
  }
}

const byId = (root: StyleTreeNode, id: string): StyleTreeNode | undefined => {
  if (root.id === id) return root;
  for (const c of root.children ?? []) { const f = byId(c, id); if (f) return f; }
  return undefined;
};

describe('capture meta values', () => {
  let json: SelfContainedStyles;
  beforeAll(async () => { json = await capture(); });

  it('geometry is relative to the extraction root, which is the origin', () => {
    // 8 padding + (5 margin + 30) × 2 rows + 8 padding.
    expect(json.tree.rect).toEqual({ x: 0, y: 0, w: 240, h: 86 });
    // 8px root padding, then 5px margin, then the first row's 30px + its margin.
    expect(byId(json.tree, 'a')?.rect).toEqual({ x: 8, y: 13, w: 224, h: 30 });
    expect(byId(json.tree, 'b')?.rect).toEqual({ x: 8, y: 48, w: 224, h: 30 });
  });

  // Root-relative cancels the page scroll for NORMAL-FLOW nodes — which is all
  // this fixture has. A fixed/sticky node, or one in a scrolled container, keeps a
  // scroll-dependent offset by design (README documents it).
  it('normal-flow geometry does not move with the page scroll at capture time', async () => {
    const scrolled = await capture({ scrollTo: 500 });
    expect(scrolled.tree.rect).toEqual(json.tree.rect);
    expect(byId(scrolled.tree, 'a')?.rect).toEqual(byId(json.tree, 'a')?.rect);
  });

  // Subset, not equality: `getPropertyValue` returns '' for a shorthand whose
  // components disagree, and those keys are dropped. The tree ROOT is the one
  // documented exception — it also carries the INHERITABLE set, so an
  // effective-value walk-up always terminates.
  it('computed keys are a SUBSET of the element\'s own base keys', () => {
    const offenders: string[] = [];
    (function walk(n: StyleTreeNode, isRoot: boolean): void {
      if (n.id && n.computed) {
        const allowed = new Set(Object.keys(json.elements[n.id]?.base ?? {}));
        if (isRoot) for (const k of INHERITABLE) allowed.add(k);
        for (const k of Object.keys(n.computed)) if (!allowed.has(k)) offenders.push(`${n.id}.${k}`);
      }
      for (const c of n.children ?? []) walk(c, false);
    })(json.tree, true);
    expect(offenders).toEqual([]);
  });

  it('the root carries the inheritable set so a walk-up terminates', () => {
    for (const k of ['color', 'font-size', 'line-height', 'font-family']) {
      expect(json.tree.computed?.[k], k).toBeDefined();
    }
  });

  it('computed resolves what the authored value hides', () => {
    // The root declares `font-size:1.25rem`; computed carries the px it became.
    expect(json.elements[json.tree.id!]?.base?.['font-size']).toBe('1.25rem');
    expect(json.tree.computed?.['font-size']).toBe('20px');
    // And `width:100%` on a row resolves against the real containing block.
    expect(byId(json.tree, 'a')?.computed?.['width']).toBe('224px');
  });

  it('a node with resolved styles carries meta', () => {
    const missing: string[] = [];
    (function walk(n: StyleTreeNode): void {
      if (n.id && Object.keys(json.elements[n.id]?.base ?? {}).length && !n.computed) missing.push(n.id);
      if (n.tag && !n.rect) missing.push(`${n.id ?? n.tag}:rect`);
      for (const c of n.children ?? []) walk(c);
    })(json.tree);
    expect(missing).toEqual([]);
  });
});
