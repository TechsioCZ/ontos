import type { ActionCoreError, ActionRuntimeService } from '@app/core-runtime';
import { Effect, Schema } from 'effect';

type JsonValue = Schema.Schema.Type<typeof Schema.Json>;

type TestActionOutcome =
  | { readonly error: ActionCoreError; readonly kind: 'core-failure' }
  | { readonly defect: Error | string; readonly kind: 'defect' }
  | { readonly error: Readonly<{ readonly _tag: string }>; readonly kind: 'domain-failure' }
  | { readonly kind: 'success'; readonly value: JsonValue };

export const actionCoreFailure = (error: ActionCoreError): TestActionOutcome => ({
  error,
  kind: 'core-failure',
});

export const actionDefect = (defect: Error | string): TestActionOutcome => ({
  defect,
  kind: 'defect',
});

export const actionDomainFailure = (
  error: Readonly<{ readonly _tag: string }>,
): TestActionOutcome => ({ error, kind: 'domain-failure' });

export const actionSuccess = (value: JsonValue): TestActionOutcome => ({
  kind: 'success',
  value,
});

export const makeActionRuntimeDouble = (outcomes: readonly TestActionOutcome[]) => {
  let invocation = 0;
  const payloads: unknown[] = [];
  const runtime: ActionRuntimeService = {
    resolveActionCommit: () => Effect.die('resolveActionCommit is not configured in this test'),
    runAction: (input) => {
      payloads.push(input.payload);
      const outcome = outcomes[invocation];
      invocation += 1;
      if (outcome === undefined) {
        return Effect.die(`Action invocation ${invocation} has no configured outcome`);
      }
      if (outcome.kind === 'core-failure') {
        return Effect.fail(outcome.error);
      }
      if (outcome.kind === 'defect') {
        return Effect.die(outcome.defect);
      }
      if (outcome.kind === 'domain-failure') {
        const schema = input.registration.descriptor.domainErrorSchema;
        return Schema.is(schema)(outcome.error)
          ? Effect.fail(outcome.error)
          : Effect.die('Configured action domain failure does not match registration schema');
      }
      return Effect.sync(() =>
        Schema.decodeUnknownSync(input.registration.descriptor.resultSchema)(outcome.value),
      );
    },
  };
  return { invocationCount: () => invocation, payloads, runtime };
};
