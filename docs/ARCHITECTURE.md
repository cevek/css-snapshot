# css-snapshot — architecture

Internal reference for how the package resolves and emits styles. For usage and the
JSON output shape, see [`README.md`](../README.md). The code comments cite this file by
section number (`§6`, `§10`, …).

The package was extracted from css-diff, a visual-diff
tool built on top of it; the section numbers and the `t-…` backlog ids in comments come
from there (§12 — css-diff's web UI — stays in css-diff). So do the guards that need
css-diff's reference page: Guard 1/2 baselines, `probe-cdp-differential`, the corpus
harness; tests named here and absent from `test/` live there.

## 1. What it does

Given a **loaded Chromium page**, it extracts each element's **resolved, de-noised
CSS** using the browser's own cascade engine — via the browser-side probe matcher by
default, or per-node CDP `getMatchedStylesForNode` as the fallback (`CSS_SNAPSHOT_MATCHER`,
§10) — and emits it either as a self-contained HTML reproduction (`reworkHtml`) or as one
self-contained JSON object (`{ tree, fonts, elements }`, `reworkStyles`) from which
the styled HTML rebuilds offline. Both are produced from one shared pass.

The HTML output assigns every styled element a stable `id` and a `<style>` of

```
#id{ …resolved declarations… }
#id:hover{ …delta vs base… }        /* + :focus / :focus-visible / :active / :disabled */
#id::after{ … }                      /* + ::before / ::placeholder / ::marker / … */
#id:hover::after{ … }                /* pseudo-element under a host state */
#foo:hover #bar{ … }                 /* relational: subject changes when trigger is in a state */
```

Inheritance is preserved **by the emitted rules themselves** (each element's own
cascaded declarations flow to descendants), so inherited values are **not**
re-materialised per element. Opening the HTML renders pixel-identical to the
original at rest — no original CSS, `<script>`, or inline `style` remain.

Verification standard: render original vs output in **Firefox** (deterministic;
Chromium has sub-pixel AA noise, Firefox self-consistency is 0.000%) and pixel-diff
with `pixelmatch`. On css-diff's reference page the output scores **0.000%** (that
Firefox oracle runs in css-diff; this package's suite asserts the extraction on
synthetic Chromium fixtures).

## 2. Public API (`src/extract.ts`)

| Function | Scope | Output |
|---|---|---|
| `extractElementCss(page, sel, opts)` | one element | declaration string |
| `extractElementStyles(page, sel, opts)` | one element | `{ base, states, pseudos }` |
| `reworkHtml(page, opts)` | whole doc | self-contained HTML string (original CSS stripped) |
| `reworkStyles(page, opts)` | whole doc **or a subtree** | `{ tree, fonts, elements, rootContext? }` — one self-contained JSON |
| `jsonToHtml(json)` | — (pure) | offline rebuild of the styled HTML from a `reworkStyles` result |

`ReworkHtmlOptions = { states?: string[], pseudoElements?: boolean, embedFonts?: boolean }`.
Default states: `['hover','focus','focus-visible','active','disabled']`.
`reworkStyles` additionally accepts `root?: string` — a CSS selector to extract
only that element's **subtree** (see §4.6); it adds `rootContext` to the result.

`reworkStyles` / `reworkHtml` take an **`ExtractionPage`**, not a playwright `Page`: the
structural contract the driver owns — `evaluate` (`EvalContext`) plus
`context().newCDPSession()` returning an `ExtractionSession` (`send`/`on`/`detach`).
playwright's `Page` satisfies it; so does `cdp.ts` `CdpPage` (`implements`), which runs
`evaluate` as `Runtime.evaluate` over a session from an `OpenSession` factory. The driver
imports nothing from playwright: `FrameLike` (frame mode, `opts.frame`, §4.7) is a structural
`EvalContext`, handed to `newCDPSession` — playwright's resolves it to the frame's session,
`CdpPage` rejects it. A new page member used by the driver must go into the contract — the
compiler then names every implementation that lacks it.

### 2.1 Package entry points

Sources are TypeScript with erasable syntax only (`erasableSyntaxOnly` +
`verbatimModuleSyntax`); `npm run build` emits `dist/` (JS + `.d.ts`, relative `.ts`
imports rewritten) and bundles `dist/pw-mcp.js`. Node does not strip types under
`node_modules`, so the package ships built JS.

- **`css-snapshot`** → `src/index.ts`, the core. Its import graph holds no browser-automation
  library. `extractCss(openSession, selector, opts)` / `extractAllCss(openSession, opts)` take
  an `OpenSession` — a factory of fresh CDP sessions on one page target (`cdp.ts`). A factory,
  not one session: on the probe path an extraction opens a driver session plus a dedicated
  matcher session (whose `CSS.enable` must replay `styleSheetAdded`, §10) — single-session
  extraction is backlog `t-4b154n`. Also re-exports `reworkStyles`/`reworkHtml`/`jsonToHtml`,
  `CdpConnection`/`attach`/`browserWsUrl` (a raw debugging endpoint), and the types.
- **`css-snapshot/playwright`** → `src/playwright.ts`. `extractCss(page, target: Locator |
  string)` / `extractAllCss(page)` over any playwright(-core) Chromium page, typed
  structurally (`PageLike`/`LocatorLike`, assignability to the real types asserted in
  `test/playwright-adapter.browser.test.ts`). A string is `page.locator(str)` (strict,
  auto-wait). The target is addressed by a per-call marker ATTRIBUTE NAME (`marker.ts`)
  stamped and removed through one held `ElementHandle`; a target inside an iframe is
  extracted in frame mode.
- **`css-snapshot/diff`** → `src/diff.ts`, the same-DOM style patch (§11). Off the root entry
  so `culori` loads only when diffing.
- **`css-snapshot/css`** → `src/css.ts`: the value primitives the extractor is built on
  (`expandShorthand`, `splitTopLevel*`, `effectivelyEqual`, `INHERITABLE`,
  `extractionDropsProperty`), for post-processors that must agree with it.
- **`css-snapshot/pw-mcp`** → `src/pw-mcp-loader.ts` + the bundle `dist/pw-mcp.js`
  (`src/pw-mcp.ts`, §2.2).
- **CLI** `css-snapshot` → `src/cli.ts`: `extract --cdp-endpoint` (the core over
  `CdpConnection` against an already-running Chromium), `render`, `pw-mcp`.

### 2.2 Playwright MCP

`browser_run_code_unsafe` evaluates its code as `(code)(page)` inside a fresh Node `vm`
context holding `page` and a fixed list of web globals (timers, `URL`, `fetch`, `crypto`,
`Buffer`, …) — no `require`, `import`, `process` or `console` — and drops the context after
the call. Hence:

- `dist/pw-mcp.js` is ONE function expression wrapping an esbuild IIFE bundle
  (`platform: browser`, which resolves css-tree to its prebuilt data instead of its
  `createRequire` JSON loads). The build fails if the bundle still calls `require`/`import()`.
- The API is parked on `page.context()` (`cssSnapshot`): the Page object is the one thing that
  outlives a call, so later calls are one-liners.
- The tool echoes the code it ran back into the response — the WHOLE bundle when it is
  passed as `{ filename }`. `pwMcpLoader()` is a ~300-character snippet that reads the
  bundle inside the MCP server process instead (`page.constructor.constructor` is that
  process's `Function`; the tool is documented as RCE-equivalent, so this crosses no
  boundary) and `eval`s it in the vm.
- `save()` writes through a browser download (`download.saveAs`), the vm having no fs.
- `extract.ts` reads `process.env` only behind `typeof process`.

Extraction mutates the live page for its duration (forced pseudo-states, minted ids that
stay — backlog `t-5a8s88`): one extraction per page at a time, nothing else driving it.

## 3. Module map (`src/internal/`)

- `cdp-types.ts` — structural types for CDP `getMatchedStylesForNode` responses.
- `probe-matcher.ts` — **`buildProbeMatcher`**: the browser-side author-cascade matcher
  (the default under `CSS_SNAPSHOT_MATCHER=probe`, §10). Injects one generated *probe sheet*
  (each `(rule, selector)` → `SEL{--czp<nonce>_<i>:1}` in its condition stack) via an inspector
  stylesheet, reads every element's set markers in ONE `page.evaluate`, and synthesises
  the same `MatchedStyles` (author `matchedCSSRules` + `pseudoElements`; the caller adds
  the inline/attribute tiers) that CDP would return — with a hand cascade-order glue
  (`@csstools/selector-specificity` for escaped selectors) proven exact vs CDP. Builds its
  rule inventory **dual-source** (§10): each sheet's CDP source text is parsed (`parseSheet`,
  native `&`-nesting desugared + `CSSNestedDeclarations` synthesised), UNLESS a live in-page
  **CSSOM census** shows the text is stale (a runtime `insertRule` a URL-backed Vite/Tailwind
  dev sheet added) — then that sheet is **harvested from the live CSSOM** instead. Surfaces a
  `ProbeRisk` (`mustFallbackToCdp` = at-rest-poisoning → whole-doc CDP). State deltas need NO
  risk gate: phase-4 re-reads the raw `--czp` markers under `CSS.forcePseudoState`
  (`matchedFromComputed`) → engine-truth for every state-selector class (§10).
  **Layer note:** every OTHER `src/internal/` module is browser-free pure logic; `probe-matcher.ts`
  is the sole **browser-coupled primitive** (it takes a CDP client + an eval context to
  read sheets and inject the probe). Keep new CDP-driving code in the driver
  (`src/extract.ts`), not `src/internal/` — this module is a deliberate, contained exception,
  not a precedent for more.
