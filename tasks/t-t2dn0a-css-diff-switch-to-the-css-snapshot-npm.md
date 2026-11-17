---
id: t-t2dn0a
title: 'css-diff: switch to the css-snapshot npm package'
status: backlog
priority: medium
created_by_session: s-3jptme
author: mb-07ba7304
created: '2026-11-17T01:07:42.924Z'
---
css-diff still carries its own copy of the extraction core (`extractElementCss.ts`, `cdp.ts`, `marker.ts`, `playwright.ts`, `index.ts`, `diff.ts`, `src/` minus `display-compaction.ts`). Replace it with a dependency on `css-snapshot`: imports → `css-snapshot` / `css-snapshot/playwright` / `css-snapshot/diff`; env `CSS_DIFF_MATCHER` → `CSS_SNAPSHOT_MATCHER` (or the `matcher` option); `test/util/inertClasses.ts` / `computedWalk.ts` need `extractionDropsProperty` and `INHERITABLE`, `display-compaction.ts` needs `expandShorthand` — check they are exported by the package (add a subpath if not). Tests that moved to the package can be dropped from css-diff; the ref-page / Firefox / corpus ones stay.

Available for the guards that stay in css-diff: `matcherMode` (root entry — selects the per-matcher baseline), `orderPropsShorthandFirst` (`css-snapshot/css` — `test/util/rules.ts`). The env var is `CSS_SNAPSHOT_MATCHER`; DOM markers are `data-css-snapshot-*` (css-diff's own `data-cssdiff-root` picker marker is unaffected). The ref-page guards' baselines (`rework-baseline-rules[.probe].json`) were captured with css-diff's copy — re-run `test:baseline` after the switch only if they turn red.

This task lives in css-snapshot's backlog only — carry it into css-diff's `tasks/` when the migration starts there. Also: Firefox launches in ~3 s on the dev host (2026-11-17), so css-diff's CLAUDE.md note on `t-nwkk89` (Firefox launch hangs) looks stale — re-check and drop it then.
