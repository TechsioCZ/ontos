import { randomUUID } from 'node:crypto';

import { OperationContextUnavailable } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import type { OwnerExecutionOutcome, PrivacyMeasureHandoff } from '@app/privacy/domain/privacy-measure-handoff';
import { and, eq, inArray } from 'drizzle-orm';
import { DateTime, Effect, Option } from 'effect';

import { ExecutePrivacyMeasureRejected } from '../../shared/actions/execute-privacy-measure.ts';
import { counterparties, privacyMeasureExecutions } from '../db/schema.ts';
import type { PartyTransaction } from '../db/types.ts';
import { fingerprintPrivacyMeasureHandoff, parseOwnerResourceRef } from '../privacy-measure-handoff.ts';

const OWNER = 'party.registry';
const RESOURCE_TYPE = 'party.registry.counterparty';
const CONTENT_SCOPE = 'party.registry.counterparty.lifecycle';

export interface PrivacyMeasureExecutionReceipt {
  readonly actionInvocationId: string;
  readonly handoffFingerprint: string;
  readonly outcome: OwnerExecutionOutcome;
}

// oxlint-disable-next-line effect-native/require-context-service-for-service-interface -- The scoped Action/Read factory constructs and injects this owner-local transaction service; it has no independent Context lifetime. expires: 2027-03-31.
export interface PrivacyMeasureExecutionService {
  readonly execute: (
    handoff: PrivacyMeasureHandoff,
    actionInvocationId: string,
  ) => Effect.Effect<OwnerExecutionOutcome, ExecutePrivacyMeasureRejected>;
  readonly load: (
    idempotencyKey: string,
  ) => Effect.Effect<Option.Option<PrivacyMeasureExecutionReceipt>, ExecutePrivacyMeasureRejected>;
}

const rejected = (code: ExecutePrivacyMeasureRejected['code'], reason: string, retryable: boolean, cause?: unknown) => {
  const error = new ExecutePrivacyMeasureRejected({ code, reason, retryable });
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  }
  return error;
};

const persistenceUnavailable = (cause: unknown) =>
  rejected(
    'PRIVACY_MEASURE_PERSISTENCE_UNAVAILABLE',
    'Party Registry could not durably execute or reconcile the Privacy Measure',
    true,
    cause,
  );

const exactRestrictionIsSupported = (handoff: PrivacyMeasureHandoff): boolean =>
  handoff.kind === 'RESTRICT' &&
  handoff.requestedResult === 'ARCHIVED' &&
  handoff.dispositionDecision === null &&
  (handoff.right === 'RESTRICTION' || handoff.right === 'OBJECTION') &&
  handoff.contentScopeRefs.length === 1 &&
  handoff.contentScopeRefs[0] === CONTENT_SCOPE;

interface MakeOutcomeInput {
  readonly handoff: PrivacyMeasureHandoff;
  readonly includedResourceRefs: readonly string[];
  readonly now: Date;
  readonly reason: string;
  readonly remainingResourceRefs: readonly string[];
  readonly status: OwnerExecutionOutcome['status'];
}

const makeOutcome = ({
  handoff,
  includedResourceRefs,
  now,
  reason,
  remainingResourceRefs,
  status,
}: MakeOutcomeInput): OwnerExecutionOutcome => {
  const outcomeId = randomUUID();
  const instant = DateTime.formatIso(DateTime.makeUnsafe(now));
  return {
    attempt: 1,
    evidenceRefs: [`party.registry.privacy-measure-execution:${outcomeId}`],
    idempotencyKey: handoff.idempotencyKey,
    includedResourceRefs: [...includedResourceRefs],
    measureId: handoff.measureId,
    occurredAt: instant,
    outcomeId,
    owningCapability: OWNER,
    reason,
    recordedAt: instant,
    remainingResourceRefs: [...remainingResourceRefs],
    sourceDecisionRef: handoff.sourceDecisionRef,
    sourceDecisionRevision: handoff.sourceDecisionRevision,
    status,
    taskId: handoff.taskId,
  };
};

