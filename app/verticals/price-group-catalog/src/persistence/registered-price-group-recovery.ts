import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { ReadHandlerUnavailable, ReadPermissionDenied } from '@app/core-runtime';
import { readScopedOriginalActionInvocation } from '@app/core-runtime/access/enforcement';
import {
  readVerifiedGatewayRecovery,
  readVerifiedGatewayWorkload,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { Effect, Option } from 'effect';
import type { PriceGroupResultLookupRequest } from '../../shared/apis/price-group-result-lookup.ts';
import { priceGroupSourcePersistenceForScope } from './price-group-source-persistence.ts';

type Transaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
const originalGroupAction = (key: string) =>
  key === 'pricing.price-group-catalog.create-price-group' ||
  key === 'pricing.price-group-catalog.create-price-group-definition-revision';
const denied = () =>
  new ReadPermissionDenied({
    code: 'read_permission_denied',
    reason: 'The original Price Group receipt is outside the signed recovery scope',
  });
const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'Original Price Group receipt authority cannot be verified',
    }),
    'cause',
    { value: cause },
  );

export const priceGroupReceiptServicesForScope = Effect.fn(
  'RegisteredPriceGroupRecovery.priceGroupReceiptServicesForScope',
)(function* priceGroupReceiptServices(transaction: Transaction, scope: OperationalScope) {
  const persistence = yield* priceGroupSourcePersistenceForScope(transaction, scope);
  return {
    recover: Effect.fn('RegisteredPriceGroupRecovery.recover')(function* recover(input: PriceGroupResultLookupRequest) {
      const recovery = readVerifiedGatewayRecovery(scope);
      if (recovery === undefined) {
        if (
          scope.authMethod === 'system' ||
          scope.authMethod === 'api_key' ||
          readVerifiedGatewayWorkload(scope) !== undefined
        ) {
          return yield* denied();
        }
        return yield* persistence.recover(input);
      }
      if (
        recovery.originalActionInvocationId !== input.actionInvocationId ||
        !originalGroupAction(recovery.originalActionKey)
      ) {
        return yield* denied();
      }
      const original = yield* readScopedOriginalActionInvocation(transaction, {
        actionKey: recovery.originalActionKey,
        authContextRef: recovery.originalAuthContextRef,
        idempotencyKey: recovery.originalIdempotencyKey,
        originalPrincipalId: recovery.originalPrincipalId,
        requestHash: recovery.originalRequestHash,
      }).pipe(Effect.mapError(unavailable));
      if (
        Option.isNone(original) ||
        original.value.actionInvocationId !== recovery.originalActionInvocationId ||
        original.value.status !== 'succeeded'
      ) {
        return yield* unavailable();
      }
      const result = yield* persistence.recover(
        { actionInvocationId: recovery.originalActionInvocationId },
        recovery.originalPrincipalId,
      );
      if (result.outcome !== 'PRICE_GROUP_OPERATION_FOUND') {
        return yield* unavailable();
      }
      const expectedKind =
        recovery.originalActionKey === 'pricing.price-group-catalog.create-price-group'
          ? 'CREATE_PRICE_GROUP'
          : 'CREATE_DEFINITION_REVISION';
      if (result.receipt.operationKind !== expectedKind) {
        return yield* unavailable();
      }
      return result;
    }),
  };
});
