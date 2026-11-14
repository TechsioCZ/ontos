import { Effect, Exit, Scope } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ProcessCompositionValidationAlreadyStarted,
  startProcessCompositionValidation,
} from '../zerops/process-composition-validation.mts';

it.effect('owns one process registry and releases it when startup closes', () =>
  Effect.gen(function* releaseRegistry() {
    expect(globalThis.ontosProcessCompositionValidation).toBeUndefined();
    const scope = yield* Scope.make();
    yield* startProcessCompositionValidation.pipe(Scope.provide(scope));
    expect(globalThis.ontosProcessCompositionValidation).toBeDefined();
    yield* Scope.close(scope, Exit.void);
    expect(globalThis.ontosProcessCompositionValidation).toBeUndefined();
  }),
);

it.effect('refuses a second host without replacing or releasing the first registry', () =>
  Effect.gen(function* preserveRegistry() {
    yield* startProcessCompositionValidation;
    const registry = globalThis.ontosProcessCompositionValidation;
    const failure = yield* startProcessCompositionValidation.pipe(Effect.scoped, Effect.flip);
    expect(failure).toBeInstanceOf(ProcessCompositionValidationAlreadyStarted);
    expect(globalThis.ontosProcessCompositionValidation).toBe(registry);
  }),
);

it.effect('releases the registry after a later startup failure', () =>
  Effect.gen(function* releaseFailedStartup() {
    const failure = yield* startProcessCompositionValidation.pipe(
      Effect.andThen(Effect.fail('later startup failed')),
      Effect.scoped,
      Effect.flip,
    );
    expect(failure).toBe('later startup failed');
    expect(globalThis.ontosProcessCompositionValidation).toBeUndefined();
  }),
);
