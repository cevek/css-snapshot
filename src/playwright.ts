// css-snapshot/playwright: extraction from any playwright (or playwright-core) Chromium page.
// Typed structurally — no `playwright` import — so the consumer's own install, of any
// version, unifies with these types; `test/playwright-adapter.browser.test.ts` asserts
// the real playwright types are assignable. CDP sessions come from the page's own
// `context().newCDPSession()`; `connectOverCDP` is never used (it pushes emulation
// overrides into every tab).

import { reworkStyles, type ExtractionPage, type FrameLike, type SelfContainedStyles } from './extract.ts';
import { newMarkerAttr, stripRootAttr } from './marker.ts';
import type { ExtractOptions } from './index.ts';

export type { ExtractOptions } from './index.ts';
export type { SelfContainedStyles, StyleJson, StyleEntry, StyleTreeNode, NodeRect, Decls } from './extract.ts';

export interface ElementHandleLike {
  evaluate(fn: (el: any, arg: any) => unknown, arg?: any): Promise<unknown>;
  ownerFrame(): Promise<FrameLike | null>;
  dispose(): Promise<void>;
}

export interface LocatorLike {
  elementHandle(): Promise<ElementHandleLike | null>;
}

export interface PageLike extends ExtractionPage {
  locator(selector: string): LocatorLike;
  mainFrame(): FrameLike;
}

/** The subtree rooted at `target`. A string is a playwright selector (`page.locator`),
 *  so both forms resolve with the locator's strictness and auto-wait: exactly one
 *  element. A target inside an iframe is extracted from that frame's document; one
 *  inside a shadow root is not supported and throws (t-e50bh5).
 *  Extraction forces pseudo-states and stamps ids on the live DOM: do not run two
 *  extractions (or other interaction) on one page at once. */
export async function extractCss(
  page: PageLike,
  target: LocatorLike | string,
  opts: ExtractOptions = {},
): Promise<SelfContainedStyles> {
  const locator = typeof target === 'string' ? page.locator(target) : target;
  const handle = await locator.elementHandle();
  if (!handle) throw new Error('extractCss: the target resolved to no element');
  try {
    const frame = await handle.ownerFrame();
    if (!frame) throw new Error('extractCss: the target element has no frame (detached)');
    const attr = newMarkerAttr();
    await handle.evaluate((el: Element, a: string) => el.setAttribute(a, ''), attr);
    try {
      const json = await reworkStyles(page, {
        ...opts,
        root: `[${attr}]`,
        frame: frame === page.mainFrame() ? undefined : frame,
      });
      stripRootAttr(json, attr);
      return json;
    } finally {
      await handle.evaluate((el: Element, a: string) => el.removeAttribute(a), attr).catch(() => {});
    }
  } finally {
    await handle.dispose().catch(() => {});
  }
}

/** The page's whole main document. Same live-DOM caveats as `extractCss`. */
export async function extractAllCss(page: PageLike, opts: ExtractOptions = {}): Promise<SelfContainedStyles> {
  return reworkStyles(page, opts);
}
