// oxlint-disable effect-native/require-context-service-for-service-interface -- Owner ports intentionally form one injected aggregate; remove-when: #261 owners publish Context tags.
// oxlint-disable effect-native/no-nullable-service-outcome -- Null is the explicit closed onboarding result; remove-when: #336 owner catalogs adopt encoded Option.
import { Context, Effect } from 'effect';
import type { CounterpartyRef } from './access-contract.ts';
import type {
  BusinessPolicyState,
  CurrentGateState,
  CustomerOrderHistoryDetail,
  HistoricalOrderLineIntent,
  HistoryFreshness,
  RepeatOrderLineResult,
} from './history-contracts.ts';
import type {
  CustomerHistorySubject,
  CustomerRecordTypeOnboarding,
  CustomerRecordVisibilityFact,
  HistoricalRecordRef,
  HistoryInstant,
} from './record-visibility-contracts.ts';
import type { CounterpartyPurchasingProfileRef } from '../resources/counterparty-purchasing-profile.ts';
import type { RetailCustomerProfileRef } from '../resources/retail-customer-profile.ts';
import { HistoryOwnerUnavailable } from './history-errors.ts';

export interface RetailHistoryAuthorizationFacts {
  readonly archivePermission: CurrentGateState;
  readonly binding: CurrentGateState;
  readonly historyPermission: CurrentGateState;
  /**
   * Owner-published policy decisions keyed by the onboarding contract's policy identity.
   * The aggregate `policy` remains the compatibility fallback for older adapters that do not
   * publish the keyed projection yet.
   */
  readonly policies?: Readonly<Record<string, BusinessPolicyState>> | undefined;
  readonly policy: BusinessPolicyState;
  readonly repeatPermission: CurrentGateState;
}

export interface CounterpartyHistoryAuthorizationFacts {
  readonly access: CurrentGateState;
  readonly archivePermission: CurrentGateState;
  readonly historyPermission:
    | 'counterparty.history.read_all'
    | 'counterparty.history.read_own'
    | 'INDETERMINATE'
    | null;
  /**
   * Owner-published policy decisions keyed by the onboarding contract's policy identity.
   * The aggregate `policy` remains the compatibility fallback for older adapters that do not
   * publish the keyed projection yet.
   */
  readonly policies?: Readonly<Record<string, BusinessPolicyState>> | undefined;
  readonly policy: BusinessPolicyState;
  readonly purchasePermission: CurrentGateState;
}

export interface HistoricalOrderCandidate {
  readonly acceptedAt: HistoryInstant;
  readonly displayLabel: string;
  readonly freshness: HistoryFreshness;
  readonly lines: readonly HistoricalOrderLineIntent[];
  readonly orderRef: HistoricalRecordRef;
  readonly subject: CustomerHistorySubject;
  /** Immutable Order-owned actor attribution; never derived from current employment/access. */
  readonly submittedByPrincipalId: string;
}

/** Minimal owner-current authorization projection used before protected detail is requested. */
export interface HistoricalOrderDetailAuthorizationCandidate {
  readonly acceptedAt: HistoryInstant;
  readonly freshness: HistoryFreshness;
  readonly orderRef: HistoricalRecordRef;
  readonly subject: CustomerHistorySubject;
  readonly submittedByPrincipalId: string;
}

export interface ArchiveRecordCandidate {
  readonly displayLabel: string;
  readonly freshness: HistoryFreshness;
  readonly occurredAt: HistoryInstant;
  readonly recordKind: 'BILLING_DOCUMENT' | 'CLAIM' | 'ORDER';
  readonly recordRef: HistoricalRecordRef;
  readonly subject: CustomerHistorySubject;
  /** Required when an OWN_ORDERS-style Counterparty archive scope is applied. */
  readonly submittedByPrincipalId?: string;
}

export type HistoricalOrderLookup =
  | { readonly outcome: 'FOUND'; readonly value: HistoricalOrderCandidate }
  | { readonly outcome: 'NOT_FOUND' };

export type CustomerOrderHistoryDetailLookup =
  | { readonly outcome: 'FOUND'; readonly value: CustomerOrderHistoryDetail }
  | { readonly outcome: 'NOT_FOUND' };

export type HistoricalOrderDetailAuthorizationLookup =
  | { readonly outcome: 'FOUND'; readonly value: HistoricalOrderDetailAuthorizationCandidate }
  | { readonly outcome: 'NOT_FOUND' };

export type CustomerRecordVisibilityLookup =
  | { readonly fact: CustomerRecordVisibilityFact; readonly outcome: 'FOUND' }
  | { readonly outcome: 'INDETERMINATE' }
  | { readonly outcome: 'MISSING' };

export interface HistoryAccessPort {
  readonly counterparty: (input: {
    readonly principalId: string;
    readonly profileRef: CounterpartyPurchasingProfileRef;
  }) => Effect.Effect<CounterpartyHistoryAuthorizationFacts, HistoryOwnerUnavailable>;
  readonly retail: (input: {
    readonly principalId: string;
    readonly profileRef: RetailCustomerProfileRef;
  }) => Effect.Effect<RetailHistoryAuthorizationFacts, HistoryOwnerUnavailable>;
}

export interface CounterpartyProfileAssociationPort {
  /** Resolves the owner-current exact Counterparty ↔ purchasing-profile association. */
  readonly current: (input: {
    readonly counterpartyRef: CounterpartyRef;
    readonly profileRef: CounterpartyPurchasingProfileRef;
  }) => Effect.Effect<'ABSENT' | 'CURRENT' | 'INDETERMINATE', HistoryOwnerUnavailable>;
}

