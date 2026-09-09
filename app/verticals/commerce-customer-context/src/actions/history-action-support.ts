import type { ActionHandlerContext, OperationalScope } from '@app/core-runtime';
import { commitActionThenReject } from '@app/core-runtime';
import { DateTime, Effect, Option } from 'effect';
import type {
  ClaimGuestOrderPayload,
  RepeatCounterpartyOrderPayload,
  RepeatOrderActionResult,
  RepeatRetailOrderPayload,
} from '../../shared/domain/history-action-contracts.ts';
import {
  GuestOrderClaimConflict,
  GuestOrderClaimRateLimited,
  GuestOrderClaimRejected,
  HistoryActionUnavailable,
  RepeatOrderConflict,
  RepeatOrderNoRepeatableLines,
} from '../../shared/domain/history-action-errors.ts';
import type { HistoryActionOwnerPorts } from '../../shared/domain/history-action-ports.ts';
import {
  GuestOrderClaimOwner,
  repeatCartResult,
  RepeatCartOwner,
  unavailableHistoryActionOwnerPorts,
} from '../../shared/domain/history-action-ports.ts';
import type {
  HistoryAccessDenied,
  HistoryOwnerUnavailable,
} from '../../shared/domain/history-errors.ts';
import {
  preflightGuestOrderClaim,
  prepareRepeatOrder,
} from '../../shared/domain/history-composition.ts';
import type { RepeatOrderPreparationResult } from '../../shared/domain/history-contracts.ts';
import type { CustomerHistoryPorts } from '../../shared/domain/history-ports.ts';
import {
  CustomerHistoryPortsService,
  unavailableCustomerHistoryPorts,
} from '../../shared/domain/history-ports.ts';
import { customerHistoryPortsForOperation } from '../history-production-services.ts';
import type { ProfileScopedRoutineInvoker } from '../persistence/profile-persistence.ts';

type NoDomainEvents = Readonly<Record<never, never>>;
const moduleKey = 'commerce.customer-context' as const;
const cartModuleKey = 'commerce.cart' as const;
const cartResourceType = 'commerce.cart.cart' as const;

export interface HistoryActionServices {
  readonly history: CustomerHistoryPorts;
  readonly now: Effect.Effect<string>;
  readonly owners: HistoryActionOwnerPorts;
}

/** Production service loader; the API host provides live or explicit fail-closed owner Layers. */
export const loadHistoryActionServices = Effect.fn('HistoryActions.loadHistoryActionServices')(
  function* loadServices(transaction: ProfileScopedRoutineInvoker, scope: OperationalScope) {
    const history = yield* Effect.serviceOption(CustomerHistoryPortsService);
    const carts = yield* Effect.serviceOption(RepeatCartOwner);
    const guestOrders = yield* Effect.serviceOption(GuestOrderClaimOwner);
    const unavailableOwners = unavailableHistoryActionOwnerPorts();
    return {
      history: yield* customerHistoryPortsForOperation(
        Option.getOrElse(history, unavailableCustomerHistoryPorts),
        transaction,
        scope,
      ),
      now: DateTime.now.pipe(Effect.map(DateTime.formatIso)),
      owners: {
        carts: Option.getOrElse(carts, () => unavailableOwners.carts),
        guestOrders: Option.getOrElse(guestOrders, () => unavailableOwners.guestOrders),
      },
    } satisfies HistoryActionServices;
  },
);

const ownerUnavailable = (error: HistoryOwnerUnavailable) =>
  new HistoryActionUnavailable({
    code: 'history_action_unavailable',
    ownerModuleId: error.ownerModuleId,
    reason: 'A required historical record owner is temporarily unavailable',
  });

const assertTrustedTenant = (tenantId: string, refs: readonly { readonly tenantId: string }[]) => {
  if (refs.some((ref) => ref.tenantId !== tenantId)) {
    return new RepeatOrderConflict({
      code: 'repeat_order_conflict',
      reason: 'The source Order and customer context must belong to the trusted Tenant',
    });
  }
  return Effect.void;
};

