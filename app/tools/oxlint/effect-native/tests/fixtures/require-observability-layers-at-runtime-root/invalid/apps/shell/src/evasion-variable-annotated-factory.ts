// expect-count: 3
// Evasion: the BFF factory's runtime type sits on the variable annotation, not on the arrow.
import type { EffectBffRuntime } from '@modern-js/plugin-bff/effect-edge';
import { Layer } from 'effect';

declare const shellApi: unknown;

export const makeShellRuntime: (auth: Layer.Layer<never>) => EffectBffRuntime<typeof shellApi> = (
  auth,
) => ({ layer: Layer.mergeAll(auth) }) as never;
