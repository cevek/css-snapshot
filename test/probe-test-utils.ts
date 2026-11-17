// Shared helpers for the probe-matcher differential tests (at-rest + under-force).
// Extracted so the two suites can't DRIFT on what "equal" means (a single `normSel`
// / `regularActive` definition), and so the CDP element walk isn't reimplemented twice.
import type { RuleMatch, MatchedStyles } from '../src/internal/cdp-types.ts';
import type { ProbeElement, ProbeMatcher } from '../src/internal/probe-matcher.ts';

/** Non-rendering tags the driver skips — kept in lockstep with the matcher's default. */
export const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'NOSCRIPT', 'META', 'TITLE', 'HEAD', 'BASE', 'TEMPLATE']);

/** Walk a `DOM.getDocument({depth:-1})` root into the driver's element order (skip set
 *  applied, recursing THROUGH skipped tags). Caller owns the single getDocument (a second
 *  fetch would invalidate the returned nodeIds). */
export function walkElements(root: any): ProbeElement[] {
  const els: ProbeElement[] = [];
  const walk = (n: any) => {
    if (n.nodeType === 1) {
      const tag = (n.nodeName || '').toUpperCase();
      if (!SKIP.has(tag)) els.push({ nodeId: n.nodeId, tag });
    }
    for (const c of n.children || []) walk(c);
  };
  walk(root);
  return els;
}

/** A CDP rule's conditions are ACTIVE iff no media/supports/container query is inactive. */
export function condActive(rule: any): boolean {
  for (const m of rule.media || []) for (const q of m.mediaList || []) if (q.active === false) return false;
  for (const s of rule.supports || []) if (s.active === false) return false;
  for (const c of rule.containerQueries || []) if (c.active === false) return false;
  return true;
}

/** Regular-origin, condition-active matched rules from a CDP `getMatchedStylesForNode`
 *  response (drops UA + inactive-condition rules — the probe path never emits them). */
export function regularActive(matched: RuleMatch[] | undefined): RuleMatch[] {
  return (matched || []).filter((rm) => (rm.rule as any).origin === 'regular' && condActive(rm.rule));
}

/** Whitespace/combinator/comma-normalised selector text — ONE definition for all suites. */
export const normSel = (s: string) =>
  s.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').replace(/\s*([>+~])\s*/g, '$1').trim();

/** A RuleMatch's selector-list key (comma-joined normalised selectors). */
export const listKey = (rm: RuleMatch) => rm.rule.selectorList.selectors.map((s) => normSel(s.text)).join(',');

/** Multiset (order-independent, count-aware) of a key list. */
export function multiset(keys: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) || 0) + 1);
  return m;
}

/** Order-independent multiset equality via sorted key lists (Maps don't JSON-serialise). */
export const bagEq = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** Rebuild a node's UNDER-FORCE author match set the way the DRIVER does (phase-4 piggyback):
 *  read its computed style — which carries the registered `--czp` markers the engine lit under
 *  the CURRENT `CSS.forcePseudoState` — and hand the property NAMES to `matchedFromComputed`.
 *  MUST be called WHILE the force is active. Same mechanism `extractElementCss` uses, so this
 *  is a faithful oracle for the shipped path. */
export async function matchedUnderForce(
  client: { send(method: string, params?: any): Promise<any> },
  matcher: ProbeMatcher,
  nodeId: number,
): Promise<MatchedStyles> {
  const { computedStyle } = (await client.send('CSS.getComputedStyleForNode', { nodeId })) as any;
  return matcher.matchedFromComputed((computedStyle || []).map((p: any) => p.name as string));
}

export type { MatchedStyles, RuleMatch };
