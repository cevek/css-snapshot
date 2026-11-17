// css-snapshot/css: the CSS value primitives the extractor is built on, for consumers
// that post-process a snapshot (diffing, display, fidelity checks) and must agree with
// the extractor's own notion of shorthands, inheritance and equality.

export { expandShorthand, SHORTHAND_COVERAGE, orderPropsShorthandFirst } from './internal/shorthand.ts';
export { splitTopLevel, splitTopLevelComma } from './internal/value-tokens.ts';
export { effectivelyEqual, extractionDropsProperty, INHERITABLE } from './internal/resolve.ts';
