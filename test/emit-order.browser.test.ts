// The rendered half of the emission-order contract (unit half: emit-order.test.ts).
//
// Witness shape, taken from a real dialog: a preflight `border:0 solid`, a card
// rule with `border:1px solid grey`, and later rules setting
// `border-color:transparent`. The card is 1px wide and INVISIBLE. The shorthand
// beats the preflight width and loses to the colour, so emitting it first loses
// the width and emitting it last loses the colour — only the cascade order
// renders both.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { reworkHtml, reworkStyles } from '../src/extract.ts';
import { bucketsOutOfEmitOrder } from './util/rules.ts';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

async function computedOn(html: string, sel: string, props: string[]): Promise<string[]> {
  const p = await browser.newPage();
  try {
    await p.setContent(html, { waitUntil: 'load' });
    return await p.$eval(sel, (el, ps) => ps.map((k) => getComputedStyle(el).getPropertyValue(k)), props);
  } finally {
    await p.close();
  }
}

async function reworked(body: string): Promise<string> {
  const p = await browser.newPage();
  try {
    await p.setContent(body, { waitUntil: 'load' });
    return await reworkHtml(p);
  } finally {
    await p.close();
  }
}

// The preflight is spelled in COMPONENT shorthands, which is how the border keys
// come to be created before the `border` that later beats some of them: a
// property is keyed at its first appearance, so `border-color` holds a position
// from the preflight while carrying the value of a much later winner. (A
// `border:0 solid` preflight would key `border` itself first and mask the bug on
// the probe path, which keeps authored shorthands; CDP expands them either way.)
const WITNESS =
  `<!doctype html><html><head><style>` +
  `*,::before,::after{box-sizing:border-box;border-width:0;border-style:solid;border-color:#e4e4e7;margin:0;padding:0}` +
  `.card{position:relative;display:flex;gap:10px;border:1px solid #e4e4e7;background:#fff;border-radius:10px;padding:6px 8px}` +
  `.row{gap:10px;border-color:transparent;background:transparent}` +
  `.sel{border-color:transparent}` +
  `</style></head><body><label id="t" class="card row sel">Extended visit</label></body></html>`;

