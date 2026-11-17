// css-snapshot/pw-mcp: how to get the Playwright MCP bundle (dist/pw-mcp.js, built from
// src/pw-mcp.ts) into a `browser_run_code_unsafe` call.

import { fileURLToPath } from 'node:url';

/** Absolute path of the installed bundle. */
export function pwMcpBundlePath(): string {
  return fileURLToPath(new URL('./pw-mcp.js', import.meta.url));
}

/** The `browser_run_code_unsafe` code that installs the bundle on `page.context()`.
 *  Passing the bundle as `{ filename }` works too, but the tool echoes the whole code it
 *  ran back into the agent's context (~400 KB); this loader reads the file inside the MCP
 *  server process instead. The run-code vm is no boundary — the tool is documented as
 *  RCE-equivalent — and `page`'s constructor chain reaches that process's `Function`.
 *  `getBuiltinModule` needs Node ≥ 20.16 / 22.3; `mainModule` covers older CJS mains. */
export function pwMcpLoader(bundlePath: string = pwMcpBundlePath()): string {
  return `async (page) => { const p = page.constructor.constructor('return process')(); `
    + `const fs = p.getBuiltinModule ? p.getBuiltinModule('fs') : p.mainModule.require('fs'); `
    + `return (0, eval)(fs.readFileSync(${JSON.stringify(bundlePath)}, 'utf8'))(page); }`;
}
