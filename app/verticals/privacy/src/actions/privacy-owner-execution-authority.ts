import type {
  ActionCoreError,
  ActionServicePreparationContext,
  DataAccessEventInput,
  OperationalScope,
} from '@app/core-runtime';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import type { Crypto } from 'effect';

import type {
  OwnerExecutionAuthorityResult,
  OwnerExecutionOutcomeRequest,
  PrivacyMeasureHandoff,
} from '../../shared/domain/privacy-measure-handoff.ts';
import {
  OwnerExecutionOutcomeRequestSchema,
  PrivacyMeasureHandoffSchema,
  validateOwnerExecutionAuthorityResult,
} from '../../shared/domain/privacy-measure-handoff.ts';
import { PrivacyActionRejected } from './privacy-action-rejected.ts';
import { PrivacyOperationPersistenceError } from '../persistence/privacy-operation-repository.ts';
import { privacyOperationRepositoryWithReadEvidence } from '../persistence/privacy-operation-postgres-repository.ts';
import { privacySubjectPreparationScopeMatches } from '../persistence/privacy-subject-preparation.ts';
import { requirePrivacyActionScope } from './privacy-operation-action-support.ts';
import type { PrivacyActionScopeRequired } from './privacy-action-scope-required.ts';

interface OwnerExecutionAuthorityContext {
  readonly actionInvocationId: string;
  readonly handoff: PrivacyMeasureHandoff;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

/**
 * Private owner boundary for execution receipts. Public Actions provide only
 * the request identity; an adapter must load and attest the actual result.
 */
export interface OwnerExecutionAuthorityService {
  readonly resolve: (
    request: OwnerExecutionOutcomeRequest,
    context: OwnerExecutionAuthorityContext,
  ) => Effect.Effect<OwnerExecutionAuthorityResult, PrivacyActionRejected | PrivacyOperationPersistenceError>;
}

export class OwnerExecutionAuthority extends Context.Service<OwnerExecutionAuthority, OwnerExecutionAuthorityService>()(
  '@app/privacy/actions/privacy-owner-execution-authority/OwnerExecutionAuthority',
) {}

export const ownerExecutionAuthorityUnavailable = Object.freeze({
  resolve: () =>
    Effect.fail(
      new PrivacyOperationPersistenceError({
        code: 'privacy_operation_persistence_unavailable',
        reason: 'Owner execution authority is not configured',
      }),
    ),
}) satisfies OwnerExecutionAuthorityService;

export const OwnerExecutionAuthorityUnavailableLive = Layer.succeed(
  OwnerExecutionAuthority,
  ownerExecutionAuthorityUnavailable,
);

export interface PreparedOwnerExecution {
  readonly authority: OwnerExecutionAuthorityResult;
  readonly context: Pick<ActionServicePreparationContext, 'actionInvocationId' | 'compositionRevision' | 'scope'>;
  readonly handoff: PrivacyMeasureHandoff;
  readonly readEvidence?: readonly DataAccessEventInput[];
  readonly request: OwnerExecutionOutcomeRequest;
}

const preparedOwnerRejected = () =>
  new PrivacyActionRejected({
    code: 'privacy_action_rejected',
    reason: 'Prepared owner receipt does not match the exact invocation and immutable handoff',
  });

/** Resolve an existing owner receipt only after Core has released its local handoff snapshot. */
export const observeOwnerExecutionPreparation = Effect.fn('OwnerExecutionAuthority.observePreparation')(
  function* observePreparation(
    input: Omit<PreparedOwnerExecution, 'authority'>,
  ): Effect.fn.Return<
    PreparedOwnerExecution,
    PrivacyActionRejected | PrivacyOperationPersistenceError,
    OwnerExecutionAuthority
  > {
    const { context } = input;
    const handoff = structuredClone(input.handoff);
    const request = structuredClone(input.request);
    if (context.scope.legalEntityId === undefined || handoff.tenantId !== context.scope.tenantId) {
      return yield* preparedOwnerRejected();
    }
    const owner = yield* OwnerExecutionAuthority;
    const authority = yield* owner.resolve(structuredClone(request), {
      actionInvocationId: context.actionInvocationId,
      handoff: structuredClone(handoff),
      legalEntityId: context.scope.legalEntityId,
      principalId: context.scope.principalId,
      tenantId: context.scope.tenantId,
    });
    const reason = validateOwnerExecutionAuthorityResult(handoff, request, authority);
    if (reason !== undefined) {
      return yield* new PrivacyActionRejected({ code: 'privacy_action_rejected', reason });
    }
    return {
      authority: structuredClone(authority),
      context,
      handoff,
      readEvidence: structuredClone(input.readEvidence ?? []),
      request,
    };
  },
);

export const ownerExecutionPreparationScopeMatches = (
  prepared: PreparedOwnerExecution,
  scope: OperationalScope,
  compositionRevision: string,
): boolean =>
  compositionRevision === prepared.context.compositionRevision &&
  privacySubjectPreparationScopeMatches(prepared.context.scope, scope);

/** The handler must supply the handoff reloaded through its real final-transaction repository. */
export const preparedOwnerExecutionAuthority = (prepared: PreparedOwnerExecution): OwnerExecutionAuthorityService => ({
  resolve: Effect.fn('OwnerExecutionAuthority.resolvePrepared')(function* resolvePrepared(request, context) {
    if (
      context.actionInvocationId !== prepared.context.actionInvocationId ||
      context.legalEntityId !== prepared.context.scope.legalEntityId ||
      context.principalId !== prepared.context.scope.principalId ||
      context.tenantId !== prepared.context.scope.tenantId ||
      !Schema.toEquivalence(OwnerExecutionOutcomeRequestSchema)(request, prepared.request) ||
      !Schema.toEquivalence(PrivacyMeasureHandoffSchema)(context.handoff, prepared.handoff)
    ) {
      return yield* preparedOwnerRejected();
    }
    return prepared.authority;
  }),
});

export const prepareOwnerExecutionAuthority = Effect.fn('OwnerExecutionAuthority.prepare')(function* prepareAuthority(
  request: OwnerExecutionOutcomeRequest,
  context: ActionServicePreparationContext,
): Effect.fn.Return<
  PreparedOwnerExecution,
  ActionCoreError | PrivacyActionRejected | PrivacyOperationPersistenceError | PrivacyActionScopeRequired,
  Crypto.Crypto | OwnerExecutionAuthority
> {
  const capturedRequest = structuredClone(request);
  const scope = yield* requirePrivacyActionScope(context.scope);
  const readEvidence: DataAccessEventInput[] = [];
  const handoff = yield* context.transaction((transaction) =>
    privacyOperationRepositoryWithReadEvidence(transaction, { readEvidence, scope: context.scope }).pipe(
      Effect.flatMap((repository) =>
        repository.getPrivacyMeasureHandoff(scope.tenantId, scope.legalEntityId, capturedRequest.measureId),
      ),
      Effect.map(Option.map((value) => structuredClone(value))),
    ),
  );
  if (Option.isNone(handoff)) {
    return yield* new PrivacyOperationPersistenceError({
      code: 'privacy_operation_not_found',
      reason: 'Privacy Measure dispatch was not found',
    });
  }
  return yield* observeOwnerExecutionPreparation({
    context: {
      actionInvocationId: context.actionInvocationId,
      compositionRevision: context.compositionRevision,
      scope: context.scope,
    },
    handoff: handoff.value,
    readEvidence,
    request: capturedRequest,
  });
});
