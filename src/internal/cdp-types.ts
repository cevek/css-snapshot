// cdp-types.ts — CDP-shaped input types (structural; no devtools-protocol dep).

export interface CssProperty {
  name: string;
  value: string;
  important?: boolean;
  disabled?: boolean;
  implicit?: boolean;
}
export interface CssStyle { cssProperties: CssProperty[]; }
export interface Selector { text: string; }
export interface CssRule {
  origin: string;
  selectorList: { selectors: Selector[] };
  nestingSelectors?: string[];
  media?: { mediaList?: { active: boolean }[] }[];
  supports?: { active: boolean }[];
  style: CssStyle;
}
export interface RuleMatch { rule: CssRule; matchingSelectors: number[]; }
export interface PseudoElementMatch { pseudoType: string; matches: RuleMatch[]; }
export interface MatchedStyles {
  matchedCSSRules?: RuleMatch[];
  inlineStyle?: CssStyle;
  attributesStyle?: CssStyle;
  pseudoElements?: PseudoElementMatch[];
}
