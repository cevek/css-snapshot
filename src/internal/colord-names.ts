// colord's names plugin, extended once. colord's package has no `"type": "module"`, so
// under `moduleResolution: nodenext` (a consumer type-checking these sources) its
// `plugins/names.d.ts` reads as CommonJS and the default import types as the module
// namespace, not the `Plugin` it is at runtime (the ESM `names.mjs` default export).

import { extend, type Plugin } from 'colord';
import namesModule from 'colord/plugins/names';

const namesPlugin = ((namesModule as { default?: Plugin }).default ?? namesModule) as Plugin;
extend([namesPlugin]);
