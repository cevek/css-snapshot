# css-snapshot

[![ci](https://github.com/cevek/css-snapshot/actions/workflows/ci.yml/badge.svg)](https://github.com/cevek/css-snapshot/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/css-snapshot.svg)](https://www.npmjs.com/package/css-snapshot)

Snapshot the **resolved, de-noised CSS** of a live Chromium page — the whole document or one
element's subtree — as **one self-contained JSON** that rebuilds the render offline, with no
browser and none of the original stylesheets.

It asks the browser's own cascade engine (Chrome DevTools Protocol), so `@layer`, `@media`,
`@container`, `@supports`, nesting, cross-origin sheets, specificity and runtime-inserted
rules are handled natively. Each element gets its own declarations — `var()` substituted,
`calc()` reduced, shorthands collapsed, UA-default noise dropped, authored units kept — plus
its `:hover`/`:focus`/`:active`/`:disabled` deltas, pseudo-elements, and cross-element state
rules (`.group:hover .child`).

Use it to hand a component's real styling to an LLM agent, to diff two renders, to freeze a
UI state for a test fixture, or to port a design between codebases.

```jsonc
// extractCss(page, '.card') → (abridged)
{
  "tree": { "tag": "section", "id": "card", "children": [ { "tag": "h2", "id": "el1", "children": [{ "text": "Title" }] } ] },
  "elements": {
    "card": {
      "base":   { "width": "320px", "padding": "0 4px", "border": "1px solid #ccc", "border-radius": "6px", "font-family": "Georgia, serif" },
      "states": { "hover": { "border-color": "rebeccapurple" } }
    },
    "el1": { "base": { "font-size": "1.25rem", "margin": "0 0 8px" } }
  },
  "fonts": "",
  "rootContext": { "fontSize": "16px" }
}
```

## Install

```bash
npm i css-snapshot
npm i -D playwright && npx playwright install chromium   # only if you use the playwright adapter
```

Node ≥ 22. Extraction needs **Chromium** (it drives CDP); the JSON and the rebuilt HTML are
portable.

## Use it

### From playwright

```ts
import { chromium } from 'playwright';
import { extractCss, extractAllCss } from 'css-snapshot/playwright';
import { jsonToHtml } from 'css-snapshot';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('https://example.com');

const card = await extractCss(page, '.card');            // a selector, or a Locator: page.getByRole('dialog')
const whole = await extractAllCss(page, { states: [] });  // the whole document, no state pass (faster)
const html = jsonToHtml(card);                            // self-contained HTML, no browser needed
```

Any playwright or playwright-core Chromium page works (the adapter is typed structurally,
playwright is an optional peer). A target inside an iframe is extracted from that frame.

### Over raw CDP (puppeteer, chrome-remote-interface, …)

The root entry has no browser-automation library in its import graph. Give it a factory of
fresh CDP sessions on the page:

```ts
import { extractCss, extractAllCss } from 'css-snapshot';

const snap = await extractCss(() => page.createCDPSession(), '.card');   // puppeteer
```

Or attach to an already-running Chrome by its debugging endpoint, touching no other tab:

```ts
import { CdpConnection, attach, browserWsUrl, extractAllCss } from 'css-snapshot';

const conn = await CdpConnection.connect(await browserWsUrl('http://127.0.0.1:9222'));
const { targetInfos } = await conn.send('Target.getTargets');
const tab = targetInfos.find((t) => t.type === 'page');
const snap = await extractAllCss(() => attach(conn, tab.targetId));
conn.close();
```

### From Playwright MCP

[Playwright MCP](https://github.com/microsoft/playwright-mcp)'s `browser_run_code_unsafe`
runs code in a sandbox with no `require`/`import`, so the package ships a self-contained
bundle and a ~300-character snippet that installs it. Print the snippet for your install:

```bash
npx css-snapshot pw-mcp          # explanation + snippet
npx css-snapshot pw-mcp --code   # the snippet alone
```

Then, in the agent session:

1. `browser_run_code_unsafe` with `code` = that snippet — once per browser context. It answers
   `css-snapshot x.y.z installed on page.context().cssSnapshot …`.
2. Take a `browser_snapshot` and extract by the element's ref (or any playwright selector):

   ```js
   async (page) => page.context().cssSnapshot.extract(page, 'aria-ref=e12')
   ```

3. A snapshot can be large — write it to disk instead of returning it:

   ```js
   async (page) => {
     const s = page.context().cssSnapshot;
     return s.save(page, await s.extract(page, '.card'), '/abs/path/card.json');
   }
   ```

The API on `page.context().cssSnapshot`: `extract(page, target, opts?)`,
`extractAll(page, opts?)`, `html(json)` (rebuilt HTML), `save(page, data, absPath)`.

Programmatically: `import { pwMcpLoader, pwMcpBundlePath } from 'css-snapshot/pw-mcp'`.

> Passing the bundle as `{ filename: 'node_modules/css-snapshot/dist/pw-mcp.js' }` works too,
> but the tool echoes the code it ran back into the conversation — the whole ~400 KB bundle.
> The snippet reads the file inside the MCP server process instead; `browser_run_code_unsafe`
> is documented as RCE-equivalent, and the snippet uses exactly that.

### From the shell

```bash
# Chrome started with --remote-debugging-port=9222
npx css-snapshot extract --cdp-endpoint http://127.0.0.1:9222 --target example.com --selector .card -o card.json
npx css-snapshot extract --cdp-endpoint http://127.0.0.1:9222 --html -o page.html     # whole page, rebuilt HTML
npx css-snapshot render card.json -o card.html
```

`--target` is a targetId or a URL substring matching exactly one tab (default: the only tab).
`--states hover,focus` or `none`, `--no-pseudo-elements`, `--no-embed-fonts`,
`--matcher probe|cdp`. `npx css-snapshot --help` lists everything.

## Entry points

| import | what |
|---|---|
| `css-snapshot` | `extractCss(openSession, selector, opts?)`, `extractAllCss(openSession, opts?)`, `reworkStyles`, `reworkHtml`, `jsonToHtml`, `CdpConnection`/`attach`/`browserWsUrl`, types |
| `css-snapshot/playwright` | `extractCss(page, selector \| Locator, opts?)`, `extractAllCss(page, opts?)` |
| `css-snapshot/diff` | same-DOM style patch: `diffStyles`, `applyStylePatch`, `canonicalStyleJson`, `diffElements` |
| `css-snapshot/css` | the value primitives the extractor uses: `expandShorthand`, `splitTopLevel`, `effectivelyEqual`, `INHERITABLE`, `extractionDropsProperty` |
| `css-snapshot/pw-mcp` | `pwMcpLoader()`, `pwMcpBundlePath()` |
| bin `css-snapshot` | `extract`, `render`, `pw-mcp` |

### Options

| option | default | meaning |
|---|---|---|
| `states` | `['hover','focus','focus-visible','active','disabled']` | pseudo-class states to capture; `[]` skips the state pass (much faster) |
| `pseudoElements` | `true` | capture `::before`/`::after`/`::placeholder`/`::marker`/… |
| `embedFonts` | `true` | collect reachable `@font-face` / Google-Fonts `@import` into `fonts` |
| `matcher` | `'probe'` | author-cascade matcher: `probe` (one injected probe sheet, fast) or `cdp` (per-node `getMatchedStylesForNode`, slow, the reference). Env `CSS_SNAPSHOT_MATCHER` overrides the default |

## The JSON

```ts
type SelfContainedStyles = {
  tree: StyleTreeNode;                  // structure from the extraction root; scripts/styles/inline style stripped
  elements: StyleJson;                  // per-id resolved styles
  fonts: string;                        // @font-face / @import CSS (may be "")
  rootContext?: { fontSize: string };   // subtree mode: the document's rem anchor
  widgetCss?: string;                   // verbatim ::-webkit-* rules (datetime fields, scrollbars, …)
};

type StyleTreeNode =
  | { text: string }
  | { tag: string; id?: string; attrs?: Record<string, string>; children?: StyleTreeNode[];
      rect?: { x: number; y: number; w: number; h: number };   // box relative to the extraction root
      computed?: Record<string, string> };                     // getComputedStyle of the kept keys

type StyleJson = Record<string, {
  base?: Decls;                                    // declarations at rest
  states?: Record<State, Decls>;                   // self-state DELTAS (.el:hover)
  pseudos?: Record<Pe, { base?: Decls; states?: Record<State, Decls> }>;
  relational?: Array<{ trigger: string; state: State; combinator: ' ' | '>' | '+' | '~'; pseudo?: Pe; delta: Decls }>;
}>;
type Decls = Record<string, string>;               // KEY ORDER IS RENDER ORDER (cascade order); !important folded into the value
```

`jsonToHtml(json)` emits exactly:

```
#id { base }                 #id:state { states[state] }
#id::pe { pseudos[pe].base } #id:state::pe { pseudos[pe].states[state] }
#trigger:state <combinator> #id[::pe] { relational.delta }
```

**Inheritance** flows through the emitted rules, so inherited values are not repeated per
element. In subtree mode the root materialises the inheritable set (font, color,
line-height…) so the subtree renders the same standalone, and `rootContext.fontSize` keeps
`rem` anchored. To read an element's effective inherited value, walk up to the nearest
ancestor whose `computed` has it.

## Fidelity and limits

Whole-document output renders pixel-identical to the original at rest (Firefox pixel oracle,
0.000 % on css-diff's reference page). Interactive states are captured by forcing them, not
seen by screenshots.

- Subtree mode carries **inheritance only**: a `%`/flex/grid/absolute value that depended on an
  ancestor above the cut, and container-query units, legally diverge. The root must be flow
  content (`<div>`, `<section>`, … — not `<tr>`/`<li>`).
- Not captured: Shadow DOM, fonts added only through the JS `FontFace` API, `!important` inside
  `@layer` (layer order reverses), `all: revert-layer`.
- Extraction **mutates the live page while it runs** (forced pseudo-states; minted ids stay on
  elements that lacked one). Run one extraction per page at a time.

The design, every de-noise pass and the probe matcher are described in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Development

```bash
npm i
npx playwright install chromium firefox
npm test               # unit, seconds
npm run test:browser   # Chromium extraction + Firefox pixel oracle, ~1 min
npm run test:e2e       # build, then the packed tarball + a real Playwright MCP server
npm run test:all       # all of the above
```

Test files: `*.test.ts` unit, `*.browser.test.ts` browser, `*.e2e.test.ts` e2e (built package).

### Release

```bash
npm run release                 # patch
npm run release -- minor        # or major, or an exact x.y.z
npm run release -- --dry-run    # every gate + npm publish --dry-run, changes nothing
```

It refuses unless on a clean `main` equal to `origin/main` and logged in to npm and `gh`, runs
typecheck and the whole suite, then bumps the version, publishes to npm, pushes the tag and
creates the GitHub release.

## License

MIT
