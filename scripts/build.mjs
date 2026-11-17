// dist/: tsc emits the library (JS + .d.ts), esbuild bundles the Playwright MCP
// snippet (src/pw-mcp.ts) into one function expression for `browser_run_code_unsafe`.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { build } from 'esbuild';

const root = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(root + 'package.json', 'utf8'));

rmSync(root + 'dist', { recursive: true, force: true });
execFileSync(process.execPath, [root + 'node_modules/typescript/bin/tsc', '-p', root + 'tsconfig.build.json'], { stdio: 'inherit' });
chmodSync(root + 'dist/cli.js', 0o755);

const out = await build({
  entryPoints: [root + 'src/pw-mcp.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: '__cssSnapshotBundle',
  // `browser` resolves css-tree to its prebuilt data (its node build loads JSON via
  // createRequire, which the vm cannot do).
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  define: { __VERSION__: JSON.stringify(pkg.version) },
});
const body = out.outputFiles[0].text;
if (/\brequire\(|\bimport\(/.test(body)) throw new Error('pw-mcp bundle still loads modules at runtime');
writeFileSync(
  root + 'dist/pw-mcp.js',
  `async (page) => {\n${body}\nreturn __cssSnapshotBundle.install(page);\n}\n`,
);
console.log(`dist/pw-mcp.js  ${(body.length / 1024).toFixed(0)} KB`);
