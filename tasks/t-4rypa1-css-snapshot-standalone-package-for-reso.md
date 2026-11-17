---
id: t-4rypa1
title: 'css-snapshot: standalone package for resolved-CSS snapshot extraction'
status: in-progress
priority: high
assigned_to_session: s-3jptme
author: mb-07ba7304
assignee: mb-07ba7304
created: '2026-11-17T01:07:37.953Z'
---
Extract the style-extraction core of css-diff (`reworkStyles` / `extractCss` / `jsonToHtml`, the probe + CDP matchers, the same-DOM style patch) into a standalone, publishable npm package `css-snapshot`. css-diff itself stays untouched; switching it to the package is a later, separate step.

## План

**Source of truth.** css-diff @ `d0b8445` (main). Files copied verbatim, then adapted:
- `index.ts`, `playwright.ts`, `cdp.ts`, `marker.ts`, `diff.ts` → `src/`; `extractElementCss.ts` → `src/extract.ts`.
- `src/{cascade,cdp-types,colord-names,probe-matcher,resolve,shorthand,specificity,style-string,value-tokens,vars}.ts` + `types-shims.d.ts` → `src/internal/`.
- NOT taken: `src/display-compaction.ts` (web-UI display, imports `shared/protocol.ts`), tree-diff / AI / fixtures / server / app, page-capture.

**Entry points** (`exports`):
- `css-snapshot` — `extractCss(openSession, selector)` / `extractAllCss(openSession)` over raw CDP, plus `reworkStyles`/`reworkHtml`/`jsonToHtml`, `CdpConnection`/`attach`/`browserWsUrl`, types. No automation library in its import graph.
- `css-snapshot/playwright` — `extractCss(page, Locator|string)` / `extractAllCss(page)`.
- `css-snapshot/diff` — `diffStyles`/`applyStylePatch`/`canonicalStyleJson` + the value helpers css-diff's tree diff needs later (`expandBucket`, `valuesEqual`, …). Kept off the root entry so `culori` loads only when diffing.
- `css-snapshot/pw-mcp.js` — a self-contained bundle for Playwright MCP's `browser_run_code_unsafe` (`filename:`).

**Playwright MCP integration.** Fact (read @playwright/mcp 0.0.85 source, `runCode.ts`): the code runs as `(code)(page)` inside a fresh `vm` context holding only `page` + timers/URL/fetch/crypto/Buffer… — no `require`, no `import`, no `process`, no `console`; `filename` resolves inside the client's workspace roots. So `dist/pw-mcp.js` is an esbuild bundle wrapped as `async (page) => {…}`; running it once installs the API on `page.context()` (the Page object outlives the vm context), and later calls are one-liners: `async (page) => page.context().cssSnapshot.extract(page, 'aria-ref=e12')`. A `save` helper writes big JSON to disk through a Playwright download (no fs in the vm), so a large snapshot does not flood the agent context. Requires: `process.env` read in `extract.ts` guarded (`typeof process`), and a `matcher` option added so the vm path need not rely on env.

**Naming.** Env `CSS_DIFF_MATCHER` → `CSS_SNAPSHOT_MATCHER`; DOM markers `data-cssdiff-*` / `cssdiff-lh-probe` → `data-css-snapshot-*` / `css-snapshot-lh-probe`. css-diff's own `data-cssdiff-root` (picker) is outside this package.

**Build / publish.** Sources stay `.ts` (erasable syntax); `tsc` emits `dist/*.js` + `.d.ts` (`rewriteRelativeImportExtensions`); esbuild builds `dist/pw-mcp.js`. `npm run release [patch|minor|major]` = one command: clean tree + on main + `npm whoami` check → typecheck → unit + browser tests → build → pack smoke test (import the packed tarball from a temp dir) → `npm version` → `npm publish --access public` → `git push --follow-tags` → `gh release create`.

**CLI** (`css-snapshot` bin, `node:util parseArgs`, zero deps): `extract --cdp-endpoint <url> [--target] [--selector] [-o]`, `render <snapshot.json> [-o]`, `pw-mcp` (prints the bundle path + usage).

