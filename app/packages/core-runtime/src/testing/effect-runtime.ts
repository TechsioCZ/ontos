/** Repository-owned test entry points keep Effect execution behind one auditable boundary. */
export {
  makeEffectTestCallback,
  runEffectTestPromise,
  runEffectTestSync,
} from '../../tests/support/effect-runtime.ts';
