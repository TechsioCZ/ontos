// expect-count: 1
// Evasion: namespace import of the BFF Effect re-export barrel.
import * as Bff from '@modern-js/plugin-bff/effect-edge';

export const Visibility = Bff.Schema.Literals(['public_module_event', 'internal_module_event']);
export const Row = Bff.Schema.Struct({
  visibility: Bff.Schema.Literals(['internal_module_event', 'public_module_event']),
});
