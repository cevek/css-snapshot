// specificity.ts — CSS selector specificity via parsel-js (spec-correct:
// handles :is()/:where()/:not()/:has(), attribute selectors, pseudo-elements).
// Returns a single sortable number a*1e6 + b*1e3 + c (base 1000), matching the
// cascade comparator elsewhere. Falls back to 0 if parsel can't parse the
// selector (e.g. an exotic vendor pseudo) — never throws.

import { specificity as parselSpecificity, specificityToNumber } from 'parsel-js';

export function specificity(selector: string): number {
  try {
    return specificityToNumber(parselSpecificity(selector), 1000);
  } catch {
    return 0;
  }
}