const recordRepeatEvidence = Effect.fn('HistoryActionSupport.recordRepeatEvidence')(
  function* recordEvidence(
    context: ActionHandlerContext<NoDomainEvents, HistoryActionServices>,
    input: {
      readonly actionKind: 'REPEAT_COUNTERPARTY_ORDER' | 'REPEAT_RETAIL_ORDER';
      readonly result: RepeatOrderActionResult;
    },
  ) {
    yield* context.recordDataAccess({
      accessKind: 'read',
      queryHash: `repeat-source:${input.result.sourceOrderRef.moduleId}:${input.result.sourceOrderRef.resourceId}`,
      resultCount: 1,
      servingModuleKey: moduleKey,
      targetModuleKey: input.result.sourceOrderRef.moduleId,
      targetResourceId: input.result.sourceOrderRef.resourceId,
      targetResourceType: input.result.sourceOrderRef.resourceType,
    });
    yield* context.recordAuditEvidence({
      actionKind: input.actionKind,
      lineCount: input.result.lines.length,
      outcome: input.result.outcome,
      sourceOwnerModuleId: input.result.sourceOrderRef.moduleId,
      targetResourceId: input.result.cartRef.resourceId,
    });
  },
);

const createRepeatCart = Effect.fn('HistoryActions.createRepeatCart')(function* create(
  prepared: RepeatOrderPreparationResult,
  storefrontId: string | undefined,
  subject: RepeatCounterpartyOrderPayload['profileRef'] | RepeatRetailOrderPayload['profileRef'],
  context: ActionHandlerContext<NoDomainEvents, HistoryActionServices>,
) {
  const repeatableLines = prepared.lines.filter(
    (line): line is Extract<typeof line, { readonly status: 'REPEATABLE' }> =>
      line.status === 'REPEATABLE',
  );
  if (repeatableLines.length === 0 || prepared.outcome === 'NO_REPEATABLE_LINES') {
    return yield* new RepeatOrderNoRepeatableLines({
      code: 'repeat_order_no_repeatable_lines',
      reason: 'Current Cart and Catalog rules rejected every historical line',
    });
  }
  const createInput = {
    actionInvocationId: context.actionInvocationId,
    lines: prepared.lines,
    repeatIntentKey: [
      'repeat-order',
      prepared.sourceOrderRef.tenantId,
      prepared.sourceOrderRef.resourceId,
      subject.resourceId,
      storefrontId ?? 'retail',
    ].join(':'),
    sourceOrderRef: prepared.sourceOrderRef,
    subject,
  };
  const created = yield* context.services.owners.carts.createFromHistoricalIntent(
    storefrontId === undefined ? createInput : { ...createInput, storefrontId },
  );
  if (created.outcome === 'CONFLICT') {
    return yield* new RepeatOrderConflict({
      code: 'repeat_order_conflict',
      reason: 'The idempotency key is already bound to different repeat intent',
    });
  }
  if (
    created.cartRef.tenantId !== context.scope.tenantId ||
    created.cartRef.tenantId !== prepared.sourceOrderRef.tenantId ||
    created.cartRef.tenantId !== subject.tenantId ||
    created.cartRef.moduleId !== cartModuleKey ||
    created.cartRef.resourceType !== cartResourceType
  ) {
    return yield* new HistoryActionUnavailable({
      code: 'history_action_unavailable',
      ownerModuleId: cartModuleKey,
      reason: 'Cart owner returned a ResourceRef outside the trusted Cart and Tenant binding',
    });
  }
  const expectedLineRefs = prepared.lines.map((line) => line.sourceLineRef).toSorted();
  const actualLineRefs = created.lines.map((line) => line.sourceLineRef).toSorted();
  if (
    actualLineRefs.length !== expectedLineRefs.length ||
    actualLineRefs.some((lineRef, index) => lineRef !== expectedLineRefs[index]) ||
    new Set(actualLineRefs).size !== actualLineRefs.length
  ) {
    return yield* new HistoryActionUnavailable({
      code: 'history_action_unavailable',
      ownerModuleId: cartModuleKey,
      reason: 'Cart owner did not return one outcome for every historical source line',
    });
  }
  return repeatCartResult(prepared.sourceOrderRef, created);
});

