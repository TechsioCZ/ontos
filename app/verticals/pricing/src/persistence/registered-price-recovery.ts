import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { ReadHandlerUnavailable, ReadPermissionDenied } from '@app/core-runtime';
import { readScopedOriginalActionInvocation } from '@app/core-runtime/access/enforcement';
import {
  readVerifiedGatewayRecovery,
  readVerifiedGatewayWorkload,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import type { RegisteredGatewayRecovery } from '@app/core-runtime/auth/system-principal-context-provenance';
import { Effect, Option, Schema } from 'effect';
import type { PriceResultLookupRequest } from '../../shared/apis/price-result-lookup.ts';
import type { PriceActionResultRecoveryServices } from '../api/price-result-lookup.read.ts';
import {
  lookupPriceActionResultRoutine,
  PriceActionResultLookupOutcomeSchema,
  PricePersistenceUnavailable,
} from '../services/price-persistence.service.ts';

type Transaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
const originalPriceAction = (actionKey: string) =>
  actionKey === 'commerce.pricing.define-price' || actionKey === 'commerce.pricing.revise-price';
const denied = () =>
  new ReadPermissionDenied({
    code: 'read_permission_denied',
    reason: 'The original Pricing receipt is outside the signed recovery scope',
  });
const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'Original Pricing receipt authority cannot be verified',
    }),
    'cause',
    { value: cause },
  );
const persistenceUnavailable = (cause?: unknown) =>
  Object.defineProperty(
    new PricePersistenceUnavailable({ reason: 'Original Pricing receipt cannot be read safely' }),
    'cause',
    { value: cause },
  );

/** This check consumes only verified redeemed provenance; request fields never construct it. */
export const assertPriceSourceRecovery = (
  input: PriceResultLookupRequest,
  scope: OperationalScope,
): Effect.Effect<boolean, ReadPermissionDenied> => {
  const recovery = readVerifiedGatewayRecovery(scope);
  if (recovery === undefined) {
    return scope.authMethod === 'system' ||
      scope.authMethod === 'api_key' ||
      readVerifiedGatewayWorkload(scope) !== undefined
      ? Effect.fail(denied())
      : Effect.succeed(true);
  }
  return recovery.originalActionInvocationId === input.actionInvocationId &&
    originalPriceAction(recovery.originalActionKey)
    ? Effect.succeed(true)
    : Effect.fail(denied());
};

/** Historical proof and native writer selection stay inside the already-authorized Read transaction. */
export const registeredPriceRecoveryServices = (
  transaction: Transaction,
  recovery: RegisteredGatewayRecovery,
): PriceActionResultRecoveryServices => {
  const exactInput = (actionInvocationId: string) =>
    actionInvocationId === recovery.originalActionInvocationId && originalPriceAction(recovery.originalActionKey);
  const verifyOriginal = Effect.fn('RegisteredPriceRecovery.verifyOriginal')(function* verifyOriginal(
    actionInvocationId: string,
  ) {
    if (!exactInput(actionInvocationId)) {
      return false;
    }
    const original = yield* readScopedOriginalActionInvocation(transaction, {
      actionKey: recovery.originalActionKey,
      authContextRef: recovery.originalAuthContextRef,
      idempotencyKey: recovery.originalIdempotencyKey,
      originalPrincipalId: recovery.originalPrincipalId,
      requestHash: recovery.originalRequestHash,
    }).pipe(Effect.mapError(unavailable));
    return (
      Option.isSome(original) &&
      original.value.actionInvocationId === recovery.originalActionInvocationId &&
      original.value.status === 'succeeded'
    );
  });
  return {
    lookupResult: Effect.fn('RegisteredPriceRecovery.lookupResult')(function* lookupResult(
      input: PriceResultLookupRequest,
    ) {
      const verified = yield* verifyOriginal(input.actionInvocationId).pipe(Effect.mapError(persistenceUnavailable));
      if (!verified) {
        return yield* persistenceUnavailable();
      }
      const rows = yield* transaction
        .invoke(lookupPriceActionResultRoutine, [
          {
            actingPrincipalId: recovery.originalPrincipalId,
            actionInvocationId: recovery.originalActionInvocationId,
            expectedActionKind:
              recovery.originalActionKey === 'commerce.pricing.define-price' ? 'DEFINE_PRICE' : 'REVISE_PRICE',
          },
        ])
        .pipe(Effect.mapError(persistenceUnavailable));
      if (rows.length !== 1) {
        return yield* persistenceUnavailable();
      }
      const result = yield* Schema.decodeUnknownEffect(PriceActionResultLookupOutcomeSchema)(rows[0]?.payload).pipe(
        Effect.mapError(persistenceUnavailable),
      );
      if (result.actionInvocationId !== recovery.originalActionInvocationId) {
        return yield* persistenceUnavailable();
      }
      return result;
    }),
    resolveCommit: Effect.fn('RegisteredPriceRecovery.resolveCommit')(function* resolveCommit(
      actionInvocationId: string,
    ) {
      return (yield* verifyOriginal(actionInvocationId)) ? ('COMMITTED' as const) : ('UNAVAILABLE' as const);
    }),
  };
};
