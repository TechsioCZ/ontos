// expect-count: 3
import { Layer } from 'effect';
import * as EffectNs from 'effect';

declare const Base: Layer.Layer<never>;

// A no-substitution template literal is the same computed key as `Layer['fresh']`,
// which the rule already reports.
export const templated = Layer[`fresh`](Base);
export const optionalTemplated = Layer?.[`fresh`](Base);
export const rootTemplated = EffectNs.Layer[`fresh`](Base);