**Tests.** Ported verbatim (imports adapted) — unit: `denoise`, `emit-order`, `diff`; browser (Chromium): `capture-meta`, `cdp-adapter`, `effective-default`, `emit-order`, `frame`, `frame-sameprocess`, `page-clean`, `playwright-adapter`, `probe-dualsource-differential`, `probe-state-differential`, `shorthand-clobber`, `subtree`. Not ported: tests that need css-diff's external reference page (— `styles`, `json-html`, `probe-cdp-differential`, `probe-matcher`), Firefox pixel-oracle `diff.browser` (Firefox launch hangs on this host), corpus tests (need page-capture datasets). New: `pw-mcp.e2e` — spawns the real `@playwright/mcp` over stdio, loads a fixture page, runs the bundle by `filename`, extracts by `aria-ref` and by selector, saves to disk; `pack` smoke — the built tarball imports and extracts from a plain Node ESM consumer. CI: GitHub Actions on push/PR — typecheck, unit, build, browser (chromium).

**Docs.** README (install, quick start for the three entry points + CLI + Playwright MCP, JSON format, options, limits, development/release); `docs/ARCHITECTURE.md` = css-diff ARCHITECTURE §1–§11 adapted (comments in code cite its §-numbers); `t-…` ids in comments refer to the css-diff backlog — noted there. LICENSE MIT.

**Repo.** Public GitHub `cevek/css-snapshot`, created with `gh repo create --public` and pushed.

**Forks.**
- Package name `css-snapshot` (free on npm and GitHub) vs keeping `css-diff-*`: the package is the extractor independent of diffing, so a neutral name.
- `diff.ts` in the package vs left in css-diff: in — it depends only on extraction modules, the browser tests need `canonicalStyleJson`, and css-diff's tree diff reuses it.
- Pre-built JS vs TS sources: built JS — Node does not type-strip under `node_modules`.
- MCP integration as snippet bundle vs own MCP server: snippet — css-diff already removed its own MCP proxy for lack of users; the bundle works with stock Playwright MCP.

**Reviewers on code:** bug-reviewer (1 round, up to 2); architecture-reviewer (1 round — new package boundary).

**Not done here:** npm publish itself needs `npm login` (registry answers 401 for this host now); css-diff migration → separate task.

## Разбор

**Plan-review (codex, 1 круг) — закрыто правкой:**
- [BLOCK] `{ filename }` echo: Playwright MCP echoes the code it ran (`### Ran Playwright code`) — measured 385 583 chars for the bundle. Fixed: `pwMcpLoader()` snippet (~300 chars) reads the bundle in the MCP server process via `page.constructor.constructor('return process')()` + `getBuiltinModule('fs')`, `eval`s it in the vm; e2e asserts the whole install response < 4 KB.
- [BLOCK] migration exports: `css-snapshot/css` (expandShorthand, SHORTHAND_COVERAGE, splitTopLevel*, effectivelyEqual, INHERITABLE, extractionDropsProperty) + `css-snapshot/diff` exports all of diff.ts. colord names init rides on `resolve.ts` import (side effect kept: `sideEffects` field removed — esbuild dropped the bare import with it).
- [BLOCK] tests: synthetic parts of `probe-matcher`, `styles`, `json-html`, all of `corpus-regressions` (→ `regressions.browser`), and the Firefox `diff.browser` oracle ported. Not ported: only what needs css-diff's reference page (Guard 1/2/6, ref-page differential, json-html Firefox DoD) and the corpus harness.
- [BLOCK] Node 20 lacks unflagged global WebSocket (cdp.ts) → `engines.node >=22`, CI on 22.
- [should-fix] e2e in CI + release (`test:all` runs unit+browser+e2e). Probe path proven: the MCP extraction equals an in-process `matcher:'probe'` extraction and the fixture makes probe ≠ cdp raw output.

**Факты, вскрытые по ходу:**
- colord 2.13 changed alpha precision → 2 golden diff tests fail; pinned `colord ~2.9.3` (css-diff's version) to keep the documented 2-decimal behaviour.
- `npm i` with `@playwright/mcp` devDep crashes arborist (`Cannot read properties of null (reading 'edgesOut')`, npm 10.9) — its exact-alpha `playwright` vs our optional peer. `.npmrc legacy-peer-deps=true` (not published).
- css-tree's node build loads JSON via `createRequire` — dies in the vm; `platform: browser` picks its prebuilt `dist/data.js`.
- Firefox launch on this host works (t-nwkk89 in css-diff looks stale): first launch after `playwright install firefox` ~3 s.
- Blocking `execFileSync` in a vitest test starves the in-process page server → page.goto timeouts; the pack e2e uses async exec.
- `review` MCP tool only reads commits of the chat's working dir (css-diff); plan-SHA was fetched into css-diff as `refs/css-snapshot-review/main` (no worktree change) — friction f-zgbhflx6hfai.
