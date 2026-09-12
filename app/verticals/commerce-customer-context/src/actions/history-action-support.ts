import type { ActionHandlerContext, OperationalScope } from '@app/core-runtime';
import { DateTime, Effect, Option } from 'effect';
import type {
  RepeatCounterpartyOrderPayload,
  RepeatOrderActionResult,
  RepeatRetailOrderPayload,
} from '../../shared/domain/history-action-contracts.ts';
import {
  HistoryActionUnavailable,
  RepeatOrderConflict,
  RepeatOrderNoRepeatableLines,
} from '../../shared/domain/history-action-errors.ts';
import type { HistoryActionOwnerPorts } from '../../shared/domain/history-action-ports.ts';
import {
  repeatCartResult,
  RepeatCartOwner,
  unavailableHistoryActionOwnerPorts,
} from '../../shared/domain/history-action-ports.ts';
import type { HistoryOwnerUnavailable } from '../../shared/domain/history-errors.ts';
import { prepareRepeatOrder } from '../../shared/domain/history-composition.ts';
import type { RepeatOrderPreparationResult } from '../../shared/domain/history-contracts.ts';
import type { CustomerHistoryPorts } from '../../shared/domain/history-ports.ts';
import { CustomerHistoryPortsService, unavailableCustomerHistoryPorts } from '../../shared/domain/history-ports.ts';
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

type RepeatOrderSubject = RepeatCounterpartyOrderPayload['profileRef'] | RepeatRetailOrderPayload['profileRef'];
type RepeatCartCreation = Effect.Success<ReturnType<HistoryActionOwnerPorts['carts']['createFromHistoricalIntent']>>;
type CreatedRepeatCart = Exclude<RepeatCartCreation, { readonly outcome: 'CONFLICT' }>;

/** Production service loader; the API host provides live or explicit fail-closed owner Layers. */
export const loadHistoryActionServices = Effect.fn('HistoryActions.loadHistoryActionServices')(function* loadServices(
  transaction: ProfileScopedRoutineInvoker,
  scope: OperationalScope,
) {
  const history = yield* Effect.serviceOption(CustomerHistoryPortsService);
  const carts = yield* Effect.serviceOption(RepeatCartOwner);
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
    },
  } satisfies HistoryActionServices;
});

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

const recordRepeatEvidence = Effect.fn('HistoryActionSupport.recordRepeatEvidence')(function* recordEvidence(
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
});

const hasRepeatableLines = (prepared: RepeatOrderPreparationResult): boolean =>
  prepared.outcome !== 'NO_REPEATABLE_LINES' && prepared.lines.some((line) => line.status === 'REPEATABLE');

