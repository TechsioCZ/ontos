import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';

import { PaymentGatewayAccountBindingSchema } from '../../../shared/domain/payment-execution-binding.ts';
import type { PaymentGatewayAccountBinding } from '../../../shared/domain/payment-execution-binding.ts';
import { PAYMENT_GATEWAY_PROVIDER_FAMILIES } from '../../../shared/domain/payment-vocabulary.ts';
import { GatewayProviderAccountRefSchema } from '../../../shared/domain/psp-configuration.ts';
import { GatewayEnvironmentSchema } from '../../../shared/domain/psp-vocabulary.ts';
import type { PaymentGatewayProviderFamilySchema } from '../../../shared/domain/payment-vocabulary.ts';
import { pspEnablementPersistenceForTransaction } from '../../persistence/psp-enablement-persistence.ts';
import type { PspGatewayEnablementRecord } from '../../persistence/psp-enablement-persistence.ts';
import { ownerEvidenceUnavailable } from '../../ports/owner-evidence-unavailable.ts';
import type { PaymentOwnerScope } from '../../ports/owner-evidence-unavailable.ts';
import type {
  PaymentGatewayBindingEvidence,
  PaymentGatewayBindingVerification,
} from '../../ports/gateway-binding-port.ts';

/**
 * Live C16 `GatewayBindingPort` (#1155, #1156) over Payment's own Current Gateway Enablement, read in a
 * Core-owned scoped transaction. For a new Payment intent a binding is offered or verified only when its
 * family's enablement in this Customer Configuration is enabled, names exactly that binding (family, `pab_`
 * ref, environment) and the binding is Current. An existing Payment's original binding is resolved by its
 * stable ref alone, Current or retired: disablement and replacement affect new intents only. Each family's
 * enablement is its own row, so one provider's state never gates another's. A read failure is
 * `PaymentOwnerEvidenceUnavailable`, never an empty list or NOT_ENABLED; nothing here selects, substitutes or
 * falls back to another binding.
 */

type PaymentGatewayProviderFamily = typeof PaymentGatewayProviderFamilySchema.Type;

const unavailable = (reason: string) => ownerEvidenceUnavailable('GATEWAY_BINDING', reason);
/** The driver/decode cause travels as the non-enumerable native `cause`, never in the public payload. */
const unavailableBecause = (reason: string, cause: unknown) =>
  Object.defineProperty(unavailable(reason), 'cause', { configurable: true, value: cause });
const scopeMismatch = () => unavailable('The requested scope is not the verified scope of this transaction');
const decodeGatewayBinding = Schema.decodeUnknownEffect(PaymentGatewayAccountBindingSchema);

/** The C16 execution binding of one stored binding. */
const executionBindingOf = (record: Pick<PspGatewayEnablementRecord, 'binding'>) =>
  decodeGatewayBinding({
    _tag: 'GATEWAY_ACCOUNT',
    environment: record.binding.environment,
    providerAccountRef: record.binding.providerAccountRef,
    providerFamily: record.binding.providerFamily,
  }).pipe(Effect.mapError((failure) => unavailableBecause('A Gateway Enablement binding is unreadable', failure)));

const decodeStoredBindingKey = Schema.decodeUnknownOption(
  Schema.Struct({ environment: GatewayEnvironmentSchema, providerAccountRef: GatewayProviderAccountRefSchema }),
);
/** The stored-binding lookup key of a Payment's binding; `None` when it cannot name a stored binding. */
const storedBindingKey = (binding: PaymentGatewayAccountBinding) =>
  decodeStoredBindingKey({ environment: binding.environment, providerAccountRef: binding.providerAccountRef });

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
): PaymentGatewayBindingEvidence => {
  const persistence = pspEnablementPersistenceForTransaction(transaction);
  const inTransactionScope = (scope: PaymentOwnerScope) =>
    scope.tenantId === transaction.scope.tenantId && scope.legalEntityId === transaction.scope.legalEntityId;

  /** `providerFamily` narrows the read to one family, so another family's row is never even read. */
  const currentEnablements = (input: {
    readonly customerConfigurationId: string;
    readonly providerFamily: Option.Option<PaymentGatewayProviderFamily>;
    readonly scope: PaymentOwnerScope;
  }) =>
    inTransactionScope(input.scope)
      ? persistence
          .listEnablements({
            customerConfigurationId: Option.some(input.customerConfigurationId),
            // At most one Current row per family (unique per Customer Configuration and family).
            limit: PAYMENT_GATEWAY_PROVIDER_FAMILIES.length,
            providerFamily: input.providerFamily,
          })
          .pipe(Effect.mapError((failure) => unavailableBecause('Gateway Enablement could not be read', failure)))
      : Effect.fail(scopeMismatch());

  const listEnabledBindings: PaymentGatewayBindingEvidence['listEnabledBindings'] = (input) =>
    currentEnablements({ ...input, providerFamily: Option.none() }).pipe(
      Effect.flatMap((records) => Effect.forEach(records.filter(isOffered), executionBindingOf, { concurrency: 1 })),
    );

  const verifySelectedBinding: PaymentGatewayBindingEvidence['verifySelectedBinding'] = (input) =>
    currentEnablements({ ...input, providerFamily: Option.some(input.binding.providerFamily) }).pipe(
      Effect.map((records) => verifiedGatewayBinding(input.binding, records)),
    );

  /**
   * The exact stored binding of an existing Payment, Current or retired, independent of Gateway Enablement.
   * A ref or environment outside the gateway vocabulary, or a stored binding of another family, is `None`.
   */
  const resolveOriginalBinding: PaymentGatewayBindingEvidence['resolveOriginalBinding'] = (input) =>
    inTransactionScope(input.scope)
      ? Option.match(storedBindingKey(input.binding), {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (key) =>
            persistence.lockBinding(key).pipe(
              Effect.mapError((failure) =>
                unavailableBecause('The original gateway binding could not be read', failure),
              ),
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.succeed(Option.none()),
                  onSome: (stored) =>
                    stored.providerFamily === input.binding.providerFamily
                      ? executionBindingOf({ binding: stored }).pipe(Effect.map(Option.some))
                      : Effect.succeed(Option.none()),
                }),
              ),
            ),
        })
      : Effect.fail(scopeMismatch());

  return Object.freeze({ listEnabledBindings, resolveOriginalBinding, verifySelectedBinding });
};
