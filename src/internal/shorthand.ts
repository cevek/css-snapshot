import { splitTopLevel } from './value-tokens.ts';
export function isLength(v: string): boolean {
  return /^-?\d*\.?\d+(px|em|rem|%|pt|pc|cm|mm|in|vh|vw|vmin|vmax|ch|ex|fr|deg|rad|turn|s|ms)?$/.test(v);
}
// ─────────────────────────────────────────────────────────────────────────────
// shorthand.ts (ported verbatim)
// ─────────────────────────────────────────────────────────────────────────────
export const BORDER_STYLES=new Set([
  'none','hidden','dotted','dashed','solid','double',
  'groove','ridge','inset','outset',
]);
export const NAMED_WIDTHS=new Set(['thin','medium','thick']);
export function parseBoxSides(value: string): [string,string,string,string]|null {
  const tokens=splitTopLevel(value);
  if(tokens.length===1) return [tokens[0],tokens[0],tokens[0],tokens[0]];
  if(tokens.length===2) return [tokens[0],tokens[1],tokens[0],tokens[1]];
  if(tokens.length===3) return [tokens[0],tokens[1],tokens[2],tokens[1]];
  if(tokens.length===4) return [tokens[0],tokens[1],tokens[2],tokens[3]];
  return null;
}
export function parseTwo(value: string): [string,string] {
  const tokens=splitTopLevel(value);
  return [tokens[0]??'',tokens[1]??tokens[0]??''];
}
export function parseBorderTriple(value: string): { width: string; style: string; color: string; }|null {
  const tokens=splitTopLevel(value);
  if(tokens.length===0) return null;
  let width='0',style='none',color='currentcolor';
  let widthSet=false,styleSet=false,colorSet=false;
  for(const t of tokens) {
    const lt=t.toLowerCase();
    if(!styleSet&&BORDER_STYLES.has(lt)) { style=lt; styleSet=true; continue; }
    if(!widthSet&&(NAMED_WIDTHS.has(lt)||isLength(lt))) { width=lt; widthSet=true; continue; }
    if(!colorSet) { color=t; colorSet=true; continue; }
  }
  return { width,style,color };
}
export function expandShorthand(prop: string,rawValue: string): Map<string,string>|null {
  const value=rawValue.trim();
  if(!value) return null;
  switch(prop) {
    case 'margin':
    case 'padding': {
      const sides=parseBoxSides(value);
      if(!sides) return null;
      return new Map([
        [`${prop}-top`,sides[0]],[`${prop}-right`,sides[1]],
        [`${prop}-bottom`,sides[2]],[`${prop}-left`,sides[3]],
      ]);
    }
    case 'margin-inline':
    case 'padding-inline': {
      const [start,end]=parseTwo(value);
      const base=prop.slice(0,prop.length-'-inline'.length);
      // Only LOGICAL longhands: the physical side (left/right) depends on
      // writing-mode/direction, unknown here — emitting margin-left would
      // wrong-drop an independent physical longhand on RTL/vertical pages.
      return new Map([
        [`${base}-inline-start`,start],[`${base}-inline-end`,end],
      ]);
    }
    case 'margin-block':
    case 'padding-block': {
      const [start,end]=parseTwo(value);
      const base=prop.slice(0,prop.length-'-block'.length);
      return new Map([
        [`${base}-block-start`,start],[`${base}-block-end`,end],
      ]);
    }
    case 'inset': {
      const sides=parseBoxSides(value);
      if(!sides) return null;
      return new Map([
        ['top',sides[0]],['right',sides[1]],
        ['bottom',sides[2]],['left',sides[3]],
      ]);
    }
    case 'border-width':
    case 'border-style':
    case 'border-color': {
      const sides=parseBoxSides(value);
      if(!sides) return null;
      const part=prop.slice('border-'.length);
      return new Map([
        [`border-top-${part}`,sides[0]],[`border-right-${part}`,sides[1]],
        [`border-bottom-${part}`,sides[2]],[`border-left-${part}`,sides[3]],
      ]);
    }
    case 'border-radius': {
      if(value.includes('/')) return null;
      const sides=parseBoxSides(value);
      if(!sides) return null;
      return new Map([
        ['border-top-left-radius',sides[0]],['border-top-right-radius',sides[1]],
        ['border-bottom-right-radius',sides[2]],['border-bottom-left-radius',sides[3]],
      ]);
    }
    case 'border':
    case 'border-top': case 'border-right':
    case 'border-bottom': case 'border-left': {
      const parsed=parseBorderTriple(value);
      if(!parsed) return null;
      const sides=prop==='border'
        ? ['top','right','bottom','left']
        :[prop.slice('border-'.length)];
      const out=new Map<string,string>();
      for(const s of sides) {
        out.set(`border-${s}-width`,parsed.width);
        out.set(`border-${s}-style`,parsed.style);
        out.set(`border-${s}-color`,parsed.color);
      }
      return out;
    }
    case 'font': {
      if(value==='inherit') {
        return new Map([
          ['font-style','inherit'],['font-variant','inherit'],
          ['font-weight','inherit'],['font-stretch','inherit'],
          ['font-size','inherit'],['line-height','inherit'],
          ['font-family','inherit'],
        ]);
      }
      return null;
    }
    case 'flex': {
      // `flex: none | [ <flex-grow> <flex-shrink>? || <flex-basis> ]`.
      // Spec defaults when a component is omitted in the NON-keyword form:
      // a bare number sets basis to `0%` (NOT auto); a bare basis sets
      // grow/shrink to 1. Emit `flex-basis:0%` to match Chrome's computed
      // serialisation (so denoise Pass 5 collapses the real `flex:1` +
      // `flex-grow:1`/`flex-basis:0%` trio). Bail (null) on any token we can't
      // classify — no expansion just means no collapse, never a wrong one.
      const v=value.trim().toLowerCase();
      if(v==='none')    return new Map([['flex-grow','0'],['flex-shrink','0'],['flex-basis','auto']]);
      if(v==='auto')    return new Map([['flex-grow','1'],['flex-shrink','1'],['flex-basis','auto']]);
      if(v==='initial') return new Map([['flex-grow','0'],['flex-shrink','1'],['flex-basis','auto']]);
      const tokens=splitTopLevel(value);
      if(tokens.length<1||tokens.length>3) return null;
      const isNum=(t: string)=>/^\d*\.?\d+$/.test(t);
      const basisKeywords=new Set(['auto','content','max-content','min-content','fit-content']);
      const isBasis=(t: string)=>{
        const lt=t.toLowerCase();
        return basisKeywords.has(lt)||/^fit-content\(/.test(lt)||lt.startsWith('calc(')||isLength(t);
      };
      const nums: string[]=[];
      let basis: string|undefined;
      for(const t of tokens) {
        if(isNum(t)) nums.push(t);
        else if(basis===undefined&&isBasis(t)) basis=t;
        else return null;
      }
      if(nums.length>2) return null;
      return new Map([
        ['flex-grow',nums[0]??'1'],
        ['flex-shrink',nums[1]??'1'],
        ['flex-basis',basis??'0%'],
      ]);
    }
    case 'overflow': {
      const [x,y]=parseTwo(value);
      return new Map([['overflow-x',x],['overflow-y',y]]);
    }
    case 'gap': {
      const [row,col]=parseTwo(value);
      return new Map([['row-gap',row],['column-gap',col]]);
    }
    case 'place-items':
    case 'place-content':
    case 'place-self': {
      const [a,b]=parseTwo(value);
      const base=prop.slice('place-'.length);
      return new Map([[`align-${base}`,a],[`justify-${base}`,b]]);
    }
    case 'outline': {
      const parsed=parseBorderTriple(value);
      if(!parsed) return null;
      return new Map([
        ['outline-width',parsed.width],['outline-style',parsed.style],
        ['outline-color',parsed.color],
      ]);
    }
    case 'border-inline':
    case 'border-block': {
      const parsed=parseBorderTriple(value);
      if(!parsed) return null;
      const axis=prop.slice('border-'.length);
      return new Map([
        [`border-${axis}-start-width`,parsed.width],
        [`border-${axis}-start-style`,parsed.style],
        [`border-${axis}-start-color`,parsed.color],
        [`border-${axis}-end-width`,parsed.width],
        [`border-${axis}-end-style`,parsed.style],
        [`border-${axis}-end-color`,parsed.color],
      ]);
    }
    case 'border-inline-style':
    case 'border-inline-color':
    case 'border-inline-width':
    case 'border-block-style':
    case 'border-block-color':
    case 'border-block-width': {
      const m=prop.match(/^border-(inline|block)-(style|color|width)$/);
      if(!m) return null;
      const axis=m[1];
      const part=m[2];
      const [a,b]=parseTwo(value);
      return new Map([
        [`border-${axis}-start-${part}`,a],[`border-${axis}-end-${part}`,b],
      ]);
    }
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shorthand ↔ longhand coverage for EMISSION ORDER + the cascade guard (Pass 6b).
//
// The extracted style map keys per DECLARED property (a shorthand and one of its
// longhands can BOTH survive as independent per-property cascade winners). Once
// flattened into a single `#id{…}` rule, source order decides — so a shorthand
// emitted AFTER a covered longhand silently clobbers it. `orderPropsShorthandFirst`
// re-orders every emitted rule so a shorthand precedes its longhands, letting the
// higher-priority longhand (kept in the map precisely because it out-ranks the
// shorthand) win its component. See extract.ts / style-string.ts.
//
// `SHORTHAND_COVERAGE` lists shorthands `expandShorthand` does NOT model (it needs
// per-value parsing those don't have). The value-INDEPENDENT membership below is
// exactly what a shorthand RESETS: every listed longhand is set by the shorthand
// (an omitted component → its initial value), so the set is safe for the cascade
// drop in resolve.ts Pass 6b (a covered longhand out-ranked by the shorthand is
// dead). Membership is SPEC-conservative — when unsure, OMIT: an under-claim only
// forgoes a re-order (harmless), an over-claim would drop a live longhand (breaks
// the render). NB `background` does NOT reset `background-blend-mode`.
// ─────────────────────────────────────────────────────────────────────────────
export const SHORTHAND_COVERAGE: Record<string, readonly string[]> = {
  background: [
    'background-image', 'background-position', 'background-position-x', 'background-position-y',
    'background-size', 'background-repeat', 'background-origin', 'background-clip',
    'background-attachment', 'background-color',
  ],
  'background-position': ['background-position-x', 'background-position-y'],
  font: [
    'font-style', 'font-variant', 'font-weight', 'font-stretch', 'font-size', 'line-height',
    'font-family', 'font-size-adjust', 'font-kerning', 'font-feature-settings',
    'font-variation-settings', 'font-optical-sizing', 'font-language-override',
  ],
  'list-style': ['list-style-type', 'list-style-position', 'list-style-image'],
  'text-decoration': ['text-decoration-line', 'text-decoration-style', 'text-decoration-color', 'text-decoration-thickness'],
  columns: ['column-width', 'column-count'],
  'column-rule': ['column-rule-width', 'column-rule-style', 'column-rule-color'],
};

/** Longhands a property covers, for EMISSION ORDER only (names, not values):
 *  `expandShorthand`'s box/border/flex families ∪ the `SHORTHAND_COVERAGE` set. */
function coveredForOrdering(prop: string, value: string): string[] {
  const out: string[] = [];
  const exp = expandShorthand(prop, value);
  if (exp) out.push(...exp.keys());
  const stat = SHORTHAND_COVERAGE[prop];
  if (stat) out.push(...stat);
  return out;
}

/**
 * Emission order for a bucket with NO cascade provenance — one assembled by
 * `applyBucket`/`applyDiff`, where an existing key keeps its position and a new
 * one is appended to the tail, so a patch can land a `background` behind the
 * `background-color` that beats it.
 *
 * It performs the MINIMAL repair: each shorthand moves to just before the first
 * longhand it covers, and nothing else shifts. A global depth sort would also
 * re-order pairs it has no coverage relation for — through a third property
 * lending a longhand depth — and on an extracted bucket (already in cascade
 * order, §4.5) that silently repaints, e.g. `margin-inline` + `margin-inline-start`
 * + `margin` moving `margin` in front of the logical longhand it does NOT know it
 * covers. Stable: a bucket with no covering pair comes back untouched.
 *
 * The repair is still only a NET. It cannot know which side won the cascade, so
 * it assumes the longhand did — true for a provenance-less bucket built from a
 * patch, and true after denoise (a longhand a shorthand beats is dead and gets
 * dropped by Pass 6/6b). Where that assumption fails, the fix belongs upstream:
 * cascade key order for extracted buckets, Pass 6/6b for dead longhands.
 *
 * Inserting before the FIRST covered longhand relies on coverage being
 * transitively closed — the one nested chain in the tables, `background` →
 * `background-position` → `-x`/`-y`, lists the grandchildren on the grandparent
 * too. An unclosed chain could place a grandchild before its grandparent.
 */
export function orderPropsShorthandFirst(entries: Iterable<readonly [string, string]>): string[] {
  const out: string[] = [];
  for (const [prop, value] of entries) {
    const covered = new Set(coveredForOrdering(prop, value));
    covered.delete(prop);
    let at = out.length;
    for (let i = 0; i < out.length; i++) {
      if (covered.has(out[i]!)) { at = i; break; }
    }
    out.splice(at, 0, prop);
  }
  return out;
}
