// value-tokens.ts — top-level splitting of CSS values via postcss-value-parser,
// which keeps functions (calc(), color-mix(), rgb(), …) intact.

import valueParser from 'postcss-value-parser';

/** Split on top-level whitespace (e.g. `1px solid red` → ['1px','solid','red']). */
export function splitTopLevel(value: string): string[] {
  const out: string[] = [];
  for (const node of valueParser(value).nodes) {
    if (node.type === 'space' || node.type === 'div') continue;
    out.push(valueParser.stringify(node));
  }
  return out;
}

/** Split on top-level commas (e.g. box-shadow / gradient layers). */
export function splitTopLevelComma(value: string): string[] {
  const layers: string[] = [];
  let cur: valueParser.Node[] = [];
  for (const node of valueParser(value).nodes) {
    if (node.type === 'div' && node.value === ',') {
      layers.push(valueParser.stringify(cur).trim());
      cur = [];
    } else {
      cur.push(node);
    }
  }
  if (cur.length) layers.push(valueParser.stringify(cur).trim());
  return layers;
}
