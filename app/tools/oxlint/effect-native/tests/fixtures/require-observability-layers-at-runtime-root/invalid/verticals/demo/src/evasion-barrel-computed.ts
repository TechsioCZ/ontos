// expect-count: 3
// Evasion: root barrel namespace reached through a computed string key.
import * as EffectNs from 'effect';

declare const demoLayer: EffectNs.Layer.Layer<never>;

export const boot = () => EffectNs['ManagedRuntime'].make(demoLayer);
