// css-snapshot core: extraction over raw CDP plus the pure transforms over its result.
// No browser-automation library in this entry's import graph — a page is reached
// through an `OpenSession` factory (see `cdp.ts`). The playwright adapter is the
// `css-snapshot/playwright` entry (`playwright.ts`).

import { CdpPage, type OpenSession } from './cdp.ts';
import { reworkStyles, type ReworkStylesOptions, type SelfContainedStyles } from './extract.ts';

export type ExtractOptions = Omit<ReworkStylesOptions, 'root' | 'frame'>;

/** The subtree rooted at the first element matching `selector` in the page's main
 *  document. Extraction forces pseudo-states and stamps ids on the live DOM: do not run
 *  two extractions (or other page interaction) on one page at once. */
export async function extractCss(
  openSession: OpenSession,
  selector: string,
  opts: ExtractOptions = {},
): Promise<SelfContainedStyles> {
  return withPage(openSession, (page) => reworkStyles(page, { ...opts, root: selector }));
}

/** The whole document. Same live-DOM caveats as `extractCss`. */
export async function extractAllCss(openSession: OpenSession, opts: ExtractOptions = {}): Promise<SelfContainedStyles> {
  return withPage(openSession, (page) => reworkStyles(page, opts));
}

async function withPage<R>(openSession: OpenSession, run: (page: CdpPage) => Promise<R>): Promise<R> {
  const page = await CdpPage.open(openSession);
  try {
    return await run(page);
  } finally {
    await page.detach().catch(() => {});
  }
}

export { CdpConnection, CdpPage, CdpSession, attach, browserWsUrl, type OpenSession } from './cdp.ts';
export {
  reworkStyles,
  reworkHtml,
  jsonToHtml,
  type ReworkStylesOptions,
  type ReworkHtmlOptions,
  type SelfContainedStyles,
  type StyleJson,
  type StyleEntry,
  type StyleTreeNode,
  type NodeRect,
  type Decls,
  type ExtractionPage,
  type ExtractionSession,
  type EvalContext,
  type FrameLike,
} from './extract.ts';