export interface OrderHistoryPort {
  /** Returns owner-current, already customer-minimized detail after the caller gates pass. */
  readonly getCustomerFacingDetail: (input: {
    readonly orderRef: HistoricalRecordRef;
    readonly subject: CustomerHistorySubject;
  }) => Effect.Effect<CustomerOrderHistoryDetailLookup, HistoryOwnerUnavailable>;
  readonly getForHistoryDetailAuthorization: (input: {
    readonly orderRef: HistoricalRecordRef;
  }) => Effect.Effect<HistoricalOrderDetailAuthorizationLookup, HistoryOwnerUnavailable>;
  readonly getForRepeat: (input: {
    readonly orderRef: HistoricalRecordRef;
  }) => Effect.Effect<HistoricalOrderLookup, HistoryOwnerUnavailable>;
  readonly listCounterparty: (input: {
    readonly counterpartyRef: CounterpartyRef;
    readonly profileRef: CounterpartyPurchasingProfileRef;
  }) => Effect.Effect<readonly HistoricalOrderCandidate[], HistoryOwnerUnavailable>;
  readonly listRetail: (input: {
    readonly profileRef: RetailCustomerProfileRef;
  }) => Effect.Effect<readonly HistoricalOrderCandidate[], HistoryOwnerUnavailable>;
}

export interface CustomerRecordVisibilityPort {
  readonly get: (input: {
    readonly recordRef: HistoricalRecordRef;
    readonly subject: CustomerHistorySubject;
  }) => Effect.Effect<CustomerRecordVisibilityLookup, HistoryOwnerUnavailable>;
}

export interface CustomerRecordTypeCatalogPort {
  /** Owner-published admission contract; `null` is the closed, not-onboarded state. */
  readonly get: (input: {
    readonly ownerModuleId: string;
    readonly resourceType: string;
  }) => Effect.Effect<CustomerRecordTypeOnboarding | null, HistoryOwnerUnavailable>;
}

export interface HistoricalResourceAccessPort {
  /** Exact current read decision for owner/evidence refs discovered during safe composition. */
  readonly current: (input: {
    readonly principalId: string;
    readonly refs: readonly HistoricalRecordRef[];
  }) => Effect.Effect<CurrentGateState, HistoryOwnerUnavailable>;
}

export interface CustomerArchiveSourcePort {
  readonly list: (input: {
    readonly subject: CustomerHistorySubject;
  }) => Effect.Effect<readonly ArchiveRecordCandidate[], HistoryOwnerUnavailable>;
  readonly ownerModuleId: string;
}

export interface CartPreparationPort {
  /** Evaluates one line against Current Cart/Catalog rules; it performs no Cart write. */
  readonly prepareLine: (
    subject: CustomerHistorySubject,
    line: HistoricalOrderLineIntent,
  ) => Effect.Effect<RepeatOrderLineResult, HistoryOwnerUnavailable>;
}

export interface CustomerHistoryPorts {
  readonly access: HistoryAccessPort;
  readonly archiveSources: readonly CustomerArchiveSourcePort[];
  readonly cart: CartPreparationPort;
  readonly counterpartyProfiles: CounterpartyProfileAssociationPort;
  readonly orders: OrderHistoryPort;
  readonly recordTypes: CustomerRecordTypeCatalogPort;
  readonly resources: HistoricalResourceAccessPort;
  readonly visibility: CustomerRecordVisibilityPort;
}

/** Deployment-owned composition of current customer access and external record-owner ports. */
export class CustomerHistoryPortsService extends Context.Service<
  CustomerHistoryPortsService,
  CustomerHistoryPorts
>()('@app/commerce-customer-context/shared/domain/history-ports/CustomerHistoryPortsService') {}

/**
 * Explicit deployment boundary until Order, Cart, Billing, and customer-visibility owners
 * publish transport-backed public adapters. Consumers must replace these ports as each owner ships;
 * no local table, fabricated history, or permissive fallback is allowed.
 */
const CUSTOMER_CONTEXT_OWNER = 'commerce.customer-context';
const ORDER_OWNER = 'commerce.order';
const unavailableHistoryOwner = (ownerModuleId: string) =>
  Effect.fail(new HistoryOwnerUnavailable({ ownerModuleId }));

export const unavailableCustomerHistoryPorts = (): CustomerHistoryPorts =>
  Object.freeze({
    access: {
      counterparty: () => unavailableHistoryOwner(CUSTOMER_CONTEXT_OWNER),
      retail: () => unavailableHistoryOwner(CUSTOMER_CONTEXT_OWNER),
    },
    archiveSources: [],
    cart: { prepareLine: () => unavailableHistoryOwner('commerce.cart') },
    counterpartyProfiles: { current: () => unavailableHistoryOwner(CUSTOMER_CONTEXT_OWNER) },
    orders: {
      getCustomerFacingDetail: () => unavailableHistoryOwner(ORDER_OWNER),
      getForHistoryDetailAuthorization: () => unavailableHistoryOwner(ORDER_OWNER),
      getForRepeat: () => unavailableHistoryOwner(ORDER_OWNER),
      listCounterparty: () => unavailableHistoryOwner(ORDER_OWNER),
      listRetail: () => unavailableHistoryOwner(ORDER_OWNER),
    },
    recordTypes: { get: () => unavailableHistoryOwner(CUSTOMER_CONTEXT_OWNER) },
    resources: { current: () => unavailableHistoryOwner('commerce.authorization') },
    visibility: { get: () => unavailableHistoryOwner(ORDER_OWNER) },
  });
