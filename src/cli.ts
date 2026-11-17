#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { CdpConnection, attach, browserWsUrl } from './cdp.ts';
import { extractCss, extractAllCss, type ExtractOptions } from './index.ts';
import { jsonToHtml, type SelfContainedStyles } from './extract.ts';
import { pwMcpBundlePath, pwMcpLoader } from './pw-mcp-loader.ts';

const USAGE = `css-snapshot — resolved-CSS snapshots of a live Chromium page

Usage:
  css-snapshot extract --cdp-endpoint <url> [--target <id|url-part>] [--selector <css>]
                       [--states <list|none>] [--no-pseudo-elements] [--no-embed-fonts]
                       [--matcher probe|cdp] [--html] [-o <file>]
      Snapshot a tab of an already-running Chromium (started with --remote-debugging-port).
      --cdp-endpoint  http://127.0.0.1:<port>, or the browser's ws://…/devtools/browser/… URL
      --target        the tab: its targetId or a URL substring matching exactly one tab
                      (default: the only open tab)
      --selector      the subtree rooted at the first match (default: the whole page)
      --states        comma-separated pseudo-class states, or "none"
                      (default: hover,focus,focus-visible,active,disabled)
      --html          write the rebuilt HTML instead of the JSON snapshot

  css-snapshot render <snapshot.json> [-o <file>]
      Rebuild a snapshot into self-contained HTML (offline, no browser).

  css-snapshot pw-mcp [--code]
      Print the Playwright MCP install snippet (--code: the snippet alone).

Output goes to stdout unless -o is given.`;

function fail(msg: string): never {
  process.stderr.write(`css-snapshot: ${msg}\n`);
  process.exit(1);
}

function writeOut(text: string, out: string | undefined): void {
  if (out) writeFileSync(out, text);
  else process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

function parse<O extends NonNullable<ParseArgsConfig['options']>>(args: string[], options: O, positionals = 0) {
  try {
    const r = parseArgs({ args, options, allowPositionals: positionals > 0, allowNegative: true, strict: true });
    if (r.positionals.length !== positionals) fail(`expected ${positionals} argument(s), got ${r.positionals.length}\n\n${USAGE}`);
    return r;
  } catch (e) {
    return fail(`${(e as Error).message}\n\n${USAGE}`);
  }
}

async function extract(args: string[]): Promise<void> {
  const { values: o } = parse(args, {
    'cdp-endpoint': { type: 'string' },
    target: { type: 'string' },
    selector: { type: 'string' },
    states: { type: 'string' },
    'pseudo-elements': { type: 'boolean', default: true },
    'embed-fonts': { type: 'boolean', default: true },
    matcher: { type: 'string' },
    html: { type: 'boolean', default: false },
    out: { type: 'string', short: 'o' },
  });
  if (!o['cdp-endpoint']) fail('extract: --cdp-endpoint is required');
  if (o.matcher !== undefined && o.matcher !== 'probe' && o.matcher !== 'cdp') fail('extract: --matcher is probe or cdp');
  const conn = await CdpConnection.connect(await browserWsUrl(o['cdp-endpoint']));
  try {
    const { targetInfos } = await conn.send('Target.getTargets');
    const pages = (targetInfos as Array<{ type: string; targetId: string; url: string }>).filter((t) => t.type === 'page');
    const want = o.target;
    const picked = want === undefined ? pages : pages.filter((t) => t.targetId === want || t.url.includes(want));
    if (picked.length !== 1) {
      const list = pages.map((t) => `  ${t.targetId}  ${t.url}`).join('\n') || '  (none)';
      fail(`extract: ${picked.length === 0 ? 'no tab matches' : 'several tabs match'}${want === undefined ? ' — pass --target' : ` --target ${want}`}. Open tabs:\n${list}`);
    }
    const open = () => attach(conn, picked[0].targetId);
    const opts: ExtractOptions = {
      states: o.states === undefined ? undefined : o.states === 'none' ? [] : o.states.split(',').map((s) => s.trim()).filter(Boolean),
      pseudoElements: o['pseudo-elements'],
      embedFonts: o['embed-fonts'],
      matcher: o.matcher as ExtractOptions['matcher'],
    };
    const json = o.selector ? await extractCss(open, o.selector, opts) : await extractAllCss(open, opts);
    writeOut(o.html ? jsonToHtml(json) : JSON.stringify(json), o.out);
  } finally {
    conn.close();
  }
}

function render(args: string[]): void {
  const { values: o, positionals } = parse(args, { out: { type: 'string', short: 'o' } }, 1);
  let json: SelfContainedStyles;
  try {
    json = JSON.parse(readFileSync(positionals[0], 'utf8'));
  } catch (e) {
    return fail(`render: cannot read ${positionals[0]}: ${(e as Error).message}`);
  }
  if (!json || typeof json !== 'object' || !json.tree || !json.elements) fail(`render: ${positionals[0]} is not a snapshot ({tree, elements})`);
  writeOut(jsonToHtml(json), o.out);
}


function pwMcp(args: string[]): void {
  const { values: o } = parse(args, { code: { type: 'boolean', default: false } });
  const bundle = pwMcpBundlePath();
  const loader = pwMcpLoader(bundle);
  if (o.code) return writeOut(loader, undefined);
  writeOut(
    [
      'Playwright MCP — install once per browser context: call browser_run_code_unsafe with this code',
      '(`css-snapshot pw-mcp --code` prints it alone):',
      '',
      loader,
      '',
      'It installs page.context().cssSnapshot; then, e.g.:',
      "  async (page) => page.context().cssSnapshot.extract(page, 'aria-ref=e12')",
      '',
      `Bundle: ${bundle}`,
      '(passing it as { filename } also works when it sits inside the MCP workspace, but the tool',
      'then echoes the whole ~400 KB bundle back into the conversation).',
    ].join('\n'),
    undefined,
  );
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'extract') await extract(rest);
  else if (cmd === 'render') render(rest);
  else if (cmd === 'pw-mcp') pwMcp(rest);
  else if (cmd === undefined || cmd === '-h' || cmd === '--help' || cmd === 'help') writeOut(USAGE, undefined);
  else fail(`unknown command "${cmd}"\n\n${USAGE}`);
} catch (e) {
  fail((e as Error).stack ?? String(e));
}
