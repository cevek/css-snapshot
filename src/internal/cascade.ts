// cascade.ts — resolve the CSS cascade for one element (ported verbatim).

import { specificity } from './specificity.ts';
import type { CssRule, CssStyle, RuleMatch } from './cdp-types.ts';

export interface ResolvedDecl {
  value: string;
  important: boolean;
  specificity: number;
  order: number;
}

export function declBeats(a: ResolvedDecl, b: ResolvedDecl): boolean {
  if (a.important !== b.important) return a.important;
  return a.order > b.order;
}

/**
 * A resolved map in the order the declarations must be EMITTED into one flat
 * `#id{…}` rule: ascending cascade order of each property's winner.
 *
 * Map order is the wrong answer — `cascadeResolve` keys a property at its FIRST
 * appearance and only updates the value, so a preflight `border-color` keeps a
 * position that says nothing about the winner that later replaced it. Emitting
 * in map order lets a losing shorthand sit after a winning sub-shorthand and
 * clobber it (a `border:1px solid grey` erasing a `border-color:transparent`).
 *
 * Sorting by the WINNER's order is sound because a winner is the last occurrence
 * of its key, so it overrides every earlier occurrence of that key across all
 * components; `!important` needs no special case, since within one flat rule an
 * important declaration beats a normal one exactly as it does in the cascade.
 * Stable, so entries sharing an order (synthesised decls) keep their relative
 * position.
 */
export function cascadeOrdered<T extends { order?: number }>(decls: Map<string, T>): Array<[string, T]> {
  return [...decls].sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0));
}

interface Decl {
  prop: string;
  value: string;
  important: boolean;
  specificity: number;
  isAuthor: boolean;
  order: number;
}

const ALLOWED_ORIGINS = new Set<string>(['regular', 'inspector']);

export function cascadeResolve(
  matched: RuleMatch[],
  inlineStyle: CssStyle | undefined,
  attributesStyle: CssStyle | undefined,
): Map<string, ResolvedDecl> {
  const decls: Decl[] = [];
  let order = 0;

  // Attribute (presentational) styles are the LOWEST-priority author input, so
  // push them FIRST — cascade order is now encoded by push order (see below).
  if (attributesStyle) {
    for (const p of attributesStyle.cssProperties) {
      if (p.disabled || !p.name || p.value == null || p.value === '') continue;
      const { value, extraImportant } = stripImportant(p.value);
      decls.push({
        prop: p.name.toLowerCase(),
        value,
        important: !!p.important || extraImportant,
        specificity: 0,
        isAuthor: true,
        order: order++,
      });
    }
  }

  // CDP returns matchedCSSRules already in ASCENDING CASCADE ORDER — verified
  // that the winner is always LAST, accounting for specificity, source order AND
  // @layer (a later layer beats a higher specificity in an earlier layer). So we
  // preserve that order and let push-order decide the winner, instead of
  // recomputing by specificity (which is @layer-blind). `specificity` is still
  // recorded for reference but no longer drives winner selection.
  for (const rm of matched) {
    if (!ALLOWED_ORIGINS.has(rm.rule.origin)) continue;
    if (!conditionsActive(rm.rule)) continue;

    const selectors = rm.rule.selectorList.selectors;
    let bestSpec = 0;
    for (const idx of rm.matchingSelectors) {
      const text = selectors[idx]?.text;
      if (!text) continue;
      const s = specificity(text);
      if (s > bestSpec) bestSpec = s;
    }
    if (bestSpec === 0 && rm.rule.nestingSelectors) {
      for (const text of rm.rule.nestingSelectors) {
        if (!text) continue;
        const s = specificity(text);
        if (s > bestSpec) bestSpec = s;
      }
    }

    for (const p of rm.rule.style.cssProperties) {
      if (p.disabled) continue;
      if (p.implicit) continue;
      if (!p.name || p.value == null || p.value === '') continue;
      const { value, extraImportant } = stripImportant(p.value);
      decls.push({
        prop: p.name.toLowerCase(),
        value,
        important: !!p.important || extraImportant,
        specificity: bestSpec,
        isAuthor: true,
        order: order++,
      });
    }
  }

  if (inlineStyle) {
    for (const p of inlineStyle.cssProperties) {
      if (p.disabled || !p.name || p.value == null || p.value === '') continue;
      const { value, extraImportant } = stripImportant(p.value);
      decls.push({
        prop: p.name.toLowerCase(),
        value,
        important: !!p.important || extraImportant,
        specificity: Number.MAX_SAFE_INTEGER,
        isAuthor: true,
        order: order++,
      });
    }
  }

  const winners = new Map<string, Decl>();
  for (const d of decls) {
    const cur = winners.get(d.prop);
    if (!cur || beats(d, cur)) winners.set(d.prop, d);
  }

  const out = new Map<string, ResolvedDecl>();
  for (const [k, d] of winners) {
    out.set(k, { value: d.value, important: d.important, specificity: d.specificity, order: d.order });
  }
  return out;
}

function stripImportant(raw: string): { value: string; extraImportant: boolean } {
  const trimmed = raw.trim();
  if (/\s*!important\s*$/i.test(trimmed)) {
    return { value: trimmed.replace(/\s*!important\s*$/i, '').trim(), extraImportant: true };
  }
  return { value: trimmed, extraImportant: false };
}

function conditionsActive(rule: CssRule): boolean {
  if (rule.media) {
    for (const m of rule.media) {
      if (!m.mediaList) continue;
      for (const q of m.mediaList) {
        if (!q.active) return false;
      }
    }
  }
  if (rule.supports) {
    for (const s of rule.supports) {
      if (!s.active) return false;
    }
  }
  return true;
}

// Winner = important beats normal, then LATER push-order wins. Push order mirrors
// CDP's cascade order (specificity + source order + @layer), so this is the full
// cascade without re-deriving specificity.
function beats(a: Decl, b: Decl): boolean {
  if (a.important !== b.important) return a.important;
  return a.order > b.order;
}