const repeatCartCreationInput = (
  prepared: RepeatOrderPreparationResult,
  storefrontId: string | undefined,
  subject: RepeatOrderSubject,
  actionInvocationId: string,
) => {
  const input = {
    actionInvocationId,
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
  return storefrontId === undefined ? input : { ...input, storefrontId };
};

const hasTrustedRepeatCartRef = (
  created: CreatedRepeatCart,
  prepared: RepeatOrderPreparationResult,
  subject: RepeatOrderSubject,
  tenantId: string,
): boolean =>
  created.cartRef.tenantId === tenantId &&
  created.cartRef.tenantId === prepared.sourceOrderRef.tenantId &&
  created.cartRef.tenantId === subject.tenantId &&
  created.cartRef.moduleId === cartModuleKey &&
  created.cartRef.resourceType === cartResourceType;

const hasCompleteRepeatCartLines = (created: CreatedRepeatCart, prepared: RepeatOrderPreparationResult): boolean => {
  const expectedLineRefs = prepared.lines.map((line) => line.sourceLineRef).toSorted();
  const actualLineRefs = created.lines.map((line) => line.sourceLineRef).toSorted();
  return (
    actualLineRefs.length === expectedLineRefs.length &&
    actualLineRefs.every((lineRef, index) => lineRef === expectedLineRefs[index]) &&
    new Set(actualLineRefs).size === actualLineRefs.length
  );
};

const createRepeatCart = Effect.fn('HistoryActions.createRepeatCart')(function* create(
  prepared: RepeatOrderPreparationResult,
  storefrontId: string | undefined,
  subject: RepeatOrderSubject,
  context: ActionHandlerContext<NoDomainEvents, HistoryActionServices>,
) {
  if (!hasRepeatableLines(prepared)) {
    return yield* new RepeatOrderNoRepeatableLines({
      code: 'repeat_order_no_repeatable_lines',
      reason: 'Current Cart and Catalog rules rejected every historical line',
    });
  }
  const created = yield* context.services.owners.carts.createFromHistoricalIntent(
    repeatCartCreationInput(prepared, storefrontId, subject, context.actionInvocationId),
  );
  if (created.outcome === 'CONFLICT') {
    return yield* new RepeatOrderConflict({
      code: 'repeat_order_conflict',
      reason: 'The idempotency key is already bound to different repeat intent',
    });
  }
  if (!hasTrustedRepeatCartRef(created, prepared, subject, context.scope.tenantId)) {
    return yield* new HistoryActionUnavailable({
      code: 'history_action_unavailable',
      ownerModuleId: cartModuleKey,
      reason: 'Cart owner returned a ResourceRef outside the trusted Cart and Tenant binding',
    });
  }
  if (!hasCompleteRepeatCartLines(created, prepared)) {
    return yield* new HistoryActionUnavailable({
      code: 'history_action_unavailable',
      ownerModuleId: cartModuleKey,
      reason: 'Cart owner did not return one outcome for every historical source line',
    });
  }
  return repeatCartResult(prepared.sourceOrderRef, created);
});

export const handleRepeatRetailOrder = Effect.fn('HistoryActions.handleRepeatRetailOrder')(function* repeatRetail(
  payload: RepeatRetailOrderPayload,
  context: ActionHandlerContext<NoDomainEvents, HistoryActionServices>,
) {
  yield* assertTrustedTenant(context.scope.tenantId, [payload.profileRef, payload.sourceOrderRef]);
  const now = yield* context.services.now;
  const prepared = yield* prepareRepeatOrder(context.services.history, {
    now,
    orderRef: payload.sourceOrderRef,
    principalId: context.scope.principalId,
    subject: { kind: 'RETAIL_PROFILE', profileRef: payload.profileRef },
  }).pipe(Effect.catchTag('HistoryOwnerUnavailable', (error) => Effect.fail(ownerUnavailable(error))));
  const result = yield* createRepeatCart(prepared, undefined, payload.profileRef, context);
  yield* recordRepeatEvidence(context, { actionKind: 'REPEAT_RETAIL_ORDER', result });
  return result;
});

export const handleRepeatCounterpartyOrder = Effect.fn('HistoryActions.handleRepeatCounterpartyOrder')(
  function* repeatCounterparty(
    payload: RepeatCounterpartyOrderPayload,
    context: ActionHandlerContext<NoDomainEvents, HistoryActionServices>,
  ) {
    yield* assertTrustedTenant(context.scope.tenantId, [
      payload.counterpartyRef,
      payload.profileRef,
      payload.sourceOrderRef,
    ]);
    if (context.scope.trustedStorefrontId === undefined || context.scope.trustedStorefrontId !== payload.storefrontId) {
      return yield* new RepeatOrderConflict({
        code: 'repeat_order_conflict',
        reason: 'The requested Storefront does not match trusted gateway scope',
      });
    }
    const association = yield* context.services.history.counterpartyProfiles
      .current({ counterpartyRef: payload.counterpartyRef, profileRef: payload.profileRef })
      .pipe(Effect.catchTag('HistoryOwnerUnavailable', (error) => Effect.fail(ownerUnavailable(error))));
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
    }).pipe(Effect.catchTag('HistoryOwnerUnavailable', (error) => Effect.fail(ownerUnavailable(error))));
    const result = yield* createRepeatCart(prepared, payload.storefrontId, payload.profileRef, context);
    yield* recordRepeatEvidence(context, { actionKind: 'REPEAT_COUNTERPARTY_ORDER', result });
    return result;
  },
);
