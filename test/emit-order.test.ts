// Emission order is the CASCADE order of each property's winner, not the order
// the resolve map happens to key them in. `cascadeResolve` keys a property at its
// FIRST appearance and only updates the value, so map order says nothing about
// who overrides whom once the declarations are flattened into one `#id{…}` rule.
import { describe, it, expect } from 'vitest';
import { buildStyleString } from '../src/internal/style-string.ts';
import { cascadeOrdered, type ResolvedDecl } from '../src/internal/cascade.ts';
import { denoiseResolved, resolvePseudoElement } from '../src/internal/resolve.ts';
import { expandShorthand, SHORTHAND_COVERAGE } from '../src/internal/shorthand.ts';
import type { RuleMatch } from '../src/internal/cdp-types.ts';

const d = (value: string, order: number, important = false): ResolvedDecl =>
  ({ value, important, specificity: 0, order });

describe('emission order follows the cascade', () => {
  // The field witness: a preflight `border:0 solid`, a `.card{border:1px solid
  // grey}` and a later `border-color:transparent`. The shorthand BEATS the width
  // and LOSES to the colour, so no single position for it is correct — only the
  // cascade order is. Map order here is the real one: `border-width`/`border-color`
  // were keyed by the preflight, long before the winners replaced their values.
  it('emits a partially-beaten shorthand between its loser and its winner', () => {
    const s = buildStyleString(new Map([
      ['border-width', d('0', 1)],
      ['border-color', d('transparent', 7)],
      ['border', d('1px solid #e4e4e7', 5)],
    ]));
    expect(s).toBe('border-width:0;border:1px solid #e4e4e7;border-color:transparent');
  });

  it('keeps a winning longhand after the shorthand it beats', () => {
    const s = buildStyleString(new Map([
      ['background-color', d('#fff', 9)],
      ['background', d('transparent', 2)],
    ]));
    expect(s).toBe('background:transparent;background-color:#fff');
  });

  it('keeps a winning shorthand after the longhand it beats', () => {
    const s = buildStyleString(new Map([
      ['background-color', d('blue', 1)],
      ['background', d('red', 4)],
    ]));
    expect(s).toBe('background-color:blue;background:red');
  });

  // A materialised inherited value is what the element falls back to, so it must
  // sort BELOW every author declaration. With the old `order: 0` it tied with the
  // author decl (the cascade counter also starts at 0) and map position decided.
  it('sorts a materialised inherited shorthand below an author longhand', () => {
    const s = buildStyleString(new Map([
      ['text-decoration-line', d('underline', 0)],
      ['text-decoration', d('none solid rgb(17, 17, 17)', -1)],
    ]));
    expect(s).toBe('text-decoration:none solid rgb(17, 17, 17);text-decoration-line:underline');
  });

  it('folds !important into the value and leaves it to win on its own', () => {
    const s = buildStyleString(new Map([
      ['color', d('red', 8, true)],
      ['font-size', d('12px', 3)],
    ]));
    expect(s).toBe('font-size:12px;color:red!important');
  });

  it('is stable for entries sharing an order', () => {
    expect(cascadeOrdered(new Map([
      ['a', d('1', 4)], ['b', d('2', 4)], ['c', d('3', 4)],
    ])).map(([k]) => k)).toEqual(['a', 'b', 'c']);
  });

  // The emission net is only safe while every coverage relation it can act on has
  // a denoise pass that removes the beaten longhand — otherwise the net, which
  // cannot tell who won the cascade, silently decides the render. Guard 6 asserts
  // an empty list and so can never catch a NEW uncovered source; this walks the
  // two tables the net reads and proves each pair is dropped on BOTH paths.
  it('every coverage relation the emitter acts on has a denoise pass behind it', () => {
    const sample: Record<string, string> = {
      border: '1px solid red', 'border-width': '1px', 'border-style': 'solid', 'border-color': 'red',
      'border-top': '1px solid red', 'border-inline': '1px solid red', 'border-block': '1px solid red',
      margin: '1px', padding: '1px', inset: '1px', gap: '1px', outline: '1px solid red',
      'margin-inline': '1px', 'margin-block': '1px', 'padding-inline': '1px', 'padding-block': '1px',
      'border-radius': '1px', flex: '1', overflow: 'hidden', 'place-items': 'center',
      background: 'red', font: 'inherit', 'list-style': 'square inside',
      'text-decoration': 'underline', columns: '2', 'column-rule': '1px solid red',
      'background-position': '0 0',
    };
    // One rule per declaration, in cascade order — the pseudo path takes CDP-shaped
    // matches, so the loser must arrive as an earlier rule than the shorthand.
    const asMatches = (decls: Array<[string, string]>): RuleMatch[] => decls.map(([name, value]) => ({
      rule: { origin: 'regular', selectorList: { selectors: [{ text: '::selection' }] }, style: { cssProperties: [{ name, value }] } },
      matchingSelectors: [0],
    }));
    const survivors: string[] = [];
    for (const [sh, value] of Object.entries(sample)) {
      const covered = [
        ...(expandShorthand(sh, value)?.keys() ?? []),
        ...(SHORTHAND_COVERAGE[sh] ?? []),
      ];
      for (const lh of new Set(covered)) {
        if (lh === sh) continue;
        // The longhand LOSES to the shorthand (lower order), so it is dead.
        const kept = denoiseResolved(
          'div',
          new Map([[lh, d('7px', 1)], [sh, d(value, 2)]]),
          new Map([[lh, '9px']]), // differs from the decl, so Pass 6's guard can't keep it
          undefined, false, false, false,
        );
        if (kept.has(lh)) survivors.push(`element: ${lh} under ${sh}`);

        const peKept = resolvePseudoElement('selection', asMatches([[lh, '7px'], [sh, value]]), new Map(), undefined);
        if (peKept?.has(lh)) survivors.push(`pseudo: ${lh} under ${sh}`);
      }
    }
    expect(survivors).toEqual([]);
  });

  it('treats a missing order as 0', () => {
    const s = buildStyleString(new Map<string, { value: string; important: boolean; order?: number }>([
      ['color', { value: 'red', important: false }],
      ['margin', { value: '0', important: false, order: -1 }],
    ]));
    expect(s).toBe('margin:0;color:red');
  });
});