export const handleRepeatRetailOrder = Effect.fn('HistoryActions.handleRepeatRetailOrder')(
  function* repeatRetail(
    payload: RepeatRetailOrderPayload,
    context: ActionHandlerContext<NoDomainEvents, HistoryActionServices>,
  ) {
    yield* assertTrustedTenant(context.scope.tenantId, [
      payload.profileRef,
      payload.sourceOrderRef,
    ]);
    const now = yield* context.services.now;
    const prepared = yield* prepareRepeatOrder(context.services.history, {
      now,
      orderRef: payload.sourceOrderRef,
      principalId: context.scope.principalId,
      subject: { kind: 'RETAIL_PROFILE', profileRef: payload.profileRef },
    }).pipe(
      Effect.catchTag('HistoryOwnerUnavailable', (error) => Effect.fail(ownerUnavailable(error))),
    );
    const result = yield* createRepeatCart(prepared, undefined, payload.profileRef, context);
    yield* recordRepeatEvidence(context, { actionKind: 'REPEAT_RETAIL_ORDER', result });
    return result;
  },
);

export const handleRepeatCounterpartyOrder = Effect.fn(
  'HistoryActions.handleRepeatCounterpartyOrder',
)(function* repeatCounterparty(
  payload: RepeatCounterpartyOrderPayload,
  context: ActionHandlerContext<NoDomainEvents, HistoryActionServices>,
) {
  yield* assertTrustedTenant(context.scope.tenantId, [
    payload.counterpartyRef,
    payload.profileRef,
    payload.sourceOrderRef,
  ]);
  if (
    context.scope.trustedStorefrontId === undefined ||
    context.scope.trustedStorefrontId !== payload.storefrontId
  ) {
    return yield* new RepeatOrderConflict({
      code: 'repeat_order_conflict',
      reason: 'The requested Storefront does not match trusted gateway scope',
    });
  }
  const association = yield* context.services.history.counterpartyProfiles
    .current({ counterpartyRef: payload.counterpartyRef, profileRef: payload.profileRef })
    .pipe(
      Effect.catchTag('HistoryOwnerUnavailable', (error) => Effect.fail(ownerUnavailable(error))),
    );
  if (association === 'INDETERMINATE') {
    return yield* new HistoryActionUnavailable({
      code: 'history_action_unavailable',
      ownerModuleId: 'commerce.customer-context',
      reason: 'The Counterparty purchasing-profile association is indeterminate',
    });
  }
  if (association === 'ABSENT') {
    return yield* new RepeatOrderConflict({
      code: 'repeat_order_conflict',
      reason: 'The Counterparty is not currently associated with the purchasing profile',
    });
  }
  const now = yield* context.services.now;
  const prepared = yield* prepareRepeatOrder(context.services.history, {
    now,
    orderRef: payload.sourceOrderRef,
    principalId: context.scope.principalId,
    subject: {
      counterpartyRef: payload.counterpartyRef,
      kind: 'COUNTERPARTY',
      profileRef: payload.profileRef,
    },
  }).pipe(
    Effect.catchTag('HistoryOwnerUnavailable', (error) => Effect.fail(ownerUnavailable(error))),
  );
  const result = yield* createRepeatCart(
    prepared,
    payload.storefrontId,
    payload.profileRef,
    context,
  );
  yield* recordRepeatEvidence(context, { actionKind: 'REPEAT_COUNTERPARTY_ORDER', result });
  return result;
});

const claimRejected = (reasonCode: GuestOrderClaimRejected['reasonCode']) =>
  new GuestOrderClaimRejected({
    code: 'guest_order_claim_rejected',
    reason: 'The Guest Order Claim did not satisfy the governed claim policy',
    reasonCode,
  });

const auditClaimOutcome = (
  payload: ClaimGuestOrderPayload,
  context: ActionHandlerContext<NoDomainEvents, HistoryActionServices>,
  outcome: string,
) =>
  context.recordAuditEvidence({
    actionKind: 'CLAIM_GUEST_ORDER',
    outcome,
    sourceOwnerModuleId: payload.orderRef.moduleId,
    targetResourceId: payload.orderRef.resourceId,
  });

