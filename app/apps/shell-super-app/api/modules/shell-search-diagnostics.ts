import { Clock, Effect, Option, Schema } from 'effect';

const diagnosticToken = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-zA-Z0-9_][a-zA-Z0-9_.:-]*$/u),
);
const failureIdentity = Schema.Struct({
  _tag: Schema.optionalKey(diagnosticToken),
  code: Schema.optionalKey(diagnosticToken),
});
const ownerResponse = Schema.Struct({
  body: Schema.String,
  status: Schema.Int.check(Schema.isGreaterThanOrEqualTo(400), Schema.isLessThanOrEqualTo(599)),
});
const wrappedFailure = Schema.TaggedStruct('ShellProviderUnavailableError', {
  cause: Schema.optionalKey(Schema.Union([ownerResponse, failureIdentity])),
});
const problemIdentity = Schema.fromJsonString(
  Schema.Struct({
    code: Schema.optionalKey(diagnosticToken),
    error: Schema.optionalKey(diagnosticToken),
  }),
);
const decodeFailureIdentity = Schema.decodeUnknownOption(failureIdentity);
const decodeWrappedFailure = Schema.decodeUnknownOption(wrappedFailure);
const decodeOwnerResponse = Schema.decodeUnknownOption(ownerResponse);
const decodeProblemIdentity = Schema.decodeUnknownOption(problemIdentity);

/** Inspect only the declared failure and its single known provider wrapper, never arbitrary nested causes. */
export const shellSearchFailureIdentity = <Failure>(failure: Failure) => {
  const declared = Option.getOrUndefined(decodeFailureIdentity(failure));
  const wrapper = decodeWrappedFailure(failure);
  const cause = Option.getOrUndefined(
    wrapper.pipe(Option.flatMap(({ cause: declaredCause }) => decodeFailureIdentity(declaredCause))),
  );
  const response = Option.getOrUndefined(
    wrapper.pipe(Option.flatMap(({ cause: declaredCause }) => decodeOwnerResponse(declaredCause))),
  );
  const problem =
    response !== undefined && response.body.length <= 8192
      ? Option.getOrUndefined(decodeProblemIdentity(response.body))
      : undefined;
  return {
    search_cause_tag: cause?._tag ?? 'none',
    search_failure_code: declared?.code ?? 'none',
    search_failure_tag: declared?._tag ?? 'untyped',
    search_http_status: response?.status ?? 0,
    search_problem_code: problem?.code ?? problem?.error ?? 'none',
  };
};

export interface ShellSearchProviderPhase {
  readonly moduleId: string;
  readonly phase: 'assertion' | 'owner' | 'decode';
  readonly searchKey: string;
}

const reportProviderFailure = Effect.fn('ShellSearchDiagnostics.reportProviderFailure')(function* report<Failure>(
  provider: ShellSearchProviderPhase,
  startedAt: number,
  failure: Failure,
) {
  const finishedAt = yield* Clock.currentTimeMillis;
  yield* Effect.logWarning('Shell search provider failed').pipe(
    Effect.annotateLogs({
      ...shellSearchFailureIdentity(failure),
      search_duration_ms: Math.max(0, finishedAt - startedAt),
      search_module: provider.moduleId,
      search_phase: provider.phase,
      search_provider: provider.searchKey,
    }),
  );
});

/** Success stays silent. Failed reads retain their owner and phase without inspecting defects. */
export const observeShellSearchProvider = (provider: ShellSearchProviderPhase) =>
  Effect.fn('ShellSearchDiagnostics.observeShellSearchProvider')(function* observe<Value, Failure, Requirements>(
    effect: Effect.Effect<Value, Failure, Requirements>,
  ) {
    const startedAt = yield* Clock.currentTimeMillis;
    return yield* effect.pipe(Effect.tapError((failure) => reportProviderFailure(provider, startedAt, failure)));
  });
