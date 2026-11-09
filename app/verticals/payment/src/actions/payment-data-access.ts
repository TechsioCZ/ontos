import type { ActionHandlerContext, DomainEventContractMap } from '@app/core-runtime';
import { Effect, Option } from 'effect';

import type { PaymentSourceServices } from '../persistence/payment-source-persistence.ts';

/**
 * Bounded Data Access evidence of the Payment-owned reads an Action decides on (ACTIONS.md, DATA_ACCESS.md).
 * Core persists these only with a successful invocation. Evidence carries the closed query name, the
 * owner record id it was keyed on and the result count; never a payload, a purchase or intent key, or a
 * source reference. Reads of a Payment target the declared `payment.core.payment` resource.
 */

const PAYMENT_MODULE_KEY = 'payment.core' as const;
const PAYMENT_RESOURCE_TYPE = 'payment.core.payment' as const;

/** The closed vocabulary of Payment-owned queries, each with the access kind it performs. */
const PAYMENT_QUERY_ACCESS = {
  'authorization-issuance': 'read',
  'case-decisions': 'list',
  'established-effects': 'list',
  'intent-key': 'read',
  'interpreted-evidence': 'list',
  'method-enablement': 'read',
  'method-enablements': 'list',
  observation: 'read',
  'observation-attachments': 'list',
  'observation-correction': 'read',
  'payment-aggregate': 'read',
  'prepaid-coverage-proofs': 'list',
  'purchase-correlation': 'read',
  'purchase-intents': 'list',
  'reconciliation-case': 'read',
  'refund-routes': 'list',
  'return-evidence': 'list',
  'same-effect-observations': 'list',
  'source-authorities': 'list',
  'source-authority': 'read',
  'source-occurrence': 'read',
  successor: 'read',
} as const;

export type PaymentOwnerQuery = keyof typeof PAYMENT_QUERY_ACCESS;

type DataAccessRecorder = Pick<ActionHandlerContext<DomainEventContractMap>, 'recordDataAccess'>;

/** One Payment-owned lookup: optionally about one Payment (the target) or keyed on one owner record id. */
export interface PaymentLookup {
  readonly paymentId?: string | undefined;
  readonly query: PaymentOwnerQuery;
  readonly recordId?: string | undefined;
  readonly resultCount: number;
}

const queryHashOf = ({ paymentId, query, recordId }: PaymentLookup) =>
  [`${PAYMENT_MODULE_KEY}.${query}`, paymentId, recordId].filter((part) => part !== undefined).join(':');

export const recordPaymentLookup = (context: DataAccessRecorder, lookup: PaymentLookup) => {
  const event = {
    accessKind: PAYMENT_QUERY_ACCESS[lookup.query],
    queryHash: queryHashOf(lookup),
    resultCount: lookup.resultCount,
    servingModuleKey: PAYMENT_MODULE_KEY,
  };
  return context.recordDataAccess(
    lookup.paymentId === undefined
      ? event
      : {
          ...event,
          targetModuleKey: PAYMENT_MODULE_KEY,
          targetResourceId: lookup.paymentId,
          targetResourceType: PAYMENT_RESOURCE_TYPE,
        },
  );
};

/** The Payment aggregate (row, operations and funds) of each Payment, read once per Payment. */
export const recordPaymentAggregateReads = (context: DataAccessRecorder, paymentIds: Iterable<string>) =>
  Effect.forEach(
    new Set(paymentIds),
    (paymentId) => recordPaymentLookup(context, { paymentId, query: 'payment-aggregate', resultCount: 1 }),
    { concurrency: 1, discard: true },
  );

/**
 * Source statement acceptance decides inside the domain on owner reads the handler does not see. The
 * handler passes these observed services instead: each successful read notes its bounded lookup, and
 * `recordReads` records them once the decision returned (a failed invocation persists none anyway).
 */
export const observedPaymentSourceServices = (services: PaymentSourceServices) => {
  const lookups: PaymentLookup[] = [];
  const note = (lookup: PaymentLookup) =>
    Effect.sync(() => {
      lookups.push(lookup);
    });
  const observed: PaymentSourceServices = {
    aggregate: {
      ...services.aggregate,
      loadAggregate: (paymentId, options) =>
        services.aggregate
          .loadAggregate(paymentId, options)
          .pipe(
            Effect.tap((loaded) =>
              note({ paymentId: loaded.payment.paymentId, query: 'payment-aggregate', resultCount: 1 }),
            ),
          ),
    },
    source: {
      ...services.source,
      findObservation: (observationId) =>
        services.source
          .findObservation(observationId)
          .pipe(
            Effect.tap((found) =>
              note({ query: 'observation', recordId: observationId, resultCount: Option.isSome(found) ? 1 : 0 }),
            ),
          ),
      findOccurrence: (input) =>
        services.source.findOccurrence(input).pipe(
          Effect.tap((found) =>
            note({
              query: 'source-occurrence',
              recordId: Option.getOrUndefined(found)?.observationId,
              resultCount: Option.isSome(found) ? 1 : 0,
            }),
          ),
        ),
      listInterpretedEvidence: (paymentId) =>
        services.source.listInterpretedEvidence(paymentId).pipe(
          Effect.tap((lineage) =>
            note({
              paymentId,
              query: 'interpreted-evidence',
              resultCount: lineage.acceptedObservations.length + lineage.attachedStatements.length,
            }),
          ),
        ),
      lockAuthorities: (input) =>
        services.source
          .lockAuthorities(input)
          .pipe(Effect.tap((authorities) => note({ query: 'source-authorities', resultCount: authorities.length }))),
    },
  };
  return {
    recordReads: (context: DataAccessRecorder) =>
      Effect.forEach(lookups, (lookup) => recordPaymentLookup(context, lookup), { concurrency: 1, discard: true }),
    services: observed,
  };
};
