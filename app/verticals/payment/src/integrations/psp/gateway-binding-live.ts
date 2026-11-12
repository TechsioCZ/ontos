import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';

import { PaymentGatewayAccountBindingSchema } from '../../../shared/domain/payment-execution-binding.ts';
import type { PaymentGatewayAccountBinding } from '../../../shared/domain/payment-execution-binding.ts';
import { PAYMENT_GATEWAY_PROVIDER_FAMILIES } from '../../../shared/domain/payment-vocabulary.ts';
import type { PaymentGatewayProviderFamilySchema } from '../../../shared/domain/payment-vocabulary.ts';
import { pspEnablementPersistenceForTransaction } from '../../persistence/psp-enablement-persistence.ts';
import type { PspGatewayEnablementRecord } from '../../persistence/psp-enablement-persistence.ts';
import { ownerEvidenceUnavailable } from '../../ports/owner-evidence-unavailable.ts';
import type { PaymentOwnerScope } from '../../ports/owner-evidence-unavailable.ts';
import type {
  PaymentGatewayBindingService,
  PaymentGatewayBindingVerification,
} from '../../ports/gateway-binding-port.ts';

/**
 * Live C16 `GatewayBindingPort` (#1155, #1156) over Payment's own Current Gateway Enablement, read in a
 * Core-owned scoped transaction. A binding is offered or verified only when its family's enablement in
 * this Customer Configuration is enabled, names exactly that binding (family, `pab_` ref, environment)
 * and the binding is Current. Each family's enablement is its own row, so one provider's state never
 * gates another's. A read failure is `PaymentOwnerEvidenceUnavailable`, never an empty list or
 * NOT_ENABLED; nothing here selects, substitutes or falls back to another binding.
 */

type PaymentGatewayProviderFamily = typeof PaymentGatewayProviderFamilySchema.Type;

const unavailable = (reason: string) => ownerEvidenceUnavailable('GATEWAY_BINDING', reason);
/** The driver/decode cause travels as the non-enumerable native `cause`, never in the public payload. */
const unavailableBecause = (reason: string, cause: unknown) =>
  Object.defineProperty(unavailable(reason), 'cause', { configurable: true, value: cause });
const decodeGatewayBinding = Schema.decodeUnknownEffect(PaymentGatewayAccountBindingSchema);

/** The C16 execution binding of one enablement row's binding. */
const executionBindingOf = (record: PspGatewayEnablementRecord) =>
  decodeGatewayBinding({
    _tag: 'GATEWAY_ACCOUNT',
    environment: record.binding.environment,
    providerAccountRef: record.binding.providerAccountRef,
    providerFamily: record.binding.providerFamily,
  }).pipe(Effect.mapError((failure) => unavailableBecause('A Gateway Enablement binding is unreadable', failure)));

/** Offered for new Payment intents: enabled, and its binding is Current. */
const isOffered = (record: PspGatewayEnablementRecord) => record.enabled && record.binding.status === 'CURRENT';

/**
 * ENABLED exactly when the selected binding equals the offered binding of its family: same family,
 * same account ref, same environment. Anything else, including no enablement row, is NOT_ENABLED.
 */
export const verifiedGatewayBinding = (
  selected: PaymentGatewayAccountBinding,
  enablements: readonly PspGatewayEnablementRecord[],
): PaymentGatewayBindingVerification => {
  const enabled = enablements.some(
    (record) =>
      isOffered(record) &&
      record.binding.providerFamily === selected.providerFamily &&
      record.binding.providerAccountRef === selected.providerAccountRef &&
      record.binding.environment === selected.environment,
  );
  return enabled ? { _tag: 'ENABLED', binding: selected } : { _tag: 'NOT_ENABLED', binding: selected };
};

/**
 * The port over one scoped transaction. The caller's scope must be the transaction's own Core-verified
 * scope; any other scope is refused as unavailable rather than read under the wrong Tenant or Legal Entity.
 */
export const gatewayBindingServiceForTransaction = (
  transaction: ScopedTransactionExecutor,
): PaymentGatewayBindingService => {
  const persistence = pspEnablementPersistenceForTransaction(transaction);

  /** `providerFamily` narrows the read to one family, so another family's row is never even read. */
  const currentEnablements = (input: {
    readonly customerConfigurationId: string;
    readonly providerFamily: Option.Option<PaymentGatewayProviderFamily>;
    readonly scope: PaymentOwnerScope;
  }) =>
    input.scope.tenantId === transaction.scope.tenantId && input.scope.legalEntityId === transaction.scope.legalEntityId
      ? persistence
          .listEnablements({
            customerConfigurationId: Option.some(input.customerConfigurationId),
            // At most one Current row per family (unique per Customer Configuration and family).
            limit: PAYMENT_GATEWAY_PROVIDER_FAMILIES.length,
            providerFamily: input.providerFamily,
          })
          .pipe(Effect.mapError((failure) => unavailableBecause('Gateway Enablement could not be read', failure)))
      : Effect.fail(unavailable('The requested scope is not the verified scope of this transaction'));

  const listEnabledBindings: PaymentGatewayBindingService['listEnabledBindings'] = (input) =>
    currentEnablements({ ...input, providerFamily: Option.none() }).pipe(
      Effect.flatMap((records) => Effect.forEach(records.filter(isOffered), executionBindingOf, { concurrency: 1 })),
    );

  const verifySelectedBinding: PaymentGatewayBindingService['verifySelectedBinding'] = (input) =>
    currentEnablements({ ...input, providerFamily: Option.some(input.binding.providerFamily) }).pipe(
      Effect.map((records) => verifiedGatewayBinding(input.binding, records)),
    );

  return Object.freeze({ listEnabledBindings, verifySelectedBinding });
};