describe('emission order (cascade) renders a partially-beaten shorthand correctly', () => {
  it('keeps BOTH the width the shorthand wins and the colour it loses', async () => {
    const props = ['border-top-width', 'border-top-color'];
    expect(await computedOn(WITNESS, '#t', props)).toEqual(['1px', 'rgba(0, 0, 0, 0)']); // sanity anchor
    // Before the fix the losing `border` sat last and repainted the border grey.
    expect(await computedOn(await reworked(WITNESS), '#t', props)).toEqual(['1px', 'rgba(0, 0, 0, 0)']);
  });

  // A pseudo-element bucket does NOT go through denoiseResolved, so its own copy
  // of Pass 6b is what keeps a beaten longhand from co-existing with the
  // shorthand that kills it (`expandShorthand` can't model `background`, so the
  // ordinary collapse never sees the pair).
  it('drops a pseudo longhand beaten by an unmodellable shorthand', async () => {
    const body =
      `<!doctype html><html><head><style>` +
      `#t::after{content:"x";display:block;width:10px;height:10px;background-color:blue}` +
      `#t.on::after{content:"x";background:red}` +
      `</style></head><body><div id="t" class="on">host</div></body></html>`;
    // Asserted on the RENDER, not on key names: the CDP matcher expands
    // `background` into longhands and the probe matcher keeps it, so which keys
    // survive is matcher-dependent — what the pseudo paints is not.
    const pseudoBg = async (html: string): Promise<string> => {
      const p = await browser.newPage();
      try {
        await p.setContent(html, { waitUntil: 'load' });
        return await p.$eval('#t', (el) => getComputedStyle(el, '::after').backgroundColor);
      } finally { await p.close(); }
    };
    expect(await pseudoBg(body)).toBe('rgb(255, 0, 0)'); // sanity anchor
    expect(await pseudoBg(await reworked(body))).toBe('rgb(255, 0, 0)');
  });

  // The safety net in `declsToDeclString` must not re-order a bucket that is
  // ALREADY correct. Three shapes where a global depth sort did exactly that: it
  // moved a shorthand past a longhand through a coverage relation it either
  // misjudged (it cannot tell who won the cascade) or inferred via a third
  // property (the logical spellings, which it has no relation for at all).
  it.each([
    {
      name: 'pseudo: a shorthand that BEATS a longhand',
      css: `#t::after{content:"x";display:block;width:20px;height:20px;border-top-color:blue}` +
        `#t.on::after{content:"x";border:4px solid green}`,
      read: (el: Element) => getComputedStyle(el, '::after').borderTopColor,
      want: 'rgb(0, 128, 0)',
    },
    {
      name: 'logical longhand under a physical shorthand',
      css: `#t{margin-inline:10px}#t.on{margin-inline-start:20px}#t.on.x{margin:0}`,
      read: (el: Element) => getComputedStyle(el).marginLeft,
      want: '0px',
    },
    {
      name: 'logical border longhand under a physical shorthand',
      css: `#t{border-inline:2px solid red}#t.on{border-inline-start-color:blue}#t.on.x{border:2px solid green}`,
      read: (el: Element) => getComputedStyle(el).borderLeftColor,
      want: 'rgb(0, 128, 0)',
    },
  ])('leaves a correct bucket alone — $name', async ({ css, read, want }) => {
    const body = `<!doctype html><html><head><style>*{margin:0;padding:0}${css}</style></head>` +
      `<body><div id="t" class="on x">host</div></body></html>`;
    const measure = async (html: string): Promise<string> => {
      const p = await browser.newPage();
      try {
        await p.setContent(html, { waitUntil: 'load' });
        return await p.$eval('#t', read);
      } finally { await p.close(); }
    };
    expect(await measure(body)).toBe(want); // sanity anchor
    expect(await measure(await reworked(body))).toBe(want);
  });

  // The pseudo default is not the baseline when a surviving shorthand the
  // candidate beats re-bases the property (§6's context-dependent default, which
  // the element path answers in `equalsEffectiveBase`).
  it('keeps a pseudo longhand that only coincides with the pseudo default', async () => {
    const body =
      `<!doctype html><html><head><style>` +
      `#t::after{content:"y";display:block;width:20px;height:20px}` +
      `#t.on::after{list-style:square inside}` +
      `#t.on::after{list-style-position:outside}` +
      `</style></head><body><div id="t" class="on">host</div></body></html>`;
    const read = async (html: string): Promise<string> => {
      const p = await browser.newPage();
      try {
        await p.setContent(html, { waitUntil: 'load' });
        return await p.$eval('#t', (el) => getComputedStyle(el, '::after').listStylePosition);
      } finally { await p.close(); }
    };
    expect(await read(body)).toBe('outside'); // sanity anchor
    expect(await read(await reworked(body))).toBe('outside');
  });

  // The lemma that lets `declsToDeclString` keep its re-order as a safety net for
  // provenance-less buckets: on an EXTRACTED bucket the re-order is a no-op. If
  // this ever fails, the net is silently deciding the render and the cascade
  // order is not.
  it('extracted buckets are already in an order the emission re-order agrees with', async () => {
    const p = await browser.newPage();
    let json;
    try {
      await p.setContent(WITNESS, { waitUntil: 'load' });
      json = await reworkStyles(p);
    } finally { await p.close(); }
    expect(bucketsOutOfEmitOrder(json.elements)).toEqual([]);
  });

  // A shorthand that BEATS a co-declared longhand of the same family: a bucket keeping
  // both (Pass 6b not dropping the dead longhand) is exactly what the guard flags.
  it('a longhand the shorthand beats is dropped, so the guard stays quiet', async () => {
    expect(bucketsOutOfEmitOrder({ x: { base: { 'background-color': 'blue', background: 'red' } } }), 'detector')
      .toEqual(['x.base: background-color under background']);
    const p = await browser.newPage();
    let json;
    try {
      await p.setContent(
        `<!doctype html><html><head><style>.box{background-color:blue;list-style-type:square}`
        + `.box.on{background:red;list-style:none}</style></head>`
        + `<body><div id="b" class="box on">x</div></body></html>`,
        { waitUntil: 'load' },
      );
      json = await reworkStyles(p);
    } finally { await p.close(); }
    expect(json.elements.b?.base?.background, 'the winning shorthand is there').toBeTruthy();
    expect(bucketsOutOfEmitOrder(json.elements)).toEqual([]);
  });
});
