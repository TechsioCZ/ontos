import { ActionResultValidationError } from '@app/core-runtime';
import type {
  ActionCoreError,
  ActionAuthorizationPreflightInput,
  ActionPostAttemptHook,
  ActionPostAttemptResult,
} from '@app/core-runtime';
import { Context, Effect, Exit, Match, Option, Schema } from 'effect';

import { MarketCommandRejected, MarketLifecycleResultSchema } from '../../shared/action-contracts.ts';
import type { RetireMarketPayload } from '../../shared/action-contracts.ts';
import { MarketRetirementSettlementPending } from '../../shared/market-retirement-admission.ts';
import type {
  MarketRetirementAdmissionEvidence,
  MarketRetirementEffectRecoveryResult,
} from '../../shared/market-retirement-admission.ts';
import type { MarketRetirementImpactFactory } from './market-retirement-impact-authority.ts';
import { MarketRetirementImpactAssessmentRejected } from '../actions/market-retirement-impact-assessment-rejected.ts';
import { MarketRetirementImpactAssessmentStale } from '../actions/market-retirement-impact-assessment-stale.ts';
import type { MarketRetirementImpactAssessmentUnavailable } from '../actions/market-retirement-impact-assessment-unavailable.ts';
import type { MarketAdministrationPersistenceUnavailable } from './market-administration.service.ts';

type RetirementDomainError =
  | MarketCommandRejected
  | MarketAdministrationPersistenceUnavailable
  | MarketRetirementImpactAssessmentRejected
  | MarketRetirementImpactAssessmentStale
  | MarketRetirementImpactAssessmentUnavailable
  | MarketRetirementSettlementPending;

export type MarketRetirementPostAttemptHook = ActionPostAttemptHook<
  RetireMarketPayload,
  typeof MarketLifecycleResultSchema.Type,
  RetirementDomainError,
  MarketRetirementPostAttempt
>;

/** Request-local owner settlement binding; Core alone supplies the genuine attempt and lease. */
export class MarketRetirementPostAttempt extends Context.Service<
  MarketRetirementPostAttempt,
  RetirementSettlementDependencies
>()('@app/commerce-market-catalog/services/market-retirement-post-attempt/MarketRetirementPostAttempt') {}

