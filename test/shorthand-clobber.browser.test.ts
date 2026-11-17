// Regression: a shorthand must never clobber a higher-priority longhand kept in
// the extracted map. Both survive as independent per-property cascade winners
// (declared-level map), so the flat `#id{…}` rule's emit order decides the
// render. Two shapes, asserted on the RENDERED computed value (not the emitted
// string), each with an original-page sanity anchor so a broken fixture can't
// read green:
//   A-type — longhand wins (`[attr]` background-color over a base `background`
//            reset): reworked render must keep the longhand (the el48 bug).
//   B-type — shorthand wins (a later `background` over an earlier
//            `background-color`): resolve.ts Pass 6b drops the stale longhand so
//            the shorthand-first emit order stays render-correct (no regression).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { reworkHtml } from '../src/extract.ts';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

/** Original render's computed background-color for the element matched by `sel`. */
async function origBg(body: string, sel: string): Promise<string> {
  const page = await browser.newPage();
  try {
    await page.setContent(body, { waitUntil: 'load' });
    return await page.$eval(sel, (el) => getComputedStyle(el).backgroundColor);
  } finally {
    await page.close();
  }
}

/** Reworked render's computed background-color for `#targetId` (extract → reload → read). */
async function reworkedBg(body: string, targetId: string): Promise<string> {
  const p1 = await browser.newPage();
  let html: string;
  try {
    await p1.setContent(body, { waitUntil: 'load' });
    html = await reworkHtml(p1);
  } finally {
    await p1.close();
  }
  const p2 = await browser.newPage();
  try {
    await p2.setContent(html, { waitUntil: 'load' });
    return await p2.$eval(`#${targetId}`, (el) => getComputedStyle(el).backgroundColor);
  } finally {
    await p2.close();
  }
}

describe('shorthand does not clobber a higher-priority longhand (emit order + Pass 6b)', () => {
  // A-type: the diagnosed el48 shape — a `[data-state=on]` background-color:#fff
  // (higher order) over the button-reset base `background:transparent`.
  const aBody =
    `<!doctype html><html><head><style>` +
    `.tab{background:transparent;padding:10px;display:block}` +
    `.tab[data-state=on]{background-color:#fff}` +
    `</style></head><body>` +
    `<button id="t" class="tab" data-state="on">excl.</button>` +
    `</body></html>`;

  it('A-type: longhand wins → reworked tab stays white', async () => {
    expect(await origBg(aBody, '#t')).toBe('rgb(255, 255, 255)');    // sanity anchor
    expect(await reworkedBg(aBody, 't')).toBe('rgb(255, 255, 255)'); // was transparent (clobbered) before the fix
  });

  // B-type: shorthand wins — a later `background:red` over an earlier
  // `background-color:blue`. Blind shorthand-first emit would render blue; Pass 6b
  // drops the dead longhand so the shorthand-first order still renders red.
  const bBody =
    `<!doctype html><html><head><style>` +
    `.box{background-color:blue;padding:10px;display:block}` +
    `.box.on{background:red}` +
    `</style></head><body>` +
    `<div id="b" class="box on">x</div>` +
    `</body></html>`;

  it('B-type: shorthand wins → reworked box stays red (no regression from emit order)', async () => {
    expect(await origBg(bBody, '#b')).toBe('rgb(255, 0, 0)');    // sanity anchor
    expect(await reworkedBg(bBody, 'b')).toBe('rgb(255, 0, 0)');
  });
});
