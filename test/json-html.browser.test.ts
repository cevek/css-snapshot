// Synthetic guards of the offline rebuild: `jsonToHtml(reworkStyles(page))`.
import { describe, it, expect } from 'vitest';
import { chromium } from 'playwright';
import { reworkHtml, reworkStyles, jsonToHtml, type SelfContainedStyles, type StyleTreeNode } from '../src/extract.ts';
import { styleOf } from './util/rules.ts';

// CDP truncates text-node nodeValue at 10 000 chars; a visible run past that must
// be re-fetched whole.
describe('synthetic guard: long text node round-trips whole', () => {
  it('50007-char <pre> survives extraction and rebuild', async () => {
    const big = 'X'.repeat(50007);
    const body = `<!doctype html><html><body><pre id="t">${big}</pre></body></html>`;
    const cb = await chromium.launch();
    let j: SelfContainedStyles;
    try {
      const pp = await cb.newPage();
      await pp.setContent(body, { waitUntil: 'load' });
      j = await reworkStyles(pp);
      await pp.close();
    } finally {
      await cb.close();
    }
    let treeText: string | null = null;
    const find = (n: StyleTreeNode) => {
      if (treeText) return;
      if (n.text && n.text.startsWith('X')) treeText = n.text;
      for (const c of n.children || []) find(c);
    };
    find(j.tree);
    expect(treeText).not.toBeNull();
    expect(treeText!.length).toBe(50007);
    expect(jsonToHtml(j).includes(big)).toBe(true);
  });
});

// Exercise the `fonts` branch (the reference page embeds 0B of @font-face).
describe('synthetic guard: fonts embedded + injected + <style> parity', () => {
  it('@font-face is captured, injected into jsonToHtml, and parity with reworkHtml', async () => {
    const face = '@font-face{font-family:"TestF";src:url(data:font/woff2;base64,AAAA) format("woff2")}';
    const body = `<!doctype html><html><head><style>${face} .a{font-family:"TestF"}</style></head><body><p class="a">hi</p></body></html>`;
    const cb = await chromium.launch();
    let direct: string;
    let j: SelfContainedStyles;
    try {
      const p1 = await cb.newPage();
      await p1.setContent(body, { waitUntil: 'load' });
      direct = await reworkHtml(p1);
      await p1.close();
      const p2 = await cb.newPage();
      await p2.setContent(body, { waitUntil: 'load' });
      j = await reworkStyles(p2);
      await p2.close();
    } finally {
      await cb.close();
    }
    const hj = jsonToHtml(j);
    const fontsPresent = j.fonts.includes('@font-face') && j.fonts.includes('TestF');
    const inOutput = styleOf(hj).includes('@font-face') && styleOf(hj).includes('TestF');
    const parity = styleOf(direct) === styleOf(hj); // fonts prepend identical in both paths
    expect(fontsPresent).toBe(true);
    expect(inOutput).toBe(true);
    expect(parity).toBe(true);
  });
});