const terminalRetirementErrors = Schema.Union([
  MarketCommandRejected,
  MarketRetirementImpactAssessmentRejected,
  MarketRetirementImpactAssessmentStale,
]);
type RetirementFailure = RetirementDomainError | ActionCoreError;
type RetirementAttempt = Parameters<MarketRetirementPostAttemptHook>[0];
type CommittedReceipt = Extract<MarketRetirementAdmissionEvidence, { readonly outcome: 'COMMITTED' }>;
interface SettlementState {
  readonly admission?: MarketRetirementAdmissionEvidence;
  readonly admitted?: ActionAuthorizationPreflightInput;
  readonly ownerFailure?: RetirementFailure;
}
interface RetirementSettlementDependencies {
  readonly abort: (
    source: ActionAuthorizationPreflightInput,
    payload: RetireMarketPayload,
  ) => Effect.Effect<MarketRetirementAdmissionEvidence, RetirementFailure>;
  readonly authorityFor: (
    source: ActionAuthorizationPreflightInput,
    receipt: MarketRetirementAdmissionEvidence,
    payload: RetireMarketPayload,
  ) => ReturnType<MarketRetirementImpactFactory['forAdmission']>;
  readonly decodeFailure: (failure: RetirementFailure) => Effect.Effect<never, RetirementFailure>;
  readonly readState: Effect.Effect<SettlementState>;
  readonly recover: (
    source: ActionAuthorizationPreflightInput,
    payload: RetireMarketPayload,
  ) => Effect.Effect<MarketRetirementEffectRecoveryResult, MarketRetirementImpactAssessmentUnavailable>;
  readonly resolveOriginalSource: (
    actionInvocationId: string,
    payload: RetireMarketPayload,
  ) => Effect.Effect<ActionAuthorizationPreflightInput, MarketRetirementImpactAssessmentUnavailable>;
  readonly unavailable: () => MarketRetirementImpactAssessmentUnavailable;
}
interface SettlementInput {
  readonly attempt: RetirementAttempt;
  readonly source: ActionAuthorizationPreflightInput;
}
const settled: ActionPostAttemptResult<typeof MarketLifecycleResultSchema.Type> = { _tag: 'Settled' };
const pending = (input: {
  readonly reason: string;
  readonly result: typeof MarketLifecycleResultSchema.Type;
  readonly sourceActionInvocationId: string;
}) => {
  const failure = new MarketRetirementSettlementPending({
    code: 'market_retirement_settlement_unavailable',
    committedResult: input.result,
    reason: input.reason,
    sourceActionInvocationId: input.sourceActionInvocationId,
  });
  return failure;
};
const finalizeCommitted = Effect.fn('MarketRetirement.finalizeCommitted')(function* finalizeCommitted(
  input: SettlementInput,
  receipt: CommittedReceipt,
) {
  const { attempt, source } = input;
  const dependencies = yield* MarketRetirementPostAttempt;
  const finalized = yield* Effect.exit(
    dependencies.authorityFor(source, receipt, attempt.payload).commitRetirementImpact({
      actionInvocationId: source.actionInvocationId,
      assessment: receipt.assessment,
      compositionRevision: attempt.compositionRevision,
      legalEntityId: source.scope.legalEntityId ?? '',
      reason: attempt.payload.reason,
    }),
  );
  if (Exit.isFailure(finalized)) {
    return yield* pending({
      reason: 'Market retirement committed; original Customer Context finalization remains pending',
      result: receipt.result,
      sourceActionInvocationId: source.actionInvocationId,
    });
  }
  return yield* Effect.void;
});
const abortTerminal = Effect.fn('MarketRetirement.abortTerminal')(function* abortTerminal(
  input: SettlementInput,
  receipt: Exclude<MarketRetirementEffectRecoveryResult, { readonly outcome: 'NOT_FOUND' }>,
  terminal: typeof terminalRetirementErrors.Type,
) {
  const { attempt, source } = input;
  const dependencies = yield* MarketRetirementPostAttempt;
  const aborted = receipt.outcome === 'ABORTED' ? receipt : yield* dependencies.abort(source, attempt.payload);
  if (aborted.outcome === 'COMMITTED') {
    return yield* pending({
      reason: 'A concurrent original retirement committed; recovery is required',
      result: aborted.result,
      sourceActionInvocationId: source.actionInvocationId,
    });
  }
  if (aborted.outcome !== 'ABORTED' || aborted.abortProof === undefined) {
    return yield* dependencies.unavailable();
  }
  const cleanup = yield* Effect.exit(
    dependencies.authorityFor(source, aborted, attempt.payload).cleanupOriginal(aborted.abortProof),
  );
  return yield* Schema.decodeUnknownEffect(terminalRetirementErrors)({
    _tag: terminal._tag,
    code: terminal.code,
    reason: terminal.reason,
    retirementSettlement: {
      pendingCleanup: Exit.isFailure(cleanup),
      resolution: 'RECOVER_ORIGINAL_EFFECT',
      retryCommand: false,
      sourceActionInvocationId: source.actionInvocationId,
      state: 'ABORTED',
    },
  }).pipe(Effect.mapError(dependencies.unavailable), Effect.flatMap(Effect.fail));
});
const settleCommitted = Effect.fn('MarketRetirement.settleCommitted')(function* settleCommitted(
  attempt: RetirementAttempt,
  result: typeof MarketLifecycleResultSchema.Type,
) {
  const dependencies = yield* MarketRetirementPostAttempt;
  const snapshot = yield* dependencies.readState;
  const source = snapshot.admitted;
  if (source === undefined) {
    return yield* pending({
      reason: 'Market committed but the original settlement receipt is unavailable',
      result,
      sourceActionInvocationId: attempt.actionInvocationId,
    });
  }
  const receipt = yield* dependencies.recover(source, attempt.payload).pipe(
    Effect.mapError((error) =>
      Object.defineProperty(
        pending({
          reason: 'Market retirement committed; original settlement receipt could not be read',
          result,
          sourceActionInvocationId: source.actionInvocationId,
        }),
        'cause',
        { configurable: true, value: error },
      ),
    ),
  );
  if (receipt.outcome !== 'COMMITTED') {
    return yield* pending({
      reason: 'Market committed but the original settlement receipt is unavailable',
      result,
      sourceActionInvocationId: source.actionInvocationId,
    });
  }
  yield* finalizeCommitted({ attempt, source }, receipt);
  return settled;
});
const recoverCommitted = Effect.fn('MarketRetirement.recoverCommitted')(function* recoverCommitted(
  attempt: RetirementAttempt,
) {
  const dependencies = yield* MarketRetirementPostAttempt;
  const snapshot = yield* dependencies.readState;
  const source =
    snapshot.admitted ?? (yield* dependencies.resolveOriginalSource(attempt.actionInvocationId, attempt.payload));
  if (snapshot.admission === undefined && snapshot.ownerFailure !== undefined) {
    return yield* dependencies.decodeFailure(snapshot.ownerFailure);
  }
  const receipt = yield* dependencies.recover(source, attempt.payload);
  if (receipt.outcome === 'COMMITTED') {
    yield* finalizeCommitted({ attempt, source }, receipt);
    const recovered = yield* Schema.decodeUnknownEffect(MarketLifecycleResultSchema)(receipt.result).pipe(
      Effect.mapError((cause) =>
        Object.defineProperty(
          new ActionResultValidationError({
            code: 'action_result_invalid',
            reason: 'Original committed Market result is unavailable',
          }),
          'cause',
          { value: cause },
        ),
      ),
    );
    const recovery: ActionPostAttemptResult<typeof MarketLifecycleResultSchema.Type> = {
      _tag: 'Recovered',
      result: recovered,
    };
    return recovery;
  }
  return snapshot.ownerFailure === undefined ? settled : yield* dependencies.decodeFailure(snapshot.ownerFailure);
});
const settleUncommitted = Effect.fn('MarketRetirement.settleUncommitted')(function* settleUncommitted(
  attempt: RetirementAttempt,
  rejection: RetirementDomainError | undefined,
) {
  const dependencies = yield* MarketRetirementPostAttempt;
  const snapshot = yield* dependencies.readState;
  const source = snapshot.admitted;
  if (source === undefined || (snapshot.admission === undefined && snapshot.ownerFailure !== undefined)) {
    return snapshot.ownerFailure === undefined ? settled : yield* dependencies.decodeFailure(snapshot.ownerFailure);
  }
  const receipt = yield* dependencies.recover(source, attempt.payload);
  if (receipt.outcome === 'COMMITTED') {
    return yield* pending({
      reason: 'Committed original effect requires Core-verified recovery',
      result: receipt.result,
      sourceActionInvocationId: source.actionInvocationId,
    });
  }
  const terminal = Schema.decodeUnknownOption(terminalRetirementErrors)(snapshot.ownerFailure ?? rejection);
  if (receipt.outcome !== 'NOT_FOUND' && Option.isSome(terminal)) {
    return yield* abortTerminal({ attempt, source }, receipt, terminal.value);
  }
  return snapshot.ownerFailure === undefined ? settled : yield* dependencies.decodeFailure(snapshot.ownerFailure);
});
/** Core alone supplies the attempt; collaborators are bound at the API composition root. */
export const settleMarketRetirementAttempt: MarketRetirementPostAttemptHook = Effect.fn(
  'MarketRetirement.settleAttempt',
)(function* settleAttempt(attempt: RetirementAttempt) {
  return yield* Match.value(attempt.outcome).pipe(
    Match.tag('Committed', (outcome) => settleCommitted(attempt, outcome.result)),
    Match.tag('CommittedRejection', () => Effect.succeed(settled)),
    Match.tag('AlreadyCommitted', () => recoverCommitted(attempt)),
    Match.tag('DefinitelyUncommitted', (outcome) => settleUncommitted(attempt, outcome.rejection)),
    Match.tag('Indeterminate', () => recoverCommitted(attempt)),
    Match.tag('Interrupted', () => Effect.succeed(settled)),
    Match.exhaustive,
  );
});
