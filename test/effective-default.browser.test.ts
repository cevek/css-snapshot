// Regression: a declaration that merely COINCIDES with the bare-tag UA default
// must survive when a surviving shorthand already re-based the property group.
// The class needs a tag whose UA default is NON-ZERO — form controls
// (`button{border-width:2px;padding:1px 6px}`) under a tailwind-style preflight
// `*{border:0 solid;padding:0}`. Four shapes, each one utility off the same
// preflight, all asserted on the RENDERED computed value (a substring check on
// the emitted CSS would read green even when a later shorthand clobbers the
// longhand), each with an original-page sanity anchor.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { reworkHtml } from '../src/extract.ts';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

const PREFLIGHT = `*,::before,::after{box-sizing:border-box;border:0 solid;padding:0;margin:0}` +
  `button{background:transparent;font:inherit}`;

const page$ = async (html: string, sel: string, prop: string): Promise<string> => {
  const p = await browser.newPage();
  try {
    await p.setContent(html, { waitUntil: 'load' });
    return await p.$eval(sel, (el, k) => getComputedStyle(el).getPropertyValue(k), prop);
  } finally {
    await p.close();
  }
};

/** Build a page whose `<button id="t">` carries `util`, then read `prop` on both renders. */
async function bothRenders(util: string, prop: string): Promise<{ orig: string; reworked: string }> {
  const body =
    `<!doctype html><html><head><style>${PREFLIGHT}.u{${util}}</style></head><body>` +
    `<button id="t" class="u">tab</button></body></html>`;
  const orig = await page$(body, '#t', prop);
  const p1 = await browser.newPage();
  let html: string;
  try {
    await p1.setContent(body, { waitUntil: 'load' });
    html = await reworkHtml(p1);
  } finally {
    await p1.close();
  }
  return { orig, reworked: await page$(html, '#t', prop) };
}

/** Original vs reworked computed value of `prop` on `#t`, for a whole page body. */
async function bothRendersOf(body: string, prop: string): Promise<{ orig: string; reworked: string }> {
  const orig = await page$(body, '#t', prop);
  const p1 = await browser.newPage();
  let html: string;
  try {
    await p1.setContent(body, { waitUntil: 'load' });
    html = await reworkHtml(p1);
  } finally {
    await p1.close();
  }
  return { orig, reworked: await page$(html, '#t', prop) };
}

