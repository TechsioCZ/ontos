// expect-count: 2
// Namespace-only exports do not run Effects; only the two known runner exports are seams.
export { Effect, runEffectRequest } from '@modern-js/plugin-bff/effect-client';
export { runEffectView } from '../view-runner.ts';
export { Effect as EffectNamespace } from 'effect';