export const privacyMeasureExecutionService = (
  transaction: Pick<PartyTransaction, 'insert' | 'select' | 'update'>,
  scope: OperationalScope,
): Effect.Effect<PrivacyMeasureExecutionService, OperationContextUnavailable> => {
  if (scope.legalEntityId === undefined) {
    return Effect.fail(
      new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Privacy Measure execution requires a trusted Legal Entity scope',
      }),
    );
  }
  const { legalEntityId } = scope;
  const load: PrivacyMeasureExecutionService['load'] = (idempotencyKey) =>
    transaction
      .select({
        actionInvocationId: privacyMeasureExecutions.actionInvocationId,
        handoffFingerprint: privacyMeasureExecutions.handoffFingerprint,
        outcome: privacyMeasureExecutions.outcome,
      })
      .from(privacyMeasureExecutions)
      .where(
        and(
          eq(privacyMeasureExecutions.tenantId, scope.tenantId),
          eq(privacyMeasureExecutions.legalEntityId, legalEntityId),
          eq(privacyMeasureExecutions.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1)
      .pipe(
        Effect.map((rows) => Option.fromUndefinedOr(rows[0])),
        Effect.mapError(persistenceUnavailable),
      );

  const execute: PrivacyMeasureExecutionService['execute'] = Effect.fn('PartyPrivacyMeasureExecution.execute')(
    function* executePrivacyMeasure(handoff, actionInvocationId) {
      const fingerprint = fingerprintPrivacyMeasureHandoff(handoff);
      const prior = yield* load(handoff.idempotencyKey);
      if (Option.isSome(prior)) {
        if (prior.value.handoffFingerprint !== fingerprint) {
          return yield* rejected(
            'PRIVACY_MEASURE_IDEMPOTENCY_CONFLICT',
            'The idempotency identity is already bound to a different Privacy Measure handoff',
            false,
          );
        }
        return prior.value.outcome;
      }

      const refs = handoff.resourceRefs.map(parseOwnerResourceRef);
      if (
        handoff.tenantId !== scope.tenantId ||
        handoff.owningCapability !== OWNER ||
        refs.some((ref) => ref === undefined || ref.legalEntityId !== legalEntityId || ref.moduleId !== OWNER)
      ) {
        return yield* rejected(
          'PRIVACY_MEASURE_SCOPE_MISMATCH',
          'The handoff does not belong to the trusted Party Registry Tenant and Legal Entity scope',
          false,
        );
      }

      const parsedRefs = refs.filter((ref) => ref !== undefined);
      const now = yield* DateTime.nowAsDate;
      let outcome: OwnerExecutionOutcome;
      if (!exactRestrictionIsSupported(handoff) || parsedRefs.some((ref) => ref.resourceType !== RESOURCE_TYPE)) {
        outcome = makeOutcome({
          handoff,
          includedResourceRefs: [],
          now,
          reason: 'Party Registry supports only exact Counterparty lifecycle restriction to ARCHIVED',
          remainingResourceRefs: handoff.resourceRefs,
          status: 'BUSINESS_REJECTED',
        });
      } else {
        const resourceIds = parsedRefs.map((ref) => ref.resourceId);
        const existing = yield* transaction
          .select({ counterpartyId: counterparties.counterpartyId })
          .from(counterparties)
          .where(
            and(
              eq(counterparties.tenantId, scope.tenantId),
              eq(counterparties.legalEntityId, legalEntityId),
              inArray(counterparties.counterpartyId, resourceIds),
            ),
          )
          .pipe(Effect.mapError(persistenceUnavailable));
        if (new Set(existing.map(({ counterpartyId }) => counterpartyId)).size === new Set(resourceIds).size) {
          yield* transaction
            .update(counterparties)
            .set({ archivedAt: now, updatedAt: now })
            .where(
              and(
                eq(counterparties.tenantId, scope.tenantId),
                eq(counterparties.legalEntityId, legalEntityId),
                inArray(counterparties.counterpartyId, resourceIds),
              ),
            )
            .pipe(Effect.mapError(persistenceUnavailable));
          outcome = makeOutcome({
            handoff,
            includedResourceRefs: handoff.resourceRefs,
            now,
            reason: 'Every scoped Counterparty is archived and unavailable for active commercial use',
            remainingResourceRefs: [],
            status: 'SUCCEEDED',
          });
        } else {
          outcome = makeOutcome({
            handoff,
            includedResourceRefs: [],
            now,
            reason: 'At least one scoped Counterparty could not be authoritatively resolved',
            remainingResourceRefs: handoff.resourceRefs,
            status: 'INDETERMINATE',
          });
        }
      }

      yield* transaction
        .insert(privacyMeasureExecutions)
        .values({
          actionInvocationId,
          actorPrincipalId: scope.principalId,
          handoff,
          handoffFingerprint: fingerprint,
          idempotencyKey: handoff.idempotencyKey,
          legalEntityId,
          measureId: handoff.measureId,
          occurredAt: now,
          outcome,
          outcomeId: outcome.outcomeId,
          owningCapability: OWNER,
          sourceDecisionRef: handoff.sourceDecisionRef,
          sourceDecisionRevision: handoff.sourceDecisionRevision,
          taskId: handoff.taskId,
          tenantId: scope.tenantId,
        })
        .pipe(Effect.mapError(persistenceUnavailable));
      return outcome;
    },
  );
  return Effect.succeed({ execute, load });
};
