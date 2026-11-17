// A marker attribute stamped on the element to extract, so `reworkStyles({ root })` can
// address an element that has no CSS selector of its own (a Locator, a snapshot uid).
// No runtime imports: the extractor loads it lazily and must stay able to.

import type { StyleTreeNode } from './extract.ts';

/** A fresh attribute NAME per extraction: a page attribute of the same name, or a
 *  concurrent extraction's marker, is never overwritten or removed by ours. */
export function newMarkerAttr(): string {
  return `data-css-snapshot-extract-${crypto.randomUUID()}`;
}

/** Drop the marker from the extracted tree root (the only node that carries it). */
export function stripRootAttr(json: { tree: StyleTreeNode }, attr: string): void {
  const root = json.tree;
  if (!root.attrs) return;
  delete root.attrs[attr];
  if (Object.keys(root.attrs).length === 0) delete root.attrs;
}