describe('effective default (a surviving shorthand re-bases the group)', () => {
  // The field witness: `<button class="border-b-2">` — a tab underline that
  // vanished, and 2px of height with it (the same key is lost on the transparent
  // inactive tabs, so the whole strip rendered short).
  it('form D: border-bottom-width survives (the tab-underline witness)', async () => {
    const { orig, reworked } = await bothRenders('border-bottom-width:2px', 'border-bottom-width');
    expect(orig).toBe('2px');     // sanity anchor
    expect(reworked).toBe('2px'); // was 0px (dropped as "== button UA 2px") before the fix
  });

  // `border-2` — the candidate is a SHORTHAND, so this one is decided by Pass 4.
  it('form A: a border-width shorthand survives', async () => {
    const { orig, reworked } = await bothRenders('border-width:2px', 'border-top-width');
    expect(orig).toBe('2px');
    expect(reworked).toBe('2px');
  });

  // `border-s-2` — a LOGICAL longhand re-based by a PHYSICAL shorthand expansion.
  it('form B: a logical border longhand survives', async () => {
    const { orig, reworked } = await bothRenders('border-inline-start-width:2px', 'border-left-width');
    expect(orig).toBe('2px');
    expect(reworked).toBe('2px');
  });

  // `ps-1.5` — same logical↔physical meeting point on padding.
  it('form C: a logical padding longhand survives', async () => {
    const { orig, reworked } = await bothRenders('padding-inline-start:6px', 'padding-left');
    expect(orig).toBe('6px');
    expect(reworked).toBe('6px');
  });

  // Two shorthands covering one slot must not prove each other redundant and both
  // disappear — the UA default would come back. Three shapes, all rendered.
  it('keeps a carrier: preflight margin + a logical margin utility', async () => {
    const body =
      `<!doctype html><html><head><style>${PREFLIGHT}.u{margin-block:0px}</style></head><body>` +
      `<p id="t" class="u">para</p></body></html>`;
    const { orig, reworked } = await bothRendersOf(body, 'margin-top');
    expect(orig).toBe('0px');
    expect(reworked).toBe('0px'); // 16px (the UA <p> margin) when both shorthands vanish
  });

  it('keeps a carrier: preflight padding + a logical padding utility on a list', async () => {
    const body =
      `<!doctype html><html><head><style>${PREFLIGHT}.u{padding-inline:0px}</style></head><body>` +
      `<ul id="t" class="u"><li>x</li></ul></body></html>`;
    const { orig, reworked } = await bothRendersOf(body, 'padding-left');
    expect(orig).toBe('0px');
    expect(reworked).toBe('0px'); // 40px (the UA list indent) when both shorthands vanish
  });

  it('keeps a carrier: border against its own width/style/color shorthands', async () => {
    const body =
      `<!doctype html><html><head><style>` +
      `#t{border:2px solid red;border-width:2px;border-style:solid;border-color:red}` +
      `</style></head><body><button id="t">tab</button></body></html>`;
    const { orig, reworked } = await bothRendersOf(body, 'border-top-color');
    expect(orig).toBe('rgb(255, 0, 0)');
    expect(reworked).toBe('rgb(255, 0, 0)'); // the UA button border when the group empties
  });

  // Under a vertical writing-mode the inline axis is top/bottom, so a logical
  // shorthand must not re-base the physical left/right slot. Both spellings Chrome
  // reports verbatim, `vertical-*` and `sideways-*`, put it there.
  it.each(['vertical-rl', 'sideways-lr'])('does not bridge logical↔physical under %s', async (mode) => {
    const body =
      `<!doctype html><html><head><style>` +
      `#t{writing-mode:${mode};padding-inline:4px;padding-left:4px;background:#eee}` +
      `</style></head><body><div id="t">x</div></body></html>`;
    const { orig, reworked } = await bothRendersOf(body, 'padding-left');
    expect(orig).toBe('4px');
    expect(reworked).toBe('4px');
  });

  // Why OFF and not swapped: the tag defaults on the other side of the comparison
  // are measured in a horizontal iframe, so a logical UA default (`p{margin-block:
  // 1em}`) sits on the wrong physical sides there. A swapped bridge would prove
  // `margin:0` redundant and let the UA margin back in (backlog `t-hv97va`).
  it('keeps a shorthand a horizontally-measured default would call redundant', async () => {
    const body =
      `<!doctype html><html><head><style>` +
      `#t{writing-mode:vertical-rl;margin:0;margin-inline:0;margin-block-start:1px}` +
      `</style></head><body><p id="t">para</p></body></html>`;
    const { orig, reworked } = await bothRendersOf(body, 'margin-left');
    expect(orig).toBe('0px');
    expect(reworked).toBe('0px');
  });

  // The gate reads the element's own computed `writing-mode`, and the computed
  // prop union is collected DOCUMENT-wide — so an ancestor-declared vertical mode
  // reaches the descendant that inherits it.
  it('honours a writing-mode inherited from an ancestor', async () => {
    const body =
      `<!doctype html><html><head><style>` +
      `.wrap{writing-mode:vertical-rl}#t{padding-inline:4px;padding-left:4px;background:#eee}` +
      `</style></head><body><div class="wrap"><div id="t">x</div></div></body></html>`;
    const { orig, reworked } = await bothRendersOf(body, 'padding-left');
    expect(orig).toBe('4px');
    expect(reworked).toBe('4px');
  });

  // The drop itself must stay alive: with no shorthand re-basing the group, a
  // value equal to the UA default is still noise and must not start surviving.
  it('still drops a UA-default value when nothing re-bases the group', async () => {
    const body =
      `<!doctype html><html><head><style>button{border-bottom-width:2px}</style></head><body>` +
      `<button id="t">tab</button></body></html>`;
    const p1 = await browser.newPage();
    let html: string;
    try {
      await p1.setContent(body, { waitUntil: 'load' });
      html = await reworkHtml(p1);
    } finally {
      await p1.close();
    }
    expect(html).not.toContain('border-bottom-width');
  });
});