const rejectClaim = Effect.fn('HistoryActions.rejectClaim')(function* reject(
  payload: ClaimGuestOrderPayload,
  context: ActionHandlerContext<NoDomainEvents, HistoryActionServices>,
  reasonCode: GuestOrderClaimRejected['reasonCode'],
) {
  yield* auditClaimOutcome(payload, context, `REJECTED_${reasonCode}`);
  let rejection: GuestOrderClaimConflict | GuestOrderClaimRateLimited | GuestOrderClaimRejected;
  if (reasonCode === 'CLAIM_CONFLICT') {
    rejection = new GuestOrderClaimConflict({
      code: 'guest_order_claim_conflict',
      reason: 'The verified Guest Order is already claimed by another customer context',
    });
  } else if (reasonCode === 'RATE_LIMITED') {
    rejection = new GuestOrderClaimRateLimited({
      code: 'guest_order_claim_rate_limited',
      reason: 'Guest Order Claim verification is rate limited',
    });
  } else {
    rejection = claimRejected(reasonCode);
  }
  // A denied claim is still a governed outcome.  Ask Core to flush the audit/data
  // evidence transaction before re-raising the typed rejection to the caller.
  return commitActionThenReject(rejection);
});

export const handleClaimGuestOrder = Effect.fn('HistoryActions.handleClaimGuestOrder')(
  function* claim(
    payload: ClaimGuestOrderPayload,
    context: ActionHandlerContext<NoDomainEvents, HistoryActionServices>,
  ) {
    if (
      payload.orderRef.tenantId !== context.scope.tenantId ||
      payload.profileRef.tenantId !== context.scope.tenantId
    ) {
      return yield* rejectClaim(payload, context, 'CLAIM_CONFLICT');
    }
    const now = yield* context.services.now;
    const handleAccessDenied = (error: HistoryAccessDenied) =>
      auditClaimOutcome(payload, context, `DENIED_${error.reason}`).pipe(
        Effect.as(commitActionThenReject(error)),
      );
    const handleOwnerUnavailable = (error: HistoryOwnerUnavailable) =>
      Effect.fail(ownerUnavailable(error));
    const preflight = yield* preflightGuestOrderClaim(context.services.history, {
      now,
      orderRef: payload.orderRef,
      principalId: context.scope.principalId,
      profileRef: payload.profileRef,
    }).pipe(
      Effect.map(() => null),
      Effect.catchTags({
        HistoryAccessDenied: handleAccessDenied,
        HistoryOwnerUnavailable: handleOwnerUnavailable,
      }),
    );
    if (preflight !== null) {
      return preflight;
    }
    const claimed = yield* context.services.owners.guestOrders.claim({
      ...payload,
      actionInvocationId: context.actionInvocationId,
      principalId: context.scope.principalId,
    });
    if (
      claimed.committedAttemptEvidenceRef.tenantId !== context.scope.tenantId ||
      claimed.committedAttemptEvidenceRef.moduleId !== payload.orderRef.moduleId
    ) {
      return yield* new HistoryActionUnavailable({
        code: 'history_action_unavailable',
        ownerModuleId: payload.orderRef.moduleId,
        reason: 'Order owner did not return a trusted committed claim-attempt receipt',
      });
    }
    if (claimed.outcome !== 'CLAIMED' && claimed.outcome !== 'ALREADY_CLAIMED_EQUIVALENT') {
      return yield* rejectClaim(payload, context, claimed.outcome);
    }
    const result = {
      orderRef: payload.orderRef,
      outcome: claimed.outcome,
      profileRef: payload.profileRef,
    } as const;
    yield* context.recordDataAccess({
      accessKind: 'read',
      queryHash: `guest-order-claim:${payload.orderRef.moduleId}:${payload.orderRef.resourceId}`,
      resultCount: 1,
      servingModuleKey: moduleKey,
      targetModuleKey: payload.orderRef.moduleId,
      targetResourceId: payload.orderRef.resourceId,
      targetResourceType: payload.orderRef.resourceType,
    });
    yield* context.recordAuditEvidence({
      actionKind: 'CLAIM_GUEST_ORDER',
      outcome: result.outcome,
      sourceOwnerModuleId: payload.orderRef.moduleId,
      targetResourceId: payload.orderRef.resourceId,
    });
    return result;
  },
);
