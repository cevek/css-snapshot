// The PUBLISHED artifact: `npm pack` → install the tarball into a scratch consumer →
// type-check a NodeNext consumer against the shipped .d.ts, import every entry point from
// plain Node, and run the CLI against a real remote-debugging endpoint.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { servePages } from './util/server.ts';

const root = new URL('..', import.meta.url).pathname;
const PAGE = `<!doctype html><style>.c{padding:0 4px;color:#333}.c:hover{color:red}</style><div class="c" id="c"><b>hi</b></div>`;

let dir: string;
let server: Awaited<ReturnType<typeof servePages>>;
let browser: Browser;
let port: number;

// Async: the page server lives in this process, so a blocking exec would starve it.
async function run(cmd: string, args: string[], cwd = dir): Promise<string> {
  try {
    return (await promisify(execFile)(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 })).stdout;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    throw new Error(`${err.message}\n${err.stdout ?? ''}\n${err.stderr ?? ''}`);
  }
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'css-snapshot-pack-'));
  const tgz = (await run('npm', ['pack', '--silent', '--pack-destination', dir], root)).trim().split('\n').pop()!;
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  await run('npm', ['install', '--prefer-offline', '--no-audit', '--no-fund', join(dir, tgz), `playwright@${JSON.parse(readFileSync(join(root, 'node_modules/playwright/package.json'), 'utf8')).version}`]);
  server = await servePages({ '/': PAGE });
  port = await freePort();
  browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  const page = await browser.newPage();
  await page.goto(server.url('/'));
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('packed tarball', () => {
  it('ships only dist + docs', async () => {
    const files = (JSON.parse(await run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], root))[0].files as Array<{ path: string }>).map((f) => f.path);
    expect(files.every((f) => f.startsWith('dist/') || ['package.json', 'README.md', 'LICENSE'].includes(f))).toBe(true);
    expect(files).toContain('dist/pw-mcp.js');
  });

  it('type-checks a NodeNext consumer against the shipped declarations', async () => {
    writeFileSync(join(dir, 'consumer.ts'), `
import { extractCss as overCdp, reworkStyles, jsonToHtml, type SelfContainedStyles, type OpenSession } from 'css-snapshot';
import { extractCss, type PageLike } from 'css-snapshot/playwright';
import { diffStyles, canonicalStyleJson } from 'css-snapshot/diff';
import { expandShorthand, INHERITABLE } from 'css-snapshot/css';
import { pwMcpLoader } from 'css-snapshot/pw-mcp';
import type { Page } from 'playwright';
export async function f(page: Page, open: OpenSession): Promise<string> {
  const a: SelfContainedStyles = await extractCss(page satisfies PageLike, '.c');
  const b = await overCdp(open, '.c');
  void reworkStyles; void canonicalStyleJson; void expandShorthand; void INHERITABLE;
  return jsonToHtml(a) + JSON.stringify(diffStyles(a, b)) + pwMcpLoader();
}
`);
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', strict: true, noEmit: true,
        lib: ['ESNext', 'DOM'], types: ['node'], typeRoots: [join(root, 'node_modules/@types')],
      },
      files: ['consumer.ts'],
    }));
    await run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', dir]);
  });

  it('every entry point loads in plain Node and extracts', async () => {
    writeFileSync(join(dir, 'smoke.mjs'), `
import { chromium } from 'playwright';
import * as core from 'css-snapshot';
import { extractCss } from 'css-snapshot/playwright';
import { canonicalStyleJson, diffStyles } from 'css-snapshot/diff';
import { expandShorthand } from 'css-snapshot/css';
import { pwMcpBundlePath } from 'css-snapshot/pw-mcp';
import { existsSync } from 'node:fs';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(process.argv[2]);
const a = await extractCss(page, '#c');
const b = await core.extractCss(() => page.context().newCDPSession(page), '#c');
await browser.close();
console.log(JSON.stringify({
  same: JSON.stringify(canonicalStyleJson(a.elements)) === JSON.stringify(canonicalStyleJson(b.elements)),
  emptyPatch: Object.keys(diffStyles(a, b).elements).length === 0,
  hover: a.elements.c.states.hover.color,
  margin: expandShorthand('margin', '1px').size,
  bundle: existsSync(pwMcpBundlePath()),
}));
`);
    const out = JSON.parse(await run(process.execPath, ['smoke.mjs', server.url('/')]));
    expect(out).toEqual({ same: true, emptyPatch: true, hover: 'red', margin: 4, bundle: true });
  });

  it('the CLI extracts over a remote-debugging endpoint and renders', async () => {
    const bin = join(dir, 'node_modules/.bin/css-snapshot');
    await run(bin, ['extract', '--cdp-endpoint', `http://127.0.0.1:${port}`, '--target', '127.0.0.1', '--selector', '#c', '-o', 'c.json']);
    const snap = JSON.parse(readFileSync(join(dir, 'c.json'), 'utf8'));
    expect(snap.tree.tag).toBe('div');
    expect(snap.elements.c.states.hover.color).toBe('red');
    expect(await run(bin, ['render', 'c.json'])).toContain('#c:hover{color:red}');
    expect(await run(bin, ['pw-mcp', '--code'])).toContain(join(dir, 'node_modules/css-snapshot/dist/pw-mcp.js'));
  });
});
