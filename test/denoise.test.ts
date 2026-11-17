// Pass 3/4 baseline: a declaration is noise when it equals the EFFECTIVE default
// (a surviving shorthand's expansion, else the bare-tag UA default) — not when it
// merely coincides with the bare-tag default. The witness class lives on form
// controls, whose UA defaults are NON-ZERO (`button{border-width:2px;
// padding:1px 6px}`) while a tailwind preflight re-bases them to 0.
//
// `tagDefaults` fixtures below carry ONLY longhand keys, physical AND logical —
// that is what `getTagDefaults` produces (it enumerates the computed style by
// index, which reports no shorthands). A shorthand key here would make Pass 3
// drop it directly and never exercise Pass 4.
import { describe, it, expect } from 'vitest';
import { denoiseResolved } from '../src/internal/resolve.ts';
import type { ResolvedDecl } from '../src/internal/cascade.ts';

const decl = (value: string, order = 0): ResolvedDecl => ({ value, important: false, specificity: 0, order });

/** UA defaults of a bare `<button>`, as Chromium computes them. */
const BUTTON_DEFAULTS = new Map<string, string>([
  ['border-top-width', '2px'], ['border-right-width', '2px'],
  ['border-bottom-width', '2px'], ['border-left-width', '2px'],
  ['border-inline-start-width', '2px'], ['border-inline-end-width', '2px'],
  ['border-block-start-width', '2px'], ['border-block-end-width', '2px'],
  ['border-top-style', 'outset'], ['border-right-style', 'outset'],
  ['border-bottom-style', 'outset'], ['border-left-style', 'outset'],
  ['border-top-color', 'rgb(0, 0, 0)'], ['border-right-color', 'rgb(0, 0, 0)'],
  ['border-bottom-color', 'rgb(0, 0, 0)'], ['border-left-color', 'rgb(0, 0, 0)'],
  ['padding-top', '1px'], ['padding-bottom', '1px'],
  ['padding-left', '6px'], ['padding-right', '6px'],
  ['padding-inline-start', '6px'], ['padding-inline-end', '6px'],
  ['font-style', 'normal'], ['font-weight', '400'],
]);

const DIV_DEFAULTS = new Map<string, string>([
  ['border-top-width', '0px'], ['border-right-width', '0px'],
  ['border-bottom-width', '0px'], ['border-left-width', '0px'],
  ['padding-top', '0px'], ['padding-right', '0px'],
  ['padding-bottom', '0px'], ['padding-left', '0px'],
]);

/** Run the rework configuration: drop defaults, protect inherited, no materialise. */
function rework(
  tag: string,
  resolved: Map<string, ResolvedDecl>,
  computed: Map<string, string>,
  tagDefaults: Map<string, string>,
): Map<string, ResolvedDecl> {
  return denoiseResolved(tag, resolved, computed, tagDefaults, false, true, true);
}

