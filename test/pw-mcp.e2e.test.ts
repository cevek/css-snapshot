// The Playwright MCP integration end to end: the real @playwright/mcp server over stdio,
// the BUILT bundle (dist/pw-mcp.js) installed through the loader snippet, extraction by
// an `aria-ref` from the MCP's own snapshot and by selector, and save() to disk.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium, type Browser } from 'playwright';
import { extractCss } from '../src/playwright.ts';
import { pwMcpLoader } from '../src/pw-mcp-loader.ts';
import type { SelfContainedStyles } from '../src/extract.ts';
import { servePages } from './util/server.ts';

const root = new URL('..', import.meta.url).pathname;
const bundle = join(root, 'dist/pw-mcp.js');

// Authored `padding:0 4px` and `margin:0` survive verbatim on the probe path; the CDP
// path reserialises and expands them, so the raw `elements` tell the two paths apart.
const PAGE = `<!doctype html><html><head><style>
  body { margin: 0; font: 14px/1.4 Georgia, serif; }
  .card { width: 320px; padding: 0 4px; margin: 0; border: 1px solid #ccc; border-radius: 6px; }
  .card:hover { border-color: rebeccapurple; }
  .card h2 { font-size: 1.25rem; margin: 0 0 8px; }
  .go { background: #06c; color: #fff; padding: 4px 10px; border: 0; }
  .go:hover { background: #048; }
</style></head><body>
  <section class="card" id="card"><h2>Title</h2><button class="go" id="go">Go</button></section>
</body></html>`;

let client: Client;
let server: Awaited<ReturnType<typeof servePages>>;
let browser: Browser;
let cwd: string;

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('\n');
  if (r.isError) throw new Error(`${name} failed: ${text}`);
  return text;
}

/** The value a `browser_run_code_unsafe` call returned (its `### Result` section, JSON). */
function result(text: string): unknown {
  const m = /### Result\n([\s\S]*?)(?:\n### |$)/.exec(text);
  if (!m) throw new Error(`no result section in:\n${text.slice(0, 2000)}`);
  return JSON.parse(m[1]);
}

async function direct(sel: string, matcher: 'probe' | 'cdp'): Promise<SelfContainedStyles> {
  const page = await browser.newPage();
  try {
    await page.goto(server.url('/'));
    return await extractCss(page, sel, { matcher });
  } finally {
    await page.close();
  }
}

beforeAll(async () => {
  server = await servePages({ '/': PAGE });
  browser = await chromium.launch();
  cwd = mkdtempSync(join(tmpdir(), 'css-snapshot-mcp-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(root, 'node_modules/@playwright/mcp/cli.js'), '--headless', '--isolated', '--executable-path', chromium.executablePath(),
      // Ubuntu runners forbid unprivileged user namespaces, so Chromium's sandbox aborts there
      // (playwright's own launch disables it on Linux by default; the MCP keeps it on).
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    cwd,
    stderr: 'pipe',
  });
  client = new Client({ name: 'css-snapshot-e2e', version: '0' });
  await client.connect(transport);
  await call('browser_navigate', { url: server.url('/') });
});

afterAll(async () => {
  await client?.close();
  await browser?.close();
  await server?.close();
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe('Playwright MCP', () => {
  it('the loader installs the API without echoing the bundle back', async () => {
    const text = await call('browser_run_code_unsafe', { code: pwMcpLoader(bundle) });
    expect(result(text)).toMatch(/^css-snapshot \d+\.\d+\.\d+ installed on page\.context\(\)\.cssSnapshot/);
    expect(text.length, 'whole MCP response').toBeLessThan(4096);
  });

  it('extract by aria-ref equals an in-process probe extraction of the same element', async () => {
    const snap = await call('browser_snapshot', {});
    const ref = /button "Go" \[ref=(e\d+)\]/.exec(snap)?.[1];
    expect(ref, `a ref for the button in:\n${snap}`).toBeTruthy();
    const viaMcp = result(await call('browser_run_code_unsafe', {
      code: `async (page) => (await page.context().cssSnapshot.extract(page, 'aria-ref=${ref}')).elements`,
    }));
    const probe = (await direct('#go', 'probe')).elements;
    const cdp = (await direct('#go', 'cdp')).elements;
    expect(JSON.stringify(probe)).not.toBe(JSON.stringify(cdp)); // the fixture tells the matchers apart
    expect(viaMcp).toEqual(probe);
  });

  it('extract by selector + save() writes the snapshot to disk', async () => {
    const out = join(cwd, 'card.json');
    const tag = result(await call('browser_run_code_unsafe', {
      code: `async (page) => { const s = page.context().cssSnapshot; const j = await s.extract(page, '#card'); await s.save(page, j, ${JSON.stringify(out)}); return j.tree.tag; }`,
    }));
    expect(tag).toBe('section');
    const saved = JSON.parse(readFileSync(out, 'utf8')) as SelfContainedStyles;
    expect(saved.elements).toEqual((await direct('#card', 'probe')).elements);
    expect(saved.elements.card.states?.hover).toBeTruthy();
  });

  it('html() rebuilds the snapshot inside the MCP', async () => {
    const html = result(await call('browser_run_code_unsafe', {
      code: `async (page) => { const s = page.context().cssSnapshot; return s.html(await s.extract(page, '#card')); }`,
    })) as string;
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('#card:hover{');
  });

  it('the bundle also runs when passed as { filename } inside the workspace', async () => {
    copyFileSync(bundle, join(cwd, 'pw-mcp.js'));
    const text = await call('browser_run_code_unsafe', { filename: 'pw-mcp.js' });
    expect(result(text)).toMatch(/installed on page\.context\(\)\.cssSnapshot/);
  });
});
