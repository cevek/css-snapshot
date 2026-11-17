// The Playwright MCP entry, bundled into `dist/pw-mcp.js` (scripts/build.mjs). Playwright
// MCP's `browser_run_code_unsafe` evaluates a file as `(code)(page)` inside a fresh `vm`
// context that holds `page` plus a few web globals — no `require`, `import`, `process`
// or `console` — and drops that context after the call. So the bundle is one function
// expression, and it parks the API on `page.context()`, the one object that outlives
// the call, for later one-line snippets to reach.

import { extractCss, extractAllCss, type LocatorLike, type PageLike } from './playwright.ts';
import { jsonToHtml, type SelfContainedStyles } from './extract.ts';
import type { ExtractOptions } from './index.ts';

declare const __VERSION__: string;

export const CONTEXT_KEY = 'cssSnapshot';

interface DownloadLike {
  saveAs(path: string): Promise<void>;
}

interface McpPage extends PageLike {
  context(): ReturnType<PageLike['context']> & Record<string, unknown>;
  waitForEvent(event: 'download'): Promise<DownloadLike>;
}

export interface PwMcpApi {
  version: string;
  /** The subtree rooted at `target`: a playwright selector — `aria-ref=e12` from a
   *  `browser_snapshot`, `css=.card`, `text=Save` — or a Locator. */
  extract(page: McpPage, target: string | LocatorLike, opts?: ExtractOptions): Promise<SelfContainedStyles>;
  /** The page's whole main document. */
  extractAll(page: McpPage, opts?: ExtractOptions): Promise<SelfContainedStyles>;
  /** A snapshot rebuilt into self-contained HTML. */
  html(json: SelfContainedStyles): string;
  /** Write `data` (a string as-is, anything else as JSON) to an absolute `path` on the
   *  MCP server's machine, so a large snapshot need not travel through the agent's
   *  context. The vm has no fs: the bytes go out as a browser download of the page,
   *  which needs downloads accepted (Playwright's default). Resolves to `path`. */
  save(page: McpPage, data: unknown, path: string): Promise<string>;
}

async function save(page: McpPage, data: unknown, path: string): Promise<string> {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate((t: string) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([t], { type: 'application/octet-stream' }));
      a.download = 'css-snapshot.json';
      a.style.display = 'none';
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    }, text),
  ]);
  await download.saveAs(path);
  return path;
}

const api: PwMcpApi = {
  version: __VERSION__,
  extract: (page, target, opts) => extractCss(page, target, opts),
  extractAll: (page, opts) => extractAllCss(page, opts),
  html: jsonToHtml,
  save,
};

export function install(page: McpPage): string {
  page.context()[CONTEXT_KEY] = api;
  const s = `page.context().${CONTEXT_KEY}`;
  return [
    `css-snapshot ${api.version} installed on ${s} (until this browser context closes). With browser_run_code_unsafe:`,
    `  async (page) => ${s}.extract(page, 'aria-ref=e12')   // or any playwright selector / Locator`,
    `  async (page) => ${s}.extractAll(page, { states: [] })`,
    `  async (page) => { const s = ${s}; return s.save(page, await s.extract(page, '.card'), '/abs/card.json'); }`,
    '  html(json) -> self-contained HTML. A snapshot is large: save() it rather than return it.',
  ].join('\n');
}
