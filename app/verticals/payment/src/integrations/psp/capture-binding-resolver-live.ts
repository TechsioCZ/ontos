import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { Effect, Option } from 'effect';

import { pspBindingPersistenceForTransaction } from '../../persistence/psp-binding-persistence.ts';
import type { ProviderAccountBindingTargetRecord } from '../../persistence/psp-binding-persistence.ts';
import { executionTargetOf, gatewayBindingUnavailable } from './binding-resolver-live.ts';
import type { GatewayCaptureBindingResolverContract, GatewayCaptureTargetQuery } from './capture-binding-resolver.ts';

/**
 * Action-side `GatewayCaptureBindingResolver` (#1155, #1157) for `capture-provider-notification`, over that
 * Action's own Core-scoped transaction. Same rules as the worker's `resolveForNotification`: the exact binding
 * with this ref in this environment, Current or retired, with its current credential revision; no Current
 * substitute. None when no binding of the route's family has this ref in this scope and environment
 * (BINDING_UNKNOWN).
 */

const targetOf = (record: ProviderAccountBindingTargetRecord, query: GatewayCaptureTargetQuery) =>
  executionTargetOf(
    {
      bindingId: record.binding.view.bindingId,
      credentialRevision: record.credential.credentialRevision,
      credentialSecretRef: record.credentialSecretRef,
      credentialStatus: record.credential.status,
      environment: record.binding.view.environment,
      merchantIdentity: record.binding.view.merchantIdentity,
      notificationUrl: record.binding.notificationUrl,
      providerAccountRef: record.binding.view.providerAccountRef,
      providerFamily: record.binding.view.providerFamily,
      returnUrl: Option.none(),
    },
    query.scope,
  );

/**
 * The resolver for one Action transaction. The query scope must be the transaction's own verified scope; a
 * different scope (a caller bug) and an unreadable binding table are UNAVAILABLE for the route's family, so
 * the Action never commits a capture against an unverified binding.
 */
export const gatewayCaptureBindingResolverForTransaction = (
  transaction: ScopedTransactionExecutor,
): GatewayCaptureBindingResolverContract => {
  const persistence = pspBindingPersistenceForTransaction(transaction);
  const resolveForCapture = Effect.fn('GatewayCaptureBindingResolver.resolveForCapture')(function* resolveForCapture(
    query: GatewayCaptureTargetQuery,
  ) {
    if (
      transaction.scope.tenantId !== query.scope.tenantId ||
      transaction.scope.legalEntityId !== query.scope.legalEntityId
    ) {
      return yield* gatewayBindingUnavailable(query.providerFamily, 'scope_mismatch');
    }
    const record = yield* persistence
      .readBindingTarget({ environment: query.environment, providerAccountRef: query.providerAccountRef })
      .pipe(
        Effect.catchTag('PaymentUnavailable', () =>
          Effect.fail(gatewayBindingUnavailable(query.providerFamily, 'binding_read_failed')),
        ),
      );
    if (Option.isNone(record) || record.value.binding.view.providerFamily !== query.providerFamily) {
      return Option.none();
    }
    return Option.some(yield* targetOf(record.value, query));
  });
  return Object.freeze({ resolveForCapture });
};
