// Synthetic relational / pseudo / self-state coverage of reworkStyles + reworkHtml.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { reworkHtml, reworkStyles, type StyleJson } from '../src/extract.ts';
import { idRules, extractGeneratedStyle, rulesFromJson, sortedEq } from './util/rules.ts';

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

/** reworkHtml id-rules vs StyleJson round-trip, for a synthetic setContent body. */
async function roundTripCheck(body: string): Promise<void> {
  const pa = await browser.newPage();
  await pa.setContent(body, { waitUntil: 'load' });
  const htmlRules = idRules(extractGeneratedStyle(await reworkHtml(pa)));
  await pa.close();
  const pb = await browser.newPage();
  await pb.setContent(body, { waitUntil: 'load' });
  const { elements: styles } = await reworkStyles(pb);
  await pb.close();
  expect(sortedEq(rulesFromJson(styles), htmlRules).ok).toBe(true);
}

describe('Guard 3: synthetic relational / sibling / self', () => {
  let styles: StyleJson;
  beforeAll(async () => {
    const page = await browser.newPage();
    await page.setContent(
      `<!doctype html><html><head><style>
        .bar{color:blue}
        .foo:hover .bar{color:red}
        .a{color:green}
        .a:hover + .sib{color:orange}
        .btn{color:black}
        .btn:hover{color:white}
      </style></head><body>
        <div class="foo"><span class="bar">x</span></div>
        <div class="a">a</div><em class="sib">s</em>
        <button class="btn">b</button>
      </body></html>`,
      { waitUntil: 'load' },
    );
    ({ elements: styles } = await reworkStyles(page));
    await page.close();
  });

  const findId = (pred: (id: string) => boolean, s: StyleJson) => Object.keys(s).find(pred);

  it('3a: descendant relational .foo:hover .bar (not a self state)', () => {
    const barId = findId((id) => !!styles[id]!.relational?.some((r) => r.delta.color === 'red'), styles);
    expect(barId).toBeDefined();
    const barSelfHover = styles[barId!]!.states?.hover;
    expect(barSelfHover).toBeFalsy(); // bar has NO self states.hover
  });

  it('3b: sibling + .a:hover + .sib', () => {
    const sibId = findId(
      (id) => !!styles[id]!.relational?.some((r) => r.combinator === '+' && r.delta.color === 'orange'),
      styles,
    );
    expect(sibId).toBeDefined();
  });

  it('3c: self .btn:hover → states.hover', () => {
    const btnSelf = findId((id) => styles[id]!.states?.hover?.color === 'white', styles);
    expect(btnSelf).toBeDefined();
  });
});

describe('Guard 4: self pseudo-element state (.x:hover::after)', () => {
  const CSS = `.x::after{content:"BAR";color:blue} .x:hover::after{color:red}`;
  const body = `<!doctype html><html><head><style>${CSS}</style></head><body><span class="x">x</span></body></html>`;

  it('4a: pseudos.after.base + states.hover present', async () => {
    const p1 = await browser.newPage();
    await p1.setContent(body, { waitUntil: 'load' });
    const { elements: styles } = await reworkStyles(p1);
    await p1.close();
    const xId = Object.keys(styles).find((id) => styles[id]!.pseudos?.after);
    const after = xId ? styles[xId]!.pseudos!.after : undefined;
    const okBase = !!(after?.base && after.base.color && /content/.test(JSON.stringify(after.base)));
    const hoverDelta = after?.states?.hover;
    expect(okBase && hoverDelta).toBeTruthy();
  });

  it('4b: reworkHtml emits #id:hover::after', async () => {
    const p2 = await browser.newPage();
    await p2.setContent(body, { waitUntil: 'load' });
    const html = await reworkHtml(p2);
    await p2.close();
    const rule = extractGeneratedStyle(html);
    const hasRule = /#\w+:hover::after\s*\{[^}]*color/.test(rule.replace(/\s+/g, ' '));
    expect(hasRule).toBe(true);
  });

  it('4 round-trip (self pseudo-state): reworkHtml == JSON round-trip', async () => {
    await roundTripCheck(body);
  });

  it('4c: forced :hover on reworked output turns ::after red', async () => {
    const p2 = await browser.newPage();
    await p2.setContent(body, { waitUntil: 'load' });
    const html = await reworkHtml(p2);
    await p2.close();

    const p3 = await browser.newPage();
    await p3.setContent(html, { waitUntil: 'load' });
    const restColor = await p3.evaluate(() => getComputedStyle(document.querySelector('span')!, '::after').color);
    const client = await p3.context().newCDPSession(p3);
    await client.send('DOM.enable');
    await client.send('CSS.enable');
    const { root } = await client.send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'span' });
    await client.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
    const hoverColor = await p3.evaluate(() => getComputedStyle(document.querySelector('span')!, '::after').color);
    await client.detach().catch(() => {});
    await p3.close();
    expect(restColor).toBe('rgb(0, 0, 255)');
    expect(hoverColor).toBe('rgb(255, 0, 0)');
  });
});

describe('Guard 5: relational pseudo-element state (.foo:hover .bar::before)', () => {
  const CSS = `.bar::before{content:"B";color:blue} .foo:hover .bar::before{color:red}`;
  const body = `<!doctype html><html><head><style>${CSS}</style></head><body><div class="foo"><span class="bar">x</span></div></body></html>`;

  it('5a: relational .foo:hover .bar::before, not mis-filed as self', async () => {
    const p1 = await browser.newPage();
    await p1.setContent(body, { waitUntil: 'load' });
    const { elements: styles } = await reworkStyles(p1);
    await p1.close();
    const barId = Object.keys(styles).find((id) => styles[id]!.relational?.some((r) => r.pseudo === 'before'));
    const rel = barId ? styles[barId]!.relational!.find((r) => r.pseudo === 'before') : undefined;
    const okRel = !!(rel && rel.state === 'hover' && rel.combinator === ' ' && rel.delta.color);
    const noSelf = !!(barId && !styles[barId]!.pseudos?.before?.states?.hover);
    expect(okRel).toBe(true);
    expect(noSelf).toBe(true);
  });

  it('5 round-trip (relational pseudo): reworkHtml == JSON round-trip', async () => {
    await roundTripCheck(body);
  });

  it('5b: forced :hover on .foo → .bar::before red', async () => {
    const p2 = await browser.newPage();
    await p2.setContent(body, { waitUntil: 'load' });
    const html = await reworkHtml(p2);
    await p2.close();

    const p3 = await browser.newPage();
    await p3.setContent(html, { waitUntil: 'load' });
    const rest = await p3.evaluate(() => getComputedStyle(document.querySelector('.bar, span')!, '::before').color);
    const client = await p3.context().newCDPSession(p3);
    await client.send('DOM.enable');
    await client.send('CSS.enable');
    const { root } = await client.send('DOM.getDocument', { depth: -1 });
    const { nodeId: fooNode } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'div' });
    await client.send('CSS.forcePseudoState', { nodeId: fooNode, forcedPseudoClasses: ['hover'] });
    const hov = await p3.evaluate(() => getComputedStyle(document.querySelector('.bar, span')!, '::before').color);
    await client.detach().catch(() => {});
    await p3.close();
    expect(rest).toBe('rgb(0, 0, 255)');
    expect(hov).toBe('rgb(255, 0, 0)');
  });
});
