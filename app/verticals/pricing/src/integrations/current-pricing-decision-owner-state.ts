import {
  OperationContextUnavailable,
  PersistenceFailure,
  ReadHandlerExecutionError,
  ReadHandlerUnavailable,
} from '@app/core-runtime';
import type { OperationalScope, ReadOwnerTransaction, ScopedTransactionExecutor } from '@app/core-runtime';
import { Effect, Schema } from 'effect';

import type { CurrencySupportPersistence } from '../persistence/currency-support-persistence.ts';
import { currencySupportPersistenceForScope } from '../persistence/currency-support-persistence.ts';
import type { CommercialFeePersistence } from '../services/commercial-fee-persistence.service.ts';
import {
  CommercialFeePersistenceUnavailable,
  commercialFeePersistenceForScope,
} from '../services/commercial-fee-persistence.service.ts';
import type { ContractualDiscountPersistence } from '../services/contractual-discount-persistence.service.ts';
import {
  ContractualDiscountPersistenceUnavailable,
  contractualDiscountPersistenceForScope,
} from '../services/contractual-discount-persistence.service.ts';
import type {
  ExactPriceCandidateSetPersistence,
  ExactPriceLookupPersistence,
  PricePersistence,
} from '../services/price-persistence.service.ts';
import { PricePersistenceUnavailable, pricePersistenceForScope } from '../services/price-persistence.service.ts';
import type { QuantityTierPersistence } from '../services/quantity-tier-persistence.service.ts';
import {
  QuantityTierPersistenceUnavailable,
  quantityTierPersistenceForScope,
} from '../services/quantity-tier-persistence.service.ts';
import type { ZeroFloorAuthorizationPersistence } from '../services/zero-floor-authorization-persistence.service.ts';
import {
  ZeroFloorAuthorizationPersistenceUnavailable,
  zeroFloorAuthorizationPersistenceForScope,
} from '../services/zero-floor-authorization-persistence.service.ts';

/** The Pricing owner state a Current Pricing Decision evaluation reads: database only, never a remote owner. */
export interface CurrentPricingDecisionOwnerState {
  readonly currency: Pick<CurrencySupportPersistence, 'loadCurrent'>;
  readonly discount: Pick<ContractualDiscountPersistence, 'readCurrentSet'>;
  readonly fee: Pick<CommercialFeePersistence, 'readCurrentSet'>;
  readonly floor: Pick<ZeroFloorAuthorizationPersistence, 'readCurrentSet'>;
  readonly price: Pick<ExactPriceCandidateSetPersistence, 'readExactCandidateSet'> &
    Pick<ExactPriceLookupPersistence, 'exactLookup'> &
    Pick<PricePersistence, 'readSchedule'>;
  readonly tier: Pick<QuantityTierPersistence, 'readCurrentSet'>;
}

/** Owner state bound to one open transaction: an Action, whose whole handler runs inside its transaction. */
export const currentPricingDecisionOwnerStateInTransaction = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  compositionRevision: string,
): Effect.Effect<CurrentPricingDecisionOwnerState, OperationContextUnavailable> =>
  Effect.all(
    {
      currency: currencySupportPersistenceForScope(transaction, scope, compositionRevision),
      discount: contractualDiscountPersistenceForScope(transaction, scope),
      fee: commercialFeePersistenceForScope(transaction, scope),
      floor: zeroFloorAuthorizationPersistenceForScope(transaction, scope),
      price: pricePersistenceForScope(transaction, scope),
      tier: quantityTierPersistenceForScope(transaction, scope),
    },
    { concurrency: 6 },
  );

const shortTransactionReason = 'The short Pricing owner transaction could not be completed';

/** What Core's short owner transaction itself can fail with, apart from the owner port's own failures. */
const ShortTransactionFailureSchema = Schema.Union([
  OperationContextUnavailable,
  ReadHandlerExecutionError,
  ReadHandlerUnavailable,
]);
type ShortTransactionFailure = typeof ShortTransactionFailureSchema.Type;
const isShortTransactionFailure = Schema.is(ShortTransactionFailureSchema);