- `specificity.ts` — selector specificity via `parsel-js` (recorded on `ResolvedDecl`
  but **not** used to pick the winner — see §5).
- `cascade.ts` — `cascadeResolve` (author cascade → winner per property) + `declBeats`
  + `cascadeOrdered` (a resolved map in EMISSION order — ascending cascade order of
  each property's winner, which map order does not give, §4.5).
- `vars.ts` — `resolveVars` (`postcss-value-parser`) + IACVT flag, `simplifyCalc`
  (`reduce-css-calc`).
- `shorthand.ts` — `expandShorthand` + hand-rolled per-property expansion tables;
  `SHORTHAND_COVERAGE` (shorthands `expandShorthand` doesn't model — background/
  background-position/font/list-style/text-decoration/columns/column-rule → the
  longhands they reset)
  and `orderPropsShorthandFirst` (emit-order SAFETY NET for buckets with no
  cascade provenance — the ones apply assembles; a no-op on extracted ones, §4.5).
- `value-tokens.ts` — `splitTopLevel` / `splitTopLevelComma` (`postcss-value-parser`).
- `style-string.ts` — `buildStyleString` (decl map → `prop:value;…`, cascade order).
- `resolve.ts` — `resolveElementStyles`, **`denoiseResolved`** (the de-noise passes),
  `resolvePseudoElement`, `diffResolved`, `effectivelyEqual` (exported for the
  style-patch value compare), and the property-classification tables.
The driver `src/extract.ts` holds `buildReworkModel` (the shared pass),
`stateTargets` (selector analysis for states), the shared rule emitter
`styleJsonToRules`, the `buildTree`/`jsonToHtml` tree serialisers, and the two
entry-point serialisers.

`src/diff.ts` is the one downstream consumer of the extracted JSON in this package, not
part of the extraction pipeline: `diffStyles`/`applyStylePatch` + the
`canonicalStyleJson` round-trip oracle (same-DOM style patch — §11). It also exports two
pure, display-only predicates for css-diff's web UI, neither touching the strict
`valuesEqual`/`canonValue` oracle: `colorNearEqual` (perceptual ΔE2000 colour equality)
and `importanceOnlyDiff` (bare-equal-but-`!important`-differs — reuses `valuesEqual` on
the importance-stripped bares).

## 4. The full-document pipeline

`buildReworkModel(page, states, doPseudos)` runs once over its own `CDPSession`
and produces a `ReworkModel` — an `ElementModel[]` where each element carries
`{ id, base, selfStates, pseudos, relational }`. `reworkHtml` and `reworkStyles`
then serialise the same model (§4.5). All CDP work goes through one session; the
document structure comes from **one** `DOM.getDocument({depth:-1})`.
`collectReworkElements` walks it, skipping `SKIP_REWORK_TAGS`
(`script, style, link, noscript, meta, title, head, base, template`) and records
`{nodeId, tag, node}` per rendering element plus the existing ids.

### Phase 1 — matched styles (per node)
Each element's author `MatchedStyles` comes from one of two matchers, selected by
`CSS_SNAPSHOT_MATCHER` (§10):

- **`probe` (default)** — `buildProbeMatcher` is built ONCE (on a dedicated CDP
  session — its `CSS.enable` must replay `styleSheetAdded`, which the driver's own
  session has already consumed; it reuses the driver's `DOM.getDocument` root via
  `opts.domRoot` so the driver's nodeIds stay valid). `matcher.matchedFor(nodeId)` then
  supplies the author `matchedCSSRules` + `pseudoElements` with **no** per-node CDP call.
  The `inlineStyle`/`attributesStyle` tiers (which the matcher leaves unset) are assembled
  per node from **`CSS.getInlineStylesForNode`** (browser-native, ~0.1 ms/node, no ancestor
  match — §10). On a build failure or `risk.mustFallbackToCdp`, the driver falls through to
  the CDP path.
- **`cdp`** — for **every** element, `CSS.getMatchedStylesForNode` via `Promise.all`
  (CDP reads pipeline — ~1.8× vs sequential; the dominant cost, ~250 ms/node on a deep
  page). The original path.

Either way the result is the browser's **own cascade** — matching author rules (declared
values, per-selector specificity, `layers`, origin) in **ascending cascade order** — fed
UNCHANGED to `resolveElementStyles`/`cascadeResolve`. While collecting, we gather the union
of **declared property names** + **referenced custom-prop names** (`var(--x)`) — the prop
set to snapshot next.

### Phase 2 — computed styles (whole document, ONE call)
`snapshotComputed` is a single `page.evaluate` that walks the document in the same
order and returns `getComputedStyle` for the Phase-1 prop union + custom props, per
element — replacing ~N `getComputedStyleForNode` round-trips with one bridge
crossing. (Custom props rule out `DOMSnapshot.captureSnapshot`, which rejects `--*`
names.) The two walks must stay in lockstep; a length mismatch throws.

Computed values are used only for: `var()` resolution (custom-prop values),
`calc()` inputs, tag-default comparison, IACVT materialisation, and the
border/outline invisibility checks — **never** emitted directly (authored
`rem`/`%` are kept).

### Phase 3 — resolve, de-noise, ids, base & pseudos
Tag defaults are prefetched in parallel (one hidden-iframe `getComputedStyle` per
**unique tag**, cached). Then, per element:

- **base** = `resolveElementStyles(tag, matched, computed, tagDefaults, /*includeInherited*/false, /*dropDefaults*/true, /*protectInherited*/true)`.
- **reference** = same but `dropDefaults:false` — kept for the state diff (a state
  that resets a prop to its tag default must still show up as a delta).
- **pseudos (base)**: `::before/::after/::selection/::backdrop` come from
  `matched.pseudoElements` via `resolvePseudoElement`; `::placeholder/::marker` are
  **not** surfaced by CDP, so `computedPseudo` (CDP `DOM.resolveNode` +
  `Runtime.callFunctionOn` → `getComputedStyle(el,'::x')`) is diffed against the
  element's own computed style (they inherit from it).
- **id**: reuse the existing `id` if it is still unique in the output, else generate
  `el{N}`; a duplicate source id on a later element is re-minted. Ids are set on the
  live DOM via `DOM.setAttributeValue`. Only elements with output get an id.

### Phase 4 — states (reverse), self / relational / pseudo
Rather than forcing every element × every state, the model is built backwards from
the **state-bearing selectors** collected from `document.styleSheets`:

1. `stateTargets` (parsel tokenizer) analyses each selector — including states
   nested in `:is()/:where()/:not()/:has()` — and returns
   `{ state, triggerSel, subjectSel, combinator }`. A state on the selector's last
   compound is **self** (`combinator=null`); a state before a combinator is
   **relational** (`.foo:hover .bar` → trigger `.foo`, subject `.foo .bar`,
   combinator `' '`).
2. Per state: `DOM.querySelectorAll` resolves trigger + subject nodeIds.
   **Relevance filter**: `:focus`/`:focus-visible` only on focusable elements,
   `:disabled` only on form controls. Triggers are forced (`CSS.forcePseudoState`,
   parallel); each subject's matched+computed is re-read (parallel) and
   `diffResolved` vs its `reference` gives the **delta**. Triggers are unforced.
   The **matched-under-force** re-read is where the probe path replaces CDP: when
   `useProbeState` (== `useProbe`), the subject's **computed**-under-force read
   (`getComputedStyleForNode`, ~0.25 ms/node — needed anyway for var()-dependent deltas)
   ALSO carries the raw `--czp` markers the engine lit under this force, so
   `matcher.matchedFromComputed(scomp.keys())` rebuilds the exact
   `getMatchedStylesForNode`-under-force match set with **no extra round-trip** — the marker
   read piggybacks the computed read. This is **engine-truth**: no static synthesis, so
   there is NO per-state risk gate (`:not(...)`, states in `:is/:where`, `:has(:state)` all
   correct — §10). The at-rest inline/attribute tiers are reused (force doesn't change them);
   the co-forced `['focus','focus-visible']` set (STATE_FORCE) makes both `:focus` and
   `:focus-visible` markers fire. `matchedFromComputed` returns a SELF∪RELATIONAL set (the
   same forces feed CDP identically — parity), so the SELF-state delta is
   recomputed from a **self-borne-filtered** match set (`filterSelfBorne` — only rules whose
   forced state sits on the subject's own last compound) and only for a subject that was
   actually FORCED (the eligibility gate) — so a relational or ineligible rule can't leak
   into a subject's self-state (the CDP path satisfies both by construction; see §9).
   In **subtree mode** this whole step is scoped to the subtree (§4.6): a token
   pre-filter drops any target whose subject can't be in the subtree, and the
   `querySelectorAll` runs against the subtree root — so only in-subtree triggers
   are ever forced (kills the whole-page flicker; see §9).
3. **Pseudo-element states**: while a self-state is forced, the element's
   `matched.pseudoElements` are re-read and each replicable pseudo is diffed vs its
   base pseudo map → `pseudos[pe].states[state]` (`.el:hover::after`).
4. **Keying**:
   - self delta → `selfStates[state]`,
   - relational delta → `relational[]` = `{ trigger id, state, combinator, pseudo?, delta }`
     (paired subject↔concrete trigger via the DOM: nearest ancestor for `' '`/`'>'`,
     preceding sibling for `'+'`/`'~'`).

### 4.5 Serialisation

Both entry points serialise the model through **one** rule emitter,
`styleJsonToRules` (`StyleJson` → the `#id{…}` / `#id:state{…}` / `#id::pe{…}` /
`#id:state::pe{…}` / `#trigger:state <comb> #subject[::pe]{…}` rule strings,
pseudo-class before pseudo-element) — so the two can never drift.

Within a rule the declarations are emitted in **cascade order**
(`cascadeOrdered`, §3): the map keys per DECLARED property, so a shorthand and one
of its longhands can BOTH survive as independent per-property winners, and once
flattened into one `#id{…}` rule source order decides who wins each component.
Map order answers that question WRONG — `cascadeResolve` keys a property at its
FIRST appearance and only updates the value, so a preflight `border-color` keeps a
position that says nothing about the much later winner now stored there. Sorting
by the WINNER's `order` is sound because a winner is the last occurrence of its
key, so it overrides every earlier occurrence across all components; `!important`
needs no special case (inside one flat rule it beats normal exactly as in the
cascade). `declsFromMap` lays the `StyleJson` keys out this way, so the key order
of a stored bucket IS the render order — a shorthand that BEATS one component and
LOSES another (a `border:1px solid grey` over a preflight `border-width:0`, under
a later `border-color:transparent`) lands between them, which no single "shorthand
first" or "shorthand last" position can achieve.

`declsToDeclString` still runs `orderPropsShorthandFirst` (§3) on top. On an
extracted bucket that is a no-op: it only moves a shorthand sitting after a
longhand it covers, and in cascade order that means the shorthand BEATS the
longhand, so the longhand is either gone (Pass 6/6b) or survived Pass 6's
`effectivelyEqual(value, computed)` guard — and then its value is what the
shorthand would give anyway. It stays for buckets with NO cascade provenance: the
ones `applyBucket`/`applyDiff` assemble, where an existing key keeps its position
and a new one is appended to the tail, so a patch adding `background` to a bucket
whose `background-color` beats it would otherwise repaint the element (pinned by a
Firefox-oracle fixture in `diff.browser.test.ts`).

- **`reworkHtml`** → `styleJsonToRules(modelToStyleJson(model))`, then a final
  `page.evaluate` removes all `<script>`, `<style>`, `<link rel=stylesheet>` and
  inline `style` attributes, appends the generated `<style>` (fonts + rules) to
  `<head>`, and returns `<!doctype html>\n` + `documentElement.outerHTML`. Fonts:
  `collectFontFaceCss` re-emits reachable `@font-face` / a single Google-Fonts
  `@import`. It walks each sheet's `cssRules` for `@font-face` **and follows
  `@import` rules NESTED in a sheet** (not just a top-level `sheet.href`) — a
  CSS-in-JS injected `<style>` that `@import`s Google Fonts is common: a googleapis
  import feeds the shared family set (folded into the one consolidated `@import`),
  any other import is recursed into for its `@font-face` (with the same CORS fetch
  fallback as a top-level sheet). JS FontFace-API fonts (`new FontFace(...)` added
  to `document.fonts` with no stylesheet rule) are NOT captured — their `src` is
  not readable back from a constructed `FontFace` — but real apps observed here
  load Google Fonts via a nested `@import`, not the JS API.
- **`reworkStyles`** → one self-contained `{ tree, fonts, elements, rootContext? }`
  (`rootContext` present only in subtree mode, §4.6):
  - `elements` = `modelToStyleJson(model)` (the [`StyleJson`](../README.md#json-format) map);
  - `tree` = `buildTree(treeRootEl, model.byNode)` — the document structure walked
    from the **same** `DOM.getDocument({depth:-1})` snapshot (no extra CDP call),
    rooted at `<html>` (or the subtree root element, §4.6), carrying element
    **and text** nodes; comments/doctype are omitted. It strips
    exactly what `reworkHtml` strips (`<script>`, `<style>`, `<link rel=stylesheet>`,
    inline `style`) — **not** `SKIP_REWORK_TAGS` (head/meta/title/noscript are
    kept). Element ids come from the model (`byNode`), so a minted/deduped id is
    reflected and the stale snapshot id is dropped. A text node whose `nodeValue`
    CDP truncated (its snapshot cap is ~10 000 chars) is re-fetched whole via the
    still-live session (`DOM.resolveNode` → `nodeValue`), so long `<pre>`/prose
    survives; hence the build runs **inside** `buildReworkModel` (nodeIds are
    session-scoped) and only when `reworkStyles` asks for it. Element nodes also
    carry **capture meta** — `rect` (the box RELATIVE TO THE EXTRACTION ROOT, integer
    px) and `computed` (`getComputedStyle` for the keys that survived denoise, a
    SUBSET of `base` — a shorthand with disagreeing components computes to `''`).
    Both ride the Phase-2 walk, so they cost no extra round-trip, and both are read-
    only cargo: `jsonToHtml` serialises a node by explicit fields, `diffStyles`
    works over `elements`, and the matcher never sees them (`formatTree` renders
    `rect` only under `{geometry:true}`, which the CLI passes and the prompts do
    not). `applyDiff` STRIPS them — its output was never captured, so it would mix
    the left capture with imported right-side nodes. Inherited values are absent by
    construction (denoise drops them), so an effective value is resolved by walking
    up to the nearest ancestor whose `computed` has the key; that walk terminates
    because the tree root carries the INHERITABLE set (materialised into `base` in
    subtree mode, added to the root's meta in whole-document mode);
  - `fonts` = `collectFontFaceCss(page)`;
  - `widgetCss` (optional) = `collectWidgetPseudoCss` — VERBATIM author rules whose
    selector carries a `::-webkit-*` pseudo-element (datetime-edit fields,
    scrollbars, slider parts; `::-webkit-input-placeholder` excluded — replicated
    per element as `::placeholder`), with their `@media`/`@supports` stack. Those
    parts live in the UA shadow tree — unmatchable and un-emittable per element,
    yet layout-bearing (Tailwind's preflight strips the UA `padding-block` off
    datetime fields; losing it makes a `type=time` input 2px taller). `jsonToHtml`
    and `reworkHtml` append them AFTER the generated rules. Relies on class/attr
    selectors surviving in the emitted tree; a selector keyed on a re-minted id is
    an accepted stale residual. Carried through the downstream transforms
    (clone-based ones for free; `applyStylePatch`/`applyDiff` keep the left/A
    side's verbatim — the diff mirror is backlog `t-eyawja`).
- **`jsonToHtml(json)`** (pure, no browser) → `styleJsonToRules(json.elements)` for
  the rules, serialises `tree` (void elements closed, `& < >` escaped in text and
  `& "` in attributes, `pre`/`textarea` whitespace verbatim), injects the generated
  `<style>` (fonts + rules) as `<head>`'s last child, and prefixes
  `<!doctype html>\n` — reproducing the exact document `reworkHtml` emits. In
  **subtree mode** (`json.rootContext` present) the `tree` has no `<head>`, so
  it is re-hosted under a synthetic `<html><head><style>…</style></head><body>`
  whose `<html>` carries `rootContext.fontSize` (the `rem` anchor, §4.6); fonts
  stay first so an `@import` still precedes every rule.

### 4.6 Subtree extraction (`reworkStyles({ root })`)

`reworkStyles` accepts `root?: string` to extract the subtree of one element
instead of the whole document. `buildReworkModel(page, states, doPseudos,
buildDocTree, rootSel)`:

- **locate the root**: `DOM.querySelector` under the snapshot root resolves the
  subtree nodeId; `findNodeById` finds its node object in the `depth:-1` snapshot.
  A selector resolving to `documentElement` (`<html>`) degrades to whole-document
  mode (no `rootContext`, no re-host).
- **scope the walk**: `collectReworkElements`, the DOM-adjacency `buildDom`, and
  the `snapshotComputed` in-page walk all start at the subtree root (identical
  start node + skip set keeps the two walks in lockstep). A relational trigger
  outside the subtree falls out — its ancestor chain stops at the subtree root
  (`buildDom`) and its id isn't in `info` (§9).
- **scope Phase 4** (states): two subtree-only prunings, so the whole-page state
  pass no longer runs document-wide. (a) **Token pre-filter** — the set of class
  names present in the subtree is collected once; a state target is dropped when
  its subject's **last compound** (parsed with `parsel`, so an escaped Tailwind
  `:`/`[` splits correctly — `subjectLastCompoundClasses`) carries ≥1 class and
  **none** occurs in the subtree (a class-less bare-tag/attribute/`*` subject is
  kept — conservative). A matched in-subtree subject must carry its last-compound
  class, so this can only drop targets whose subject QSA is already empty. (b)
  **Scoped `querySelectorAll`** — `nodeId = subtreeRootNodeId ?? root.nodeId`, so
  triggers/subjects resolve **within the subtree**; whole-doc mode is unchanged.
  Because a node-scoped `querySelectorAll` **excludes the scope node itself**, the
  subtree root would lose its own self-states / trigger role — so the root is
  re-added via a one-shot `el.matches` (`rootMatchesAny`) whenever it matches a
  queried selector.
- **inheritance across the cut**: the subtree root alone is resolved with
  `includeInherited=true` (`isSubtreeRoot`), so INHERITABLE props are
  materialised from its computed style onto its own rules; descendants keep
  `includeInherited=false` and inherit through the emitted rules exactly as in
  whole-document mode. In subtree mode the computed-snapshot prop union is seeded
  with the full INHERITABLE set (not just declared props) so an inherited value
  set by a UA rule / presentational attribute above the cut is still captured.
- **rem anchor**: `rem` is anchored on `:root <html>` (above the cut, not
  inherited), so materialisation can't fix it. The document `<html>`'s computed
  `font-size` is carried out as `rootContext.fontSize`; `jsonToHtml` applies it to
  the synthetic `<html>` (§4.5), fixing every `rem` with one value. (`em` is fixed
  by the materialised `font-size` on the subtree root.)
- **unitless line-height across the cut**: `getComputedStyle` reports line-height
  as *used px*, never the factor — `1.5`@16px and a literal `24px` both read
  `24px`, yet descendants with a different `font-size` must scale in the first
  case and must not in the second. The factor being unrecoverable from computed
  values, `probeLineHeightFactor` probes BEHAVIOUR: a hidden probe child with a
  huge explicit `font-size` is appended to the subtree root and its computed
  line-height read — scaled ⇒ the inherited value is a factor, and the root's
  materialised `line-height` is emitted as that factor (7 significant digits, a
  float32 round-trip onto the browser's own arithmetic); unscaled ⇒ a length,
  and the materialised px stands. `display:none` on the probe: computed
  line-height resolves without layout, so nothing flickers. Only the
  MATERIALISED entry is rewritten — a line-height the root declares itself
  already carries its authored form.

### 4.7 Frame-scoped extraction (`reworkStyles({ frame })`)

`reworkStyles` accepts `frame?: Frame` (a Playwright frame) to extract from an
**iframe** instead of the top document (css-diff's web UI picks inside two embedded
target frames). **Frame mode is served by the CDP matcher** regardless of
`CSS_SNAPSHOT_MATCHER` (the driver gates probe on `!frame`): frame-scoped probe-sheet
injection (which document/session to inject into, cross-origin sheet harvest per
frame kind) is unproven, so it is deferred (`t-4ycjsr`, §10). `buildReworkModel`
classifies the frame and acquires the right CDP session:

- **cross-origin OOPIF** — the frame runs in its own renderer process, so it gets
  its **own** frame-scoped CDP session (`context.newCDPSession(frame)`); all
  `CSS.getMatchedStylesForNode` / `DOM.*` calls target that session's document.
- **same-site same-process child** — `newCDPSession(frame)` throws (no separate
  target), so the frame is reached through the **page** session via
  `DOM.getDocument({ pierce: true })`, walking into the child document from the
  parent snapshot.

Either way every in-page `page.evaluate` is issued **in the frame's context**, so
`root` and state selectors resolve against the frame's own document. The
resolve / de-noise / cascade core is frame-agnostic: **only** session acquisition
and document rooting are coupled to the frame; the rest of the pipeline (§4)
runs unchanged. `frame` combines with `root` (the tool always passes both — a
picked subtree inside a target iframe).

## 5. Cascade resolution (`cascade.ts`)

`cascadeResolve(matched, inlineStyle, attributesStyle)` picks one winner per
property. Declarations are pushed in **priority tiers** so push-order encodes the
whole cascade:

1. `attributesStyle` (presentational attrs) — **lowest**.
2. `matched.matchedCSSRules` — **kept in CDP's order**. CDP returns them in
   ascending cascade order (winner last), already accounting for **specificity,
   source order AND `@layer`**.
3. `inlineStyle` — **highest** (normal).

Winner = `beats()` = **`(important, push-order)`** — important beats normal, else
later push-order wins. The winner is **not** re-derived from specificity, because
that is `@layer`-blind (a later layer beats a higher specificity in an earlier
layer). `specificity` is recorded on `ResolvedDecl` but does not drive selection;
`declBeats` (the de-noise shorthand check) uses the same `(important, order)` rule.

## 6. De-noise (`denoiseResolved` in `resolve.ts`)

Strips noise from the resolved author map while staying render-faithful.
Parameters: `includeInherited` (materialise inherited props from computed — only
the single-element path, **false** in rework), `dropDefaults` (run the tag-default
drops — **false** when building the state-diff reference), `protectInherited`
(never drop INHERITABLE via tag-default — **true** in rework, because inheritance
flows through the emitted rules).

Order of operations:
- `var()` → `resolveVars`; `calc()` → `simplifyCalc`; `box-shadow` → strip
  transparent layers; `calc(infinity*1px)` → `9999px`. A near-infinite radius
  that **resolved** to a raw number (a `calc(infinity*1px)` pill computes to
  FLT_MAX `3.40282e38px`, past the literal-calc replace) is clamped per-component
  to the same `9999px` (`clampHugeRadius`, threshold `1e6px`) on the
  `border-radius` shorthand **AND its four corner longhands**
  (`border-{top,bottom}-{left,right}-radius`). Render-equivalent (both max the
  corner on any real box); clamping **both** forms is what makes the shorthand
  string-equal to its longhands (`3.40282e38px` vs `3.40282e+38px` → both
  `9999px`) so Pass 5 collapses them.
- **IACVT / pass-through**: a decl whose `var()` was undefined-with-no-fallback
  (`resolveVars` flags it) — or whose value is `revert`/`revert-layer` — is replaced
  by the element's **computed** value (the browser already resolved it), so the
  broken remainder is never emitted.
- **Pass 1** drop `ALWAYS_DROP_PROPS` + custom props (`--*`).
- **Pass 2** SVG: drop `SVG_GEOMETRY_PROPS` + `isSvgLayoutNoise` — **except keep
  `width`/`height` on the root `<svg>`** (Tailwind CSS-sizes icons). Paint
  (`fill`/`stroke`/…) is **not** dropped (CSS-set paint is load-bearing).
- **Pass 3** drop a decl whose computed value == the **effective** default —
  **skipping** `CONTEXT_DEFAULT_PROPS`, INHERITABLE (if `protectInherited`), and a
  zero `border-width` when a visible `border-style` is present (`borderStyleActive`).
- **Pass 4** drop a shorthand whose expansion is all-effective-default (same skips).
- **The effective default** (`baseFor`/`equalsEffectiveBase`, shared by Pass 3/4) is
  what the EMITTED rule set makes the property fall back to, which is the bare-tag
  UA default only while nothing re-bases it: a surviving shorthand whose expansion
  covers the key supplies the base instead. Load-bearing on a tag with a NON-ZERO UA
  default (form controls — `button{border-width:2px;padding:1px 6px}`) under a
  preflight `*{border:0 solid;padding:0}`: a `border-b-2` merely COINCIDES with the
  UA 2px, so comparing against the bare default erases the underline **and** 2px of
  height. The base index is built ONCE off a SNAPSHOT taken before either pass
  mutates `resolved`, so the outcome can't depend on key order. Four details make
  it hold:
  - **only a shorthand the candidate BEATS supplies a base** (`declBeats`). Without
    that asymmetry two shorthands covering one slot (a preflight `margin:0` and a
    `margin-block:0` utility, or `border` against its own `border-width`/`-style`/
    `-color`) prove each OTHER redundant and BOTH vanish, handing the slot back to
    the UA. The strongest carrier of a slot therefore never finds a base and always
    faces the tag default — the "would the UA give us this anyway?" question — while
    a candidate that LOSES to a covering shorthand is dead regardless (Pass 6/6b),
    so its extra keep costs nothing.
  - logical↔physical keys meet at **axis** granularity (`boxSlot` — the computed
    enumeration `getTagDefaults` walks reports `padding-inline-start`, while
    `expandShorthand('padding',…)` emits `padding-left`), with the resulting
    ambiguity answered by dropping only when EVERY candidate base agrees.
  - that bridge is **off under a vertical writing-mode** (`vertical-*` and
    `sideways-*`, both of which Chrome reports verbatim), where the inline axis is
    top/bottom. Swapping the map to match is not enough, because the other side of
    the comparison is measured wrong too: `getTagDefaults` runs in a horizontal
    iframe, so a tag whose UA default is LOGICAL (`p{margin-block:1em}`,
    `input{padding:1px 2px}`) reports it on the wrong physical sides, and a swapped
    bridge turns that into a DROPPED declaration. Off means the comparison degrades
    to the tag default — keep-biased and render-safe — until the defaults are
    measured per writing-mode (backlog `t-hv97va`, which also re-enables the swap).
    An absent `writing-mode` in the computed union means no rule on the page
    declares one, i.e. the initial `horizontal-tb`.
  - a CSS-wide keyword is no base at all (the preflight `font:inherit` IS an
    expansion `expandShorthand` models, and counting it would keep every font
    longhand alive in the single-element path, where INHERITABLE is unprotected).

  The comparison cuts both ways: a decl equal to the re-based value is noise even
  when it differs from the UA default (a CDP-expanded `border-*-width:medium` next
  to a surviving `border:none`).
- **Pass 5 / 5b** collapse longhand into a covering shorthand / shorthand into a
  covering shorthand.
- **Pass 6** drop a dead-on-arrival longhand a covering shorthand beats (`declBeats`),
  where the shorthand is one `expandShorthand` models (box/border/flex/…).
- **Pass 6b** the same drop for the shorthands `expandShorthand` does NOT model —
  `SHORTHAND_COVERAGE` (background/background-position/font/list-style/text-decoration/columns/column-rule).
  VALUE-INDEPENDENT: a shorthand fully determines all its component longhands (an
  omitted one → its initial), so a covered longhand at LOWER cascade order
  (`declBeats(shorthand, longhand)`) is dead. Coverage is matched by EXACT longhand
  name, so a loser survives whenever the two spellings differ — a logical longhand
  under a physical shorthand (`border` vs `border-inline-start-width`), or a
  shorthand under a shorthand (`border` vs a losing `border-color`) — and the
  shorthand-first EMISSION order (§4.5) then lets it clobber the winner. The
  `boxSlot` bridge Pass 3/4 uses is not wired in here; backlog `t-5g1mcr`.
- **Pass 7** when all four computed border widths are `0px`, drop border style/color
  — but **keep `border-style:none/hidden`** (the suppressor; dropping it lets a UA
  `outset` reappear next to a non-zero width).
- **Pass 8** drop outline props when the outline doesn't render.

### The "context-dependent default" principle (why the protections exist)
The bare-tag UA default is the wrong baseline whenever another kept declaration, or
the element's context, changes what the property actually falls back to:
- a surviving **shorthand** re-bases every key its expansion covers, so a longhand
  equal to the bare-tag default is load-bearing (the effective-default rule above).
- `border-width:0` is load-bearing when `border-style` is visible (else `medium`
  UA width shows).
- `min-width`/`min-height` default `auto` reads as computed `0` on a block but is
  `min-content` in a flex/grid item (`min-h-0`/`min-w-0`).
- `width`/`height`: a bare (empty) element computes `height:0`, but the real element
  has content — so `height:0` (a collapsed accordion) is load-bearing.
- `box-sizing`: Chrome sets form controls to `border-box`, Firefox to `content-box`
  — so a declared `border-box` matching the Chromium default is load-bearing when
  viewed elsewhere.
- an element with the `hidden` attribute: its UA default is `display:none`, so a
  visible-despite-`hidden` element's `display` is re-emitted.

These live in `equalsEffectiveBase`, `CONTEXT_DEFAULT_PROPS`, the border guards, and
the `hidden`/display handling. The pattern to watch when editing the drop passes:
"we dropped X because it == the bare default, but X was suppressing/overriding
something."

## 7. Property-classification tables (`resolve.ts`)

- `INHERITABLE` — CSS-inherited props. Used to (a) materialise inherited values in
  single-element mode and (b) **protect** inherited props from the tag-default drop
  in tree mode. A genuinely-inherited prop **missing** here → a descendant's
  reset-to-default is dropped and the ancestor's value leaks in.
- `ALWAYS_DROP_PROPS` — non-visual noise (transitions, animations, font smoothing,
  scroll-behavior, print/break, …), dropped unconditionally. A **visual** prop
  listed here is silently lost — only add props that never affect a static render.
- `SVG_GEOMETRY_PROPS` / `SVG_TAGS` / `isSvgLayoutNoise` — **true geometry only**
  (`d,x,y,cx,cy,r,rx,ry,width,height`) is stripped on SVG; paint is kept.
- `CONTEXT_DEFAULT_PROPS` — never tag-default-dropped (see §6).

`extractionDropsProperty(prop, kind)` exports pass 1/2 as a predicate — the
UNCONDITIONAL half of the drop set, per element kind (`none` / `svg-root` /
`svg-inner`). It is what css-diff's corpus fidelity harness
subtracts before comparing an original page's computed styles against its
reproduction, so the harness's exclusions cannot drift from the tables above.
The value-dependent passes (6 pass 7/8, the shadow strip, the radius clamp) are
NOT in it: they are decided per value, and the harness re-derives their
preconditions itself.

## 8. Value + selector helpers

- `resolveVars` walks the value with `postcss-value-parser`, replacing `var(--n)`
  with the computed custom-prop value (fallback used only when the var is missing;
  an undefined var with no fallback flags the decl IACVT, see §6).
- `simplifyCalc` → `reduce-css-calc` (throws on `infinity`, caught).
- Colours compared/normalised with `colord` (`effectivelyEqual`); the **diff**
  additionally uses `culori` for wide-gamut / `color-mix()` equality (§11
  `canonicalizeColor`, comparison-only — never emitted).
- `expandShorthand` is a hand-rolled table (margin/padding/inset/border*/gap/
  place-*/overflow/outline/logical/**flex**); `margin-inline`/`-block` emit
  **logical** longhands only (physical left/right would be wrong under
  RTL/vertical). `flex` follows the spec defaults (a bare number → `flex-basis:0%`,
  matching Chrome's computed serialisation; keyword `none`/`auto`/`initial`
  handled), so Pass 5/6 collapse the `flex:1` + `flex-grow`/`flex-basis` trio;
  it is a **shared** primitive (also `diff.ts` `expandBucket`), so a flex diff
  now emits granular longhand keys. `font`/`grid` are deliberately NOT here
  (complex; backlog `t-4av4s0`).

## 9. Known limitations

The tool is robust on box-model, cascade, values, states (self + relational +
pseudo), inheritance, forms, tables, SVG and RTL. Residual gaps, all rare:

- **`!important` + `@layer`**: layer order **reverses** for important declarations
  (earlier layer wins), which CDP's normal-order array doesn't encode.
- **Defined-empty custom prop** (`--e: ;`) wrongly triggers the `var()` fallback —
  `getComputedStyle` can't distinguish empty from undefined.
- **`all: revert-layer`** is dropped rather than materialised (`getComputedStyle('all')`
  is `''`).
- **Pseudo-element state reset-to-default** — a `.el:hover::after` that returns a
  prop to its pseudo default is dropped (`resolvePseudoElement` has no
  `dropDefaults:false` reference like the element path), so the base value persists
  under the state.
- **Shadow DOM** is not serialisable via `outerHTML` (inherent).
- **JS FontFace-API fonts** — a font added purely via `new FontFace(family, src, …)`
  → `document.fonts.add(…)`, with **no** stylesheet `@font-face`/`@import` rule, is
  NOT captured: a constructed `FontFace`'s `src` is not readable back, so
  reconstructing the rule would need a pre-navigation constructor hook. Fonts loaded
  through CSS — including a Google-Fonts `@import` **nested** in a CSS-in-JS
  `<style>` (now followed, §4.5) — are captured. (Real apps observed load Google
  Fonts via the nested `@import`, not the JS API.)
- **Baked-artifact declaration order** — the key order of a `StyleJson` bucket IS
  the render order (§4.5), and extraction lays it out per the cascade. A bucket
  produced any other way carries no such guarantee: an artifact stored BEFORE the
  cascade-order emission landed keeps whatever order the resolve map happened to
  have, and a patched bucket (`applyBucket` appends a new key to the tail) is
  ordered by the patch, not the cascade. Both lean on the `orderPropsShorthandFirst`
  safety net, which fixes the shorthand-vs-longhand case but not shorthand-vs-
  shorthand (`border` against `border-color`). Re-extraction fixes a stale artifact.
- **Relational `:has(:hover)`** keying — the delta is captured but keyed on the
  subject, not the relational trigger, and nested identical triggers pair only the
  nearest ancestor.
- **Color alpha is colord-precision (tool-wide)** — `colord` rounds alpha to 2
  decimals at parse, and every *sRGB* color equality in the tool routes through it:
  `effectivelyEqual` (extraction de-noise), the diff's `canonValue`, and the
  `box-shadow`/`text-shadow` canonicaliser (§11) alike. (The diff's wide-gamut path —
  `canonicalizeColor`, §11 — parses via `culori` but **re-formats through colord**, so
  the same 2-decimal alpha fuzz still applies there.) So two colors within ≤~1/255
  alpha — `#…07` vs `#…08`, whether on `color:` or inside a `box-shadow` — are **not
  string-equal**, but compare equal here and diff to an empty patch. This is **not a
  shadow quirk**: the shadow canonicaliser inherits the same precision as a plain
  single color (both golden-pinned). RGB channels stay integer-exact; the alpha error
  (≤~1.3/255 per channel) is below the pixel-identity threshold, so equal **within the
  render-identity contract** — the standard this tool is verified against — even
  though the source strings differ.
- **Wide-gamut color equality is culori-round-tolerance (diff only)** — the diff's
  `canonicalizeColor` (§11) resolves `oklch`/`oklab`/`color-mix()` to rgb via `culori`
  and compares at integer-channel rounding (~0.5/255). So two representations *within*
  that tolerance equate (e.g. `color-mix(in oklab,#fff 15%,transparent)` ==
  `rgba(255,255,255,0.15)`), but a wide-gamut pair *further* apart legitimately stays
  distinct (e.g. `oklch(0.905 0.003 260)`→`rgb(222,224,226)` vs `#e7e7eb`→`rgb(231,231,235)`
  do **not** equate — a real ~9/255 difference, correctly surfaced). A `color-mix()` in a
  **polar** space (hue channel — `oklch`/`lch`/`hsl`/`hwb`) is not evaluated (circular hue
  interpolation) and falls back to the token compare (no false equality). Comparison-only:
  the emitted color is never rewritten.

### Probe matcher (`CSS_SNAPSHOT_MATCHER=probe`) — §10

The probe path is **render-identical** to CDP (Firefox pixel 0.000 % on the reference
page) and, in two respects, **more** correct — but it emits a distinct, render-equal
*representation* and gates a few state selectors to CDP. All verified by
`probe-cdp-differential.browser.test` (whole-doc tripwire) + `probe-state-differential`
(under-force) + the full battery under the flag:

- **`!important` × `@layer` — parity, NOT a new regression.** The probe cascade glue
  encodes normal-declaration layer order like CDP's array; the `!important`-reverses-layer
  gap (above) is present on **both** paths identically.
- **Representation, not bytes** — probe keeps css-tree's authored values and collapsed
  shorthands; CDP reserialises (`0`→`0px`, calc-arg reorder, hex↔rgba, case) and expands
  shorthands + vendor aliases into rangeless longhands. Render-equal; byte-identity is
  infeasible (Chrome's calc serialisation isn't reconstructable from source). Hence the
  per-matcher Guard 1/2 baseline and the tripwire that folds these classes. One
  reserialisation loss is SUB-RENDER-EQUAL on cdp only: Chrome truncates a reduced
  unitless calc to ~6 significant digits (`calc(1/0.75)` → `1.33333`), which floors a
  line box 1/64 LayoutUnit down vs the original — the probe path reduces the AUTHORED
  text at precision 12 (`simplifyCalc`) and stays exact (the t-tapdjv guard is
  probe-only for this reason).
- **Group-hover relocation — probe MORE correct.** A relational `opacity` (`.group:hover
  .child{opacity:1}`) is keyed on `relational` by the probe path (the self-borne + forced-
  eligibility filters, §4). The CDP path force-holds the trigger document-wide and so
  **leaks** it into the child's own `states.hover` too — a latent over-emit invisible to
  the resting-pixel oracle. The probe output is the intended one (the relational entry
  reproduces the effect; the self-state doesn't fire without the trigger).
- **`::placeholder` / `::marker` inert deltas.** Both read via `computedPseudo`; the probe
  path's `computedMap` is author-cascade-only (no UA-rule props), so it emits a few EXTRA
  inert inherited deltas there (`font-family:Arial`, `text-decoration-line:none`) that CDP
  suppresses. Always the pseudo's real inherited value → render-equal. (The actual
  placeholder colour — author OR UA default — is captured correctly on both paths.)
- **State deltas — NO gating (engine-truth re-read).** Phase-4 reads the under-force match
  set by re-reading the raw `--czp` markers under `CSS.forcePseudoState` (§10), so EVERY
  state-selector class is exact vs CDP-under-force — `:not(...)` (incl. impure `:not(:hover.y)`
  / nested `:not(:is(:hover))`), states inside `:is/:where`, and `:has(:state)` (incl. `>`- and
  complex args). The old static-synthesis gate (`risk.negatedState`, 4 unproven classes) is
  GONE. (A DRIVER-side discovery gap remains for `:is(<complex> *)` — Tailwind `focus:**:` /
  `group-has-*` — where `stateTargets` mis-locates the trigger, so the delta isn't *captured*;
  PRE-EXISTING on BOTH paths, orthogonal to matching, deferred to `t-znnpt4`.)
- **Frame mode** (§4.7) always uses CDP (`t-4ycjsr`).
- **Runtime-mutated sheets** (Vite dev / speedy `insertRule`) are HANDLED by the dual-source
  inventory (harvested from CSSOM, §10), NOT a fallback. A sheet mutating **mid-extraction**
  (a live HMR update landing in the ~1 s census→marker-read window) is NOT guarded — re-extract
  (backlog `t-65ge0w`). And a nested **state** rule (`.a{&:hover{…}}`) surfaces its at-rest
  form but not its state DELTA: phase-4's state-selector enumeration reads the raw `&:hover`
  `selectorText`, which is unusable standalone (a FLAT inserted `.a:hover` is captured fully).
- **Bare-class nesting → CSSOM harvest** (representation, not a bug): css-tree parses `&`-led
  nesting (`&:hover`, `& .kid`) as a rule, but a nested rule that starts with a BARE selector
  (`.a{ .b{…} }`, no `&`) is a `Raw` node it under-counts, so the census reports more rules and
  the sheet is HARVESTED from CSSOM. Render-correct (probe==CDP), only CSSOM-reserialized values
  instead of authored. Re-parsing the Raw is not attempted (unreliable boundaries; a wrong
  text-parse is worse than a render-correct harvest). `&`-nested sheets (Tailwind v4) text-parse.
- **Unhandled surfaces fall back whole-doc** (`risk.mustFallbackToCdp`): `@scope`, a
  `sourcelessSheet` (text AND CSSOM both unreadable — rare), a literal-brace selector.

### Subtree mode (`reworkStyles({ root })`) — §4.6

Scope is **inheritance only**; these diverge in a standalone subtree by design:

- **Layout context** — a `%`/flex/grid/`position:absolute` value that resolved
  against an ancestor now *outside* the subtree lands in a different containing
  block standalone. Not fixed (would require re-parenting the layout, not just
  inheritance).
- **Container-query units** (`cqw`/`cqi`/…) — the query container may be above the
  cut, so they resolve against the synthetic root instead. Not fixed.
- **Out-of-subtree relational trigger** — `.foo:hover .bar` where `.foo` is above
  the cut is dropped (the trigger id isn't in the output); the delta on `.bar`
  can't be keyed. Since the Phase-4 QSA is subtree-scoped (§4.6), `.foo` is also
  never **forced**, so its effect no longer contaminates `.bar`'s **self**-state
  either. (Before scoping, `.foo` was force-held document-wide while `.bar` was
  read, so when `.bar` was independently a self-hover subject the `.foo:hover .bar`
  declarations leaked into `.bar`'s `selfStates[hover]` — inconsistent with the
  trigger being "dropped". Scoping makes the drop consistent; this is the one
  intended output difference from the pre-scoping behaviour, verified by a golden
  guard in `subtree.browser.test.ts`.)
- **Non-flow-content root** — the subtree is re-hosted under `<html><body>`, so a
  `<tr>`/`<td>`/`<option>`/`<li>` root would be foster-parented by the HTML parser
  on reload. The root must be flow content; a smart wrapper is deferred — backlog
  `t-j0kp5c`.

## 10. The author-cascade matcher — probe (default) vs CDP (`CSS_SNAPSHOT_MATCHER`)

Phase 1 (per-element author matching) is the dominant cost of the whole pipeline:
one `CSS.getMatchedStylesForNode` per element re-matches the node **and its whole
ancestor chain** against every sheet, and the CDP backend **serialises** the calls
(`Promise.all` can't parallelise them) — **110 s** for a 441-element production Tailwind
page, ~250 ms/call. The tool now has **two** matchers, selected by
`CSS_SNAPSHOT_MATCHER=probe|cdp` (driver `matcherMode()`):

- **`probe` (default)** — `src/probe-matcher.ts`. Instead of asking CDP to match
  node-by-node, it lets the **browser itself** match ALL nodes at once: it injects
  ONE generated *probe sheet* (each author `(rule, selector)` becomes
  `SEL{--czp<nonce>_<i>:1}`, wrapped in the rule's real `@media/@supports/@container/@scope`
  stack, never `@layer`) via an inspector stylesheet, then reads every element's set
  markers in **one `page.evaluate`**. The real engine has already evaluated every
  condition against real layout, so the marker set IS the exact matched
  `(rule, selector)` set — `@layer`/`@container`/`@scope`/`@media`/cross-origin
  natively handled. A small hand cascade-order glue (layer first-mention → specificity
  → source order) synthesises the same `MatchedStyles` shape CDP returns, feeding the
  **unchanged** `resolveElementStyles`/`cascadeResolve`. Result: phase-1 **110 s →
  ~1.5 s**; whole-doc on that page **153 s → ~2.5 s**.
- **`cdp`** — the original per-node `getMatchedStylesForNode` path, kept permanently
  as the correctness floor and the automatic fallback (below).

**This reverses the earlier "why not an in-page matcher" conclusion** — but the probe
approach is NOT the rejected design. The rejected one reimplemented the cascade in-page
over `document.styleSheets` + `el.matches`, which is unreliable (CSSOM serialises
shorthands inconsistently; no data for `@container`/`@scope`/cross-origin). The probe
approach hand-writes **nothing** about matching — it defers 100 % of selector/condition
evaluation to the real engine via injection, and hand-writes only the cascade *ordering*
(differentially proven exact vs CDP — see `test/probe-matcher.browser.test.ts`). The
inspector sheet is CSP-immune and invisible to page observers. It also outlives the CDP
session that created it, so the extraction EMPTIES it when it ends (`ProbeMatcher.dispose`, in
`buildReworkModel`'s `finally`, on a rejected build, and on a build that throws) — else a live
page keeps its `--czp*` markers, visible to DevTools and to a chrome-devtools `get_css_styles`.
The emptied sheet itself stays (CDP has no call to delete an inspector sheet): one empty sheet
per extraction per frame. Inspector sheets are separate per creating call (proven by computed
styles — a FRESH session's `CSS.getStyleSheetText` misreports foreign inspector sheets, all
with the text of the last one, so text read that way is no evidence), so emptying ours never
touches another client's. Should a sheet survive anyway (an extraction killed before its
`finally`), it cannot corrupt a later one: each build draws a random marker prefix
(`--czp<nonce>_<i>`) and reads only its own.

**Tier assembly.** The probe matcher synthesises only the author `matchedCSSRules`
(+ `pseudoElements`); the driver assembles the other two cascade tiers per node from
**`CSS.getInlineStylesForNode`** (`inlineStyle` + `attributesStyle` — the same
`presentationAttributeStyle` backend `getMatchedStylesForNode` uses, so byte-identical).
That call does **no** ancestor re-match (~0.1 ms/node), so a per-node CDP round-trip
here is negligible — the epic's cost is the ancestor match, not the round-trip. This
replaces the epic's proposed hand-rolled presentational-attribute data table (a large,
fragile surface — e.g. `-webkit-locale` from `lang`) with the browser's own mapping.

**Representation difference (render-equal).** The probe path takes declared *values*
from **css-tree** (the authored text, verbatim); CDP **reserialises** them (`0`→`0px`,
`calc(100vw - 16px)`→`calc(-16px + 100vw)`, hex↔rgba, `currentColor` case) and
**expands** shorthands + vendor aliases into extra rangeless longhands (`appearance`
alongside `-webkit-appearance`, `background` → `background-color`/`-position-x`/`-y`,
…). So the two paths emit **render-identical but NOT byte-identical** output — Chrome's
calc serialisation alone can't be reconstructed from source, so byte-identity is
infeasible. Verified render-equal by the Firefox pixel oracle on the probe path (ref
page 0.000 %). Consequences: Guard 1/2 have a **per-matcher baseline**
(`rework-baseline-rules[.probe].json`); the frame guards pin both sides to one matcher;
a dedicated `test/probe-state-differential` + a whole-doc `canonicalStyleJson(probe)`
tripwire pin the equivalence. In two respects the probe path is **more correct** than
CDP (see §9): a group-hover relational effect is not leaked into a subject's self-state,
and it emits fewer redundant expansion keys.

**Dual-source rule inventory (§3 module note).** `CSS.getStyleSheetText` returns a sheet's
**source text**, which MISSES rules a page added at runtime via `insertRule` — the real
`@tailwindcss/vite` dev / CSS-in-JS "speedy" case, where a **URL-backed** sheet's utilities
are inserted into the live CSSOM but the fetched source never contained them. The call
SUCCEEDS, so the miss is **silent** (a Vite-dev page would snapshot broken/mobile). So the
inventory is built **per sheet from whichever source is authoritative**: (1) a one-shot
in-page **census** counts each sheet's live CSSOM style rules (recursively, counting nested
`CSSStyleRule` + `CSSNestedDeclarations`, keyframes skipped; `-1` when `cssRules` throws —
cross-origin); (2) a **detector** flags a sheet whose live CSSOM has **strictly more** style
rules than its source text (`census > text` — the `insertRule` signature) as CSSOM-
authoritative. The detector is **directional**: the REVERSE (`text > census`) is a pristine
representation quirk (css-tree keeps rules the browser DROPS — e.g. a cross-browser-only
`:-moz-ui-invalid` in Tailwind's preflight), NOT a mutation, so the source text stays
authoritative there (harvesting would needlessly swap authored values for CSSOM-reserialized
ones and break the byte baseline on a static page). A runtime `deleteRule` (also `census <
text`) is the one residual the count detector can't tell from that quirk — rare, deferred with
the mid-extraction drift guard (`t-65ge0w`); (3) a second in-page **harvest** walks the flagged sheets' live CSSOM
(nested rules desugared `& → :is(parent)`, `CSSNestedDeclarations` → an implicit rule on the
parent, `@layer` statements feeding the layer order, condition stacks accumulated,
declarations via `rule.style.cssText`). **Pristine (static) sheets keep the raw-text parse**
(authored values verbatim) — a NO-OP on a static page; cross-origin sheets are CSSOM-
unreadable but ALSO immutable to page JS, so their CDP text is authoritative by construction.
A false-harvest of a pristine sheet is render-SAFE: the CSSOM inventory is render-correct, only
the value representation differs (the same class as CDP's own reserialization — §Representation).
The text parser gained the SAME `&`-desugar + implicit-nested-decl synthesis so a pristine
authored-nesting sheet stays count-aligned with the census (no false harvest) and its nested
rules resolve exactly as CDP's. `parseSheet` no longer skips native nesting (the old `ruleDepth`
skip was a latent correctness hole on any nesting page). Validated by the spike (`spike-probe.ts`,
80/80 match-set/order/winner on a live Vite dev server) and the committed synthetic
`test/probe-dualsource-differential.browser.test.ts` (probe == CDP on a URL-backed
`insertRule` page). Perf: census+harvest adds ~0.5 s; a whole-doc Vite-dev page is correct at
~1 s (vs the ~230 s a per-node CDP fallback would cost, rejected as a fallback).

**Safety net / fallback (the CDP path is permanent).** `probe-matcher.ts` surfaces a
`ProbeRisk`; the driver consumes it at two granularities:
- **`risk.mustFallbackToCdp`** (`scope` | `sourcelessSheet` | `droppedBraceSelector`) —
  risks that poison the **at-rest** match set → the WHOLE extraction uses CDP.
  `sourcelessSheet` = a sheet whose CDP text AND live CSSOM are BOTH unreadable (rare — a
  cross-origin CORS sheet whose `getStyleSheetText` also threw): no authoritative rule source.
  A `getStyleSheetText` failure ALONE is NOT a fallback (it sets the DIAGNOSTIC
  `sheetTextFailed`) — the dual-source inventory harvests that sheet from CSSOM.
  There is **no under-force state gate**: state deltas are read as ENGINE-TRUTH (below), so
  no state-selector class needs a fallback.
- **build failure** (lockstep walk drift / a zero-sheet `CSS.enable` replay miss,
  detected as `probeCssBytes === 0`) → CDP.
- **frame mode** (§4.7, OOPIF + same-process) is served by CDP: frame-scoped probe
  injection is unproven (`t-4ycjsr`).

**Under-force state deltas — raw-marker re-read (engine-truth, no synthesis).** The injected
probe sheet PERSISTS through phase-4 (the matcher's session is held open until then), and it
carries each author `(rule, selector)` VERBATIM. Under `CSS.forcePseudoState` the REAL ENGINE
re-evaluates that sheet, so re-reading a forced subject's `--czp` markers yields EXACTLY the
`(rule, selector)` set `getMatchedStylesForNode` would return under that force — `:not(...)`
(incl. impure `:not(:hover.y)` / nested `:not(:is(:hover))`), states inside `:is/:where`, and
`:has(:state)` (incl. `>`- and complex args), all natively correct. Phase-4 does NOT static-
synthesise a state match set: the marker read piggybacks the per-subject
`getComputedStyleForNode` (which returns the registered `--czp*` custom props), so
`matchedFromComputed(computed.keys())` rebuilds the set with ZERO extra round-trips. No
state-stripped probe variant is generated (the strip machinery + the `negatedState` gate + the
four unproven-class detectors are GONE); `stateTargets` still analyses selectors, but only for
DISCOVERY (which nodes to force / read). Because both the probe and CDP paths now read
engine-truth under the SAME forces, phase-4 is EXACT vs CDP for every state-selector class.
(This was validated live before the build — `spike-has-force.mjs`, `:has(:state)` under force
on an inspector sheet, reversible.) The residual is a `stateTargets` DISCOVERY gap for
`:is(<complex> *)` (Tailwind `focus:**:` / `group-has-*`) that mis-locates the trigger on BOTH
paths — orthogonal, deferred to `t-znnpt4`.

The differential harnesses are the standard of proof: `probe-matcher.browser.test`
(at-rest match/order/winner vs CDP + the under-force marker re-read vs `forcePseudoState`),
`probe-state-differential.browser.test` (the under-force battery — `matchedFromComputed`
re-read vs CDP `getMatchedStylesForNode` under force, EXACT for every hole pattern + the
`:is(.X:focus *)` / `:has(:disabled)` families, no gate),
`probe-cdp-differential.browser.test` (the whole-doc `canonicalStyleJson(probe)==cdp`
tripwire — every divergence folds to a known representation class or the group-hover
relocation), and the whole `*.browser.test` battery run under `CSS_SNAPSHOT_MATCHER=probe`
(Firefox pixel + every golden).

## 11. Style diff / patch (`diff.ts`)

A **downstream consumer** of two extracted `SelfContainedStyles` artifacts
A (old) / B (new), sitting *after* the pipeline (§4) — it never touches CDP. It
emits an **applicable** `StylePatch` such that `applyStylePatch(A, patch)` is
canonically == B, so `jsonToHtml` of it renders pixel-identically to
`jsonToHtml(B)`.

**Precondition (contract, not detected):** A and B are the **same DOM/structure**,
extracted with the **same** `states`/`pseudoElements`/`embedFonts` opts, differing
only in styles. Identical structure ⇒ deterministic id-minting ⇒ a shared, stable
id space ⇒ the patch keys purely by element id (no structural / children diff).
Residual limit = the same subtree-boundary caveat as §9.

### Shape
`StylePatch = { elements: Record<id, ElementPatch>; rootContext?; fonts? }`.
`ElementPatch = { removed?; base?; states?; pseudos?; relational? }`. A bucket
delta is `BucketPatch = { set: Decls; delete: string[] }` at **longhand**
granularity. `rootContext`/`fonts` carry B's value only when they differ.

### Longhand granularity (why)
Both sides' buckets are expanded via `expandShorthand` (`!important` split off,
re-folded per longhand; order-preserving, later-wins), diffed at the longhand
level, and applied at the longhand level:
`applyBucket(A, bp) = { …omit(expand(A.bucket), bp.delete), …bp.set }`. This makes
a shorthand-vs-longhand representation difference that renders the same (`margin:8px`
vs four equal `margin-*`) a **no-op** (empty patch), and gives a clean apply
regardless of which form each side used. Re-collapsing applied longhands back to
shorthands is skipped — a patched bucket emits longhands, an unpatched one keeps
A's representation. Note this is cosmetic only for the CANONICAL compare: a
patched bucket loses the cascade key order an extracted one carries (§4.5), so its
render leans on the `orderPropsShorthandFirst` net in `declsToDeclString`.

### Value compare — minimality, not correctness
`valuesEqual` reuses `effectivelyEqual` (colors across formats, zero-units,
whitespace) on the bare value, but first requires the `!important` flags to match
(`red` ≠ `red !important`, folded in the value string). Case-sensitive string
props (`content`, `quotes`, `grid-template-areas`/`grid-template`/`grid`,
`counter-*`) are compared bit-exact — `effectivelyEqual` lowercases, which would
else silently drop a real `"Hello"`→`"hello"` change. A `url()`-bearing value is
compared case-preserved (whitespace-collapsed only), because `url(A.png)` ≠
`url(a.png)` on a case-sensitive host would else be masked — and, crucially,
`canonValue` (the round-trip oracle) applies the **same** url path, so the two
stay in lockstep.

Four **representation-invariant** pre-steps run before the `effectivelyEqual`
compare (all shared with `canonValue` for lockstep):

- **huge `border-radius`** (`canonRadius`) — a near-infinite pill
  (`calc(infinity*1px)`) computes to FLT_MAX (`3.40282e+38px`); the extractor clamps it
  to `9999px` at source (§6 `clampHugeRadius`, threshold `1e6px`), but a stored artifact
  predating the clamp still carries raw FLT_MAX. Both max every real box's corner, so on a
  `radius` prop (`prop.endsWith('radius')` — the 4 corners + logical variants) any px
  length ≥ the same `1e6` threshold is canonicalised to `9999px` (a fixed point: 9999 <
  1e6), so a `9999px`-vs-FLT_MAX pair compares/canonicalises equal. Matches a
  scientific-notation exponent explicitly (a bare `\d+px` misses `3.40282e+38px`).
  COMPARISON + oracle only (lockstep valuesEqual/canonValue) — the EMIT is never rewritten,
  and a normal-magnitude radius is byte-identical (golden/browser-safe). This is what
  dissolves the stored-fixture radius phantom (`el5`/`el11`: `9999px`→`3.40282e+38px`) so
  the row diffs to nothing.
- **`box-shadow`/`text-shadow`** — the `<color>` token is grammar-allowed *before or
  after* the offsets, so `rgba(17,17,17,0.03) 0px 1px 2px` and `0 1px 2px #11111108`
  are the same shadow written two ways. `canonicalizeShadow` splits comma-layers
  (`splitTopLevelComma`) then top-level tokens (`splitTopLevel`), canonicalises the
  color (colord → rgb) and zero-lengths (`0px`→`0`), and re-emits with the color in a
  **fixed slot** (last). **Length order and layer order are preserved** (both are
  render-significant); only the color moves. It returns `null` — falling back to the
  token `effectivelyEqual` — on any layer it cannot fully parse (unknown token like
  `currentColor`, `<2` or `>4` lengths, a 2nd color). Shadow color **alpha** is
  colord-precision (2 decimals ⇒ ≤~1/255); the shadow canonicaliser uses `colord`
  directly (it does **not** route through `canonicalizeColor`/culori — a shadow color is
  a single sRGB token), so shadow colors are colord-only while single-color props also
  get the wide-gamut path — but the same 2-decimal alpha fuzz applies to both (see §9).
- **`rem`** — resolved to px and compared **only when SAFE**: both artifacts carry a
  `rootContext` **and their anchors are equal**. Then a `rem`-vs-`px` representation
  of the same length compares equal (`16px` == `1rem`@16). When the anchors **differ**
  (or one is absent, e.g. whole-doc mode), `rem` stays a **token**: resolving it would
  false-equal a value that must change when the anchor re-anchors to B (A=`1rem`@16 vs
  B=`0.8rem`@20 both = 16px now, but apply re-anchors → `1rem` becomes 20px ≠ 16px), so
  the diff must SHOW it and the `rootContext` patch carries the anchor. Both anchors are
  threaded in as a `RemCtx` (`{aFs,bFs}`) from `diffStyles` **and** from `diff-tree.ts`
  `computeDiff` (css-diff's web-UI path), so the guard holds on both.
- **wide-gamut / `color-mix()` color** (`canonicalizeColor`) — `colord` parses sRGB
  (hex/rgb/hsl/named) but **not** `oklch`/`oklab` nor the `color-mix()` *function*, so a
  paint written two ways — `rgba(255,255,255,0.15)` vs
  `color-mix(in oklab,#fff 15%,transparent)`, or `#e7e7eb` vs `oklch(…)` — would
  spuriously diff. `canonicalizeColor` resolves any single-color value to one rgb string
  via `colord`'s formatter: colord-parseable colors take the **fast path** (byte-identical
  to the prior behaviour → golden-safe), and only wide-gamut / `color-mix()` values engage
  **culori** (`color-mix()` is evaluated manually — parse endpoints, mix in the named
  RECTANGULAR space with **premultiplied alpha**; a POLAR space needs circular hue interp
  and BAILS → the token compare). `valuesEqual` engages it only when a side is
  NOT colord-parseable (so colord↔colord pairs keep their exact `effectivelyEqual` path),
  and `canonValue` routes the color branch through the **same** function, so the oracle
  stays in lockstep (applied's rgba and B's `color-mix` canonicalise to one rgb string).
  Tolerance is integer-channel rounding only (~0.5/255, matching colord); a wide-gamut
  pair further apart legitimately stays distinct (see §9). **Comparison + oracle only —
  EMIT is never rewritten** (an out-of-sRGB-gamut color can't be re-encoded without
  changing the render).

A non-minimal patch is still render-correct.

### Relational
Matched by the composite key `(state, combinator, pseudo, trigger)`. `trigger` is
**in** the key (the stable id-space makes it safe) so two triggers driving the
same subject — `.foo:hover .bar` vs `.baz:hover .bar` — don't collide. A key
present in A but absent in B becomes a `remove`; a changed/new one an `upsert` of
the full B entry.

### Bucket-disappeared symmetry
Every "gone in B" is a delete-to-empty that apply prunes: whole element
(`removed:true`), whole self-state, whole pseudo (base + its states), and a
relational entry (`remove` key). An emptied bucket/entry is omitted on apply so
the result matches B's empty-key omission.

### Verification (`test/diff.test.ts` + `test/diff.browser.test.ts`)
Two independent levels, because a static screenshot only sees the **resting**
state (states/pseudos/relational render nothing at rest). The two levels live in
**separate files** so they land in the right vitest project (`unit` vs `browser`):
- **Golden battery** (`diff.test.ts`, `unit` project, no browser) — hand-authored
  `StyleJson` A/B, asserting the **exact** patch *and* the **exact** applied
  output. This is the independent oracle for the buckets pixel can't see.
- **Render-identity + round-trip** (`diff.browser.test.ts`, `browser` project) —
  same-DOM synthetic pairs extracted for real
  (whole-doc + subtree/`rootContext`): `jsonToHtml(applyStylePatch(A, diff(A,B)))`
  is Firefox-pixel-identical to `jsonToHtml(B)` (0.000%), and
  `canonicalStyleJson(applied) == canonicalStyleJson(B)`. `canonicalStyleJson` is
  written independently of diff/apply so a diff bug can't hide in both the patch
  and its own check; a sanity anchor also asserts `jsonToHtml(B) == the original B
  page` so a broken fixture can't read as green.