describe('denoise Pass 3/4 — effective default vs bare-tag default', () => {
  // The witness: `<button class="border-b-2 border-[#111]">` under a preflight
  // `*{border:0 solid}`. The 2px coincides with the button UA default, but the
  // preflight shorthand re-based every side to 0, so dropping it erases the tab
  // underline AND 2px of the element's height.
  it('keeps a physical border longhand the preflight shorthand re-based (form D)', () => {
    const out = rework(
      'button',
      new Map([
        ['border', decl('0px solid', 0)],
        ['border-color', decl('rgb(17, 17, 17)', 1)],
        ['border-bottom-width', decl('2px', 2)],
      ]),
      new Map([
        ['border-top-width', '0px'], ['border-right-width', '0px'],
        ['border-bottom-width', '2px'], ['border-left-width', '0px'],
        ['border-bottom-style', 'solid'],
      ]),
      BUTTON_DEFAULTS,
    );
    expect(out.get('border-bottom-width')?.value).toBe('2px');
  });

  // `border-2` — the candidate is itself a SHORTHAND, so Pass 3 never sees it
  // (tagDefaults has no `border-width` key) and Pass 4 decides.
  it('keeps a border-width shorthand the preflight shorthand re-based (form A)', () => {
    const out = rework(
      'button',
      new Map([
        ['border', decl('0px solid', 0)],
        ['border-width', decl('2px', 1)],
      ]),
      new Map([
        ['border-top-width', '2px'], ['border-right-width', '2px'],
        ['border-bottom-width', '2px'], ['border-left-width', '2px'],
        ['border-width', '2px'],
      ]),
      BUTTON_DEFAULTS,
    );
    expect(out.get('border-width')?.value).toBe('2px');
  });

  // `border-s-2`: the declaration is LOGICAL, the re-basing shorthand expands to
  // PHYSICAL sides — they meet only through the axis mapping.
  it('keeps a logical border longhand re-based through the physical axis (form B)', () => {
    const out = rework(
      'button',
      new Map([
        ['border', decl('0px solid', 0)],
        ['border-inline-start-width', decl('2px', 1)],
      ]),
      new Map([
        ['border-top-width', '0px'], ['border-right-width', '0px'],
        ['border-bottom-width', '0px'], ['border-left-width', '2px'],
        ['border-inline-start-width', '2px'],
      ]),
      BUTTON_DEFAULTS,
    );
    expect(out.get('border-inline-start-width')?.value).toBe('2px');
  });

  // `ps-1.5` under a preflight `padding:0`, same logical↔physical meeting point.
  it('keeps a logical padding longhand re-based through the physical axis (form C)', () => {
    const out = rework(
      'button',
      new Map([
        ['padding', decl('0px', 0)],
        ['padding-inline-start', decl('6px', 1)],
      ]),
      new Map([
        ['padding-top', '0px'], ['padding-right', '0px'],
        ['padding-bottom', '0px'], ['padding-left', '6px'],
        ['padding-inline-start', '6px'],
      ]),
      BUTTON_DEFAULTS,
    );
    expect(out.get('padding-inline-start')?.value).toBe('6px');
  });

  // Discriminates against a blanket keep: with NO shorthand re-basing the group,
  // the bare-tag default is still the effective one and the decl is still noise.
  it('drops a longhand equal to the UA default when no shorthand re-bases it', () => {
    const out = rework(
      'button',
      new Map([['border-bottom-width', decl('2px', 0)]]),
      new Map([['border-bottom-width', '2px']]),
      BUTTON_DEFAULTS,
    );
    expect(out.has('border-bottom-width')).toBe(false);
  });

  // The shorthand agrees with the declaration → it IS redundant, drop stands.
  it('drops a longhand equal to the re-basing shorthand value', () => {
    const out = rework(
      'button',
      new Map([
        ['padding', decl('4px', 0)],
        ['padding-top', decl('4px', 1)],
      ]),
      new Map([
        ['padding-top', '4px'], ['padding-right', '4px'],
        ['padding-bottom', '4px'], ['padding-left', '4px'],
      ]),
      BUTTON_DEFAULTS,
    );
    expect(out.has('padding-top')).toBe(false);
  });

  // Discriminates against a blanket keep-whenever-a-shorthand-is-present: the
  // logical decl agrees with the physical base, so it IS noise. Pass 5 cannot
  // mask the outcome here — it only matches EXACT longhand names, and
  // `expandShorthand('padding',…)` emits no logical key.
  it('drops a logical longhand that agrees with the re-basing physical shorthand', () => {
    const out = rework(
      'button',
      new Map([
        ['padding', decl('0px', 0)],
        ['padding-inline-start', decl('0px', 1)],
      ]),
      new Map([
        ['padding-top', '0px'], ['padding-right', '0px'],
        ['padding-bottom', '0px'], ['padding-left', '0px'],
        ['padding-inline-start', '0px'],
      ]),
      BUTTON_DEFAULTS,
    );
    expect(out.has('padding-inline-start')).toBe(false);
  });

  // A zero-UA-default tag is unaffected: `0px` == the preflight base == the tag
  // default, so nothing changes for the `<div>` half of the page.
  it('leaves a zero-default tag unchanged', () => {
    const out = rework(
      'div',
      new Map([
        ['border', decl('0px solid', 0)],
        ['border-bottom-width', decl('1px', 1)],
      ]),
      new Map([
        ['border-top-width', '0px'], ['border-right-width', '0px'],
        ['border-bottom-width', '1px'], ['border-left-width', '0px'],
        ['border-bottom-style', 'solid'],
      ]),
      DIV_DEFAULTS,
    );
    expect(out.get('border-bottom-width')?.value).toBe('1px');
  });

  // Two shorthands covering one slot must not prove each other redundant and BOTH
  // vanish — the value would go with them and the UA default would take over. The
  // strongest carrier of a slot never finds a base, so it always faces the tag
  // default instead.
  it('keeps a carrier when two shorthands cover the same slot (preflight + logical utility)', () => {
    const out = rework(
      'p',
      new Map([
        ['margin', decl('0', 0)],
        ['margin-block', decl('0px', 1)],
      ]),
      new Map([
        ['margin-top', '0px'], ['margin-right', '0px'],
        ['margin-bottom', '0px'], ['margin-left', '0px'],
        ['margin-block-start', '0px'], ['margin-block-end', '0px'],
      ]),
      new Map([
        ['margin-top', '16px'], ['margin-bottom', '16px'],
        ['margin-left', '0px'], ['margin-right', '0px'],
        ['margin-block-start', '16px'], ['margin-block-end', '16px'],
        ['margin-inline-start', '0px'], ['margin-inline-end', '0px'],
      ]),
    );
    expect(out.has('margin')).toBe(true);
  });

  // Same shape on a tag whose non-zero UA default is on the INLINE axis (`ul`
  // indents by 40px), reached through `padding` + `padding-inline`.
  it('keeps a carrier when the re-based slot is the list indent', () => {
    const out = rework(
      'ul',
      new Map([
        ['padding', decl('0', 0)],
        ['padding-inline', decl('0px', 1)],
      ]),
      new Map([
        ['padding-top', '0px'], ['padding-right', '0px'],
        ['padding-bottom', '0px'], ['padding-left', '0px'],
        ['padding-inline-start', '0px'], ['padding-inline-end', '0px'],
      ]),
      new Map([
        ['padding-top', '0px'], ['padding-right', '0px'],
        ['padding-bottom', '0px'], ['padding-left', '40px'],
        ['padding-inline-start', '40px'], ['padding-inline-end', '0px'],
      ]),
    );
    expect(out.has('padding')).toBe(true);
  });

  // The same annihilation without any logical spelling: `border` against its own
  // width/style/color shorthands.
  it('keeps a carrier when border and its component shorthands overlap', () => {
    const out = rework(
      'button',
      new Map([
        ['border', decl('2px solid red', 0)],
        ['border-width', decl('2px', 1)],
        ['border-style', decl('solid', 2)],
        ['border-color', decl('red', 3)],
      ]),
      new Map([
        ['border-top-width', '2px'], ['border-right-width', '2px'],
        ['border-bottom-width', '2px'], ['border-left-width', '2px'],
        ['border-top-style', 'solid'], ['border-top-color', 'rgb(255, 0, 0)'],
      ]),
      BUTTON_DEFAULTS,
    );
    expect(out.has('border')).toBe(true);
  });

  // Discriminates the AXIS DIRECTION of the logical↔physical bridge: the
  // shorthand is asymmetric, so mapping `padding-inline-start` to the block axis
  // by mistake would offer `0px` and keep the decl.
  it('maps a logical key to the correct physical axis', () => {
    const out = rework(
      'button',
      new Map([
        ['padding', decl('0 6px', 0)],
        ['padding-inline-start', decl('6px', 1)],
      ]),
      new Map([
        ['padding-top', '0px'], ['padding-right', '6px'],
        ['padding-bottom', '0px'], ['padding-left', '6px'],
        ['padding-inline-start', '6px'],
      ]),
      BUTTON_DEFAULTS,
    );
    expect(out.has('padding-inline-start')).toBe(false);
  });

  // Under `vertical-*` the inline axis is top/bottom, so the bridge is switched
  // OFF (see `horizontalWm`): `padding-inline` must not offer a base for
  // `padding-left`, a slot it doesn't touch there.
  it('does not bridge logical↔physical under a vertical writing-mode', () => {
    const out = rework(
      'div',
      new Map([
        ['writing-mode', decl('vertical-rl', 0)],
        ['padding-inline', decl('4px', 1)],
        ['padding-left', decl('4px', 2)],
      ]),
      new Map([
        ['writing-mode', 'vertical-rl'],
        ['padding-top', '4px'], ['padding-bottom', '4px'],
        ['padding-left', '4px'], ['padding-right', '0px'],
        ['padding-inline-start', '4px'], ['padding-inline-end', '4px'],
      ]),
      new Map([
        ['padding-top', '0px'], ['padding-right', '0px'],
        ['padding-bottom', '0px'], ['padding-left', '0px'],
        ['padding-inline-start', '0px'], ['padding-inline-end', '0px'],
      ]),
    );
    expect(out.get('padding-left')?.value).toBe('4px');
  });

  // `sideways-*` puts the inline axis on top/bottom exactly like `vertical-*`, and
  // Chrome reports it verbatim in the computed style, so the gate must catch it.
  it('treats sideways-* as a vertical writing-mode', () => {
    const out = rework(
      'div',
      new Map([
        ['writing-mode', decl('sideways-lr', 0)],
        ['padding-inline', decl('4px', 1)],
        ['padding-left', decl('4px', 2)],
      ]),
      new Map([
        ['writing-mode', 'sideways-lr'],
        ['padding-top', '4px'], ['padding-bottom', '4px'],
        ['padding-left', '4px'], ['padding-right', '0px'],
        ['padding-inline-start', '4px'], ['padding-inline-end', '4px'],
      ]),
      new Map([
        ['padding-top', '0px'], ['padding-right', '0px'],
        ['padding-bottom', '0px'], ['padding-left', '0px'],
        ['padding-inline-start', '0px'], ['padding-inline-end', '0px'],
      ]),
    );
    expect(out.get('padding-left')?.value).toBe('4px');
  });

  // Why the bridge is OFF rather than swapped under a vertical mode: the tag
  // defaults it would be compared against are measured in a HORIZONTAL iframe, so
  // a logical UA default (`p{margin-block:1em}`) lands on the wrong physical
  // sides. A swapped bridge would then prove `margin:0` redundant and lose the 0.
  it('keeps a shorthand a horizontally-measured default would call redundant', () => {
    const out = rework(
      'p',
      new Map([
        ['writing-mode', decl('vertical-rl', 0)],
        ['margin', decl('0', 1)],
        ['margin-inline', decl('0', 2)],
      ]),
      new Map([
        ['writing-mode', 'vertical-rl'],
        ['margin-top', '0px'], ['margin-right', '0px'],
        ['margin-bottom', '0px'], ['margin-left', '0px'],
        ['margin-inline-start', '0px'], ['margin-inline-end', '0px'],
      ]),
      // Measured horizontally: the <p> block margin reads as top/bottom, even
      // though this element paints it on left/right.
      new Map([
        ['margin-top', '16px'], ['margin-bottom', '16px'],
        ['margin-left', '0px'], ['margin-right', '0px'],
        ['margin-inline-start', '0px'], ['margin-inline-end', '0px'],
      ]),
    );
    expect(out.has('margin')).toBe(true);
  });

  // A CSS-wide keyword names no concrete base. The preflight `font:inherit` on
  // form controls expands (that form IS modelled), so counting it would keep
  // every font longhand alive in the single-element path — where INHERITABLE is
  // NOT protected.
  it('ignores a pass-through shorthand as a base source', () => {
    const out = denoiseResolved(
      'button',
      new Map([
        ['font', decl('inherit', 0)],
        ['font-style', decl('normal', 1)],
      ]),
      new Map([['font-style', 'normal']]),
      BUTTON_DEFAULTS,
      false, true, /* protectInherited */ false,
    );
    expect(out.has('font-style')).toBe(false);
  });
});