/** A short owner transaction that could not complete is the reading port's own unavailability. */
const asPortUnavailability =
  <Failure extends object>(make: (reason: string, cause: ShortTransactionFailure) => Failure) =>
  <Value, Own>(effect: Effect.Effect<Value, Own | ShortTransactionFailure>): Effect.Effect<Value, Own | Failure> =>
    Effect.mapError(effect, (failure) =>
      isShortTransactionFailure(failure) ? make(shortTransactionReason, failure) : failure,
    );
const withCause = <Failure extends object>(failure: Failure, cause: ShortTransactionFailure): Failure =>
  Object.defineProperty(failure, 'cause', { value: cause });

/**
 * Owner state for a Read's `finish`: every read opens its own short owner transaction, so the evaluation's remote
 * owner calls between reads never hold a pooled connection. A failed short transaction is the reading port's own
 * unavailability.
 */
export const currentPricingDecisionOwnerStatePerRead = (
  ownerTransaction: ReadOwnerTransaction,
  scope: OperationalScope,
  compositionRevision: string,
): CurrentPricingDecisionOwnerState => {
  const read = <Port, Value, Failure>(
    portFor: (transaction: ScopedTransactionExecutor) => Effect.Effect<Port, OperationContextUnavailable>,
    use: (port: Port) => Effect.Effect<Value, Failure>,
  ) => ownerTransaction((transaction) => portFor(transaction).pipe(Effect.flatMap(use)));
  const priceUnavailable = asPortUnavailability((reason, cause) =>
    withCause(new PricePersistenceUnavailable({ reason }), cause),
  );
  return {
    currency: {
      loadCurrent: (input) =>
        read(
          (transaction) => currencySupportPersistenceForScope(transaction, scope, compositionRevision),
          (currency) => currency.loadCurrent(input),
        ).pipe(asPortUnavailability((reason, cause) => new PersistenceFailure({ cause, reason }))),
    },
    discount: {
      readCurrentSet: (predicate) =>
        read(
          (transaction) => contractualDiscountPersistenceForScope(transaction, scope),
          (discount) => discount.readCurrentSet(predicate),
        ).pipe(
          asPortUnavailability((reason, cause) =>
            withCause(new ContractualDiscountPersistenceUnavailable({ reason }), cause),
          ),
        ),
    },
    fee: {
      readCurrentSet: (query) =>
        read(
          (transaction) => commercialFeePersistenceForScope(transaction, scope),
          (fee) => fee.readCurrentSet(query),
        ).pipe(
          asPortUnavailability((reason, cause) =>
            withCause(new CommercialFeePersistenceUnavailable({ reason }), cause),
          ),
        ),
    },
    floor: {
      readCurrentSet: (query) =>
        read(
          (transaction) => zeroFloorAuthorizationPersistenceForScope(transaction, scope),
          (floor) => floor.readCurrentSet(query),
        ).pipe(
          asPortUnavailability((reason, cause) =>
            withCause(new ZeroFloorAuthorizationPersistenceUnavailable({ reason }), cause),
          ),
        ),
    },
    price: {
      exactLookup: (request) =>
        read(
          (transaction) => pricePersistenceForScope(transaction, scope),
          (price) => price.exactLookup(request),
        ).pipe(priceUnavailable),
      readExactCandidateSet: (query) =>
        read(
          (transaction) => pricePersistenceForScope(transaction, scope),
          (price) => price.readExactCandidateSet(query),
        ).pipe(priceUnavailable),
      readSchedule: (priceRef, trustedOperationAt) =>
        read(
          (transaction) => pricePersistenceForScope(transaction, scope),
          (price) => price.readSchedule(priceRef, trustedOperationAt),
        ).pipe(priceUnavailable),
    },
    tier: {
      readCurrentSet: (query) =>
        read(
          (transaction) => quantityTierPersistenceForScope(transaction, scope),
          (tier) => tier.readCurrentSet(query),
        ).pipe(
          asPortUnavailability((reason, cause) => withCause(new QuantityTierPersistenceUnavailable({ reason }), cause)),
        ),
    },
  };
};
