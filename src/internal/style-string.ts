// style-string.ts — serialise a resolved decl map to `prop:value;…` (ported).
import { cascadeOrdered } from './cascade.ts';

export function buildStyleString(decls: Map<string, { value: string; important: boolean; order?: number }>): string {
  const parts: string[] = [];
  // Cascade order, NOT map order: a key sits where the property FIRST appeared,
  // while its value is the winner's, so map order says nothing about who
  // overrides whom in the flat rule (src/cascade.ts `cascadeOrdered`).
  for (const [name, d] of cascadeOrdered(decls)) {
    const v = d.value.trim();
    if (!v) continue;
    parts.push(`${name}:${v}${d.important ? '!important' : ''}`);
  }
  return parts.join(';');
}
