/* eslint-disable effect-native/no-hand-rolled-tagged-union, effect-native/no-literal-union-type-alias, effect-native/require-context-service-for-service-interface -- These structural ports model audited routine outcomes and are injected by generated Action/Read factories rather than global Context services; expires: 2027-03-01. */
import { Effect } from 'effect';
import type { CustomerPriceGroupAssignmentRef } from '../resources/customer-price-group-assignment.ts';
import type { CounterpartyRef } from './access-contract.ts';
import type {
  CommerceCustomerProfileTarget,
  CustomerPriceGroupAssignment,
  PriceGroupCatalogOutcome,
  PriceGroupCompatibilityIdentity,
  PriceGroupInstant,
  PriceGroupRef,
} from './price-group-contracts.ts';
import type { CustomerPriceGroupCatalogUnavailable } from './price-group-errors.ts';
import {
  CustomerPriceGroupPersistenceUnavailable,
  CustomerPriceGroupProfileUnavailable,
} from './price-group-errors.ts';

export const CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT = 'commerce.customer-price-group-assignment.v1' as const;

export interface PriceGroupCatalogPort {
  readonly resolveCurrent: (
    priceGroupRef: PriceGroupRef,
    requiredContractId: typeof CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT,
    effectiveAt: PriceGroupInstant,
    expectedCompatibility?: PriceGroupCompatibilityIdentity,
  ) => Effect.Effect<PriceGroupCatalogOutcome, CustomerPriceGroupCatalogUnavailable>;
}

type CustomerProfileState = 'ACTIVE' | 'ARCHIVED' | 'RECONCILIATION_REQUIRED' | 'SUSPENDED';

export type CustomerPriceGroupProfileValidation =
  | Readonly<{
      readonly _tag: 'CURRENT';
      readonly counterpartyRef: CounterpartyRef | null;
      readonly revision: number;
      readonly state: CustomerProfileState;
    }>
  | Readonly<{ readonly _tag: 'NOT_FOUND' }>;

/** Public customer-profile gate; implementations may delegate to customer-profile-trading-gate. */
export interface CustomerPriceGroupProfileValidationPort {
  readonly inspect: (
    profile: CommerceCustomerProfileTarget,
    effectiveAt: PriceGroupInstant,
    expectedCounterpartyRef?: CounterpartyRef,
  ) => Effect.Effect<CustomerPriceGroupProfileValidation, CustomerPriceGroupProfileUnavailable>;
}

export interface AssignCustomerPriceGroupStoreInput {
  readonly actionInvocationId: string;
  readonly compatibility: PriceGroupCompatibilityIdentity;
  /** When present, persistence must verify Profile association atomically with the mutation. */
  readonly counterpartyRef?: CounterpartyRef;
  readonly effectiveFrom: PriceGroupInstant;
  readonly effectiveTo: null | PriceGroupInstant;
  readonly expectedProfileRevision: number;
  readonly priceGroupRef: PriceGroupRef;
  readonly principalId: string;
  readonly profile: CommerceCustomerProfileTarget;
  readonly reason: string;
  readonly recordedAt: PriceGroupInstant;
  readonly tenantId: string;
}

export type AssignCustomerPriceGroupStoreResult =
  | Readonly<{
      readonly _tag: 'assigned';
      readonly assignment: CustomerPriceGroupAssignment;
      readonly changed: boolean;
      readonly replacedAssignmentRef: CustomerPriceGroupAssignmentRef | null;
    }>
  | Readonly<{ readonly _tag: 'overlap' }>
  | Readonly<{ readonly _tag: 'profile_not_found' }>
  | Readonly<{ readonly _tag: 'profile_revision_conflict' }>
  | Readonly<{ readonly _tag: 'retroactive_schedule' }>
  | Readonly<{
      readonly _tag: 'profile_ineligible';
      readonly profileState: Exclude<CustomerProfileState, 'ACTIVE'>;
    }>;

export interface RemoveCustomerPriceGroupStoreInput {
  readonly actionInvocationId: string;
  readonly assignmentRef: CustomerPriceGroupAssignmentRef;
  /** When present, persistence must verify Profile association atomically with the mutation. */
  readonly counterpartyRef?: CounterpartyRef;
  readonly effectiveAt: PriceGroupInstant;
  readonly expectedRevision: number;
  readonly principalId: string;
  readonly profile: CommerceCustomerProfileTarget;
  readonly reason: string;
  readonly recordedAt: PriceGroupInstant;
  readonly tenantId: string;
}

export type RemoveCustomerPriceGroupStoreResult =
  | Readonly<{
      readonly _tag: 'removed';
      readonly assignment: CustomerPriceGroupAssignment;
      readonly changed: boolean;
    }>
  | Readonly<{ readonly _tag: 'assignment_not_found' }>
  | Readonly<{ readonly _tag: 'profile_not_found' }>
  | Readonly<{ readonly _tag: 'profile_mismatch' }>
  | Readonly<{ readonly _tag: 'removal_conflict' }>
  | Readonly<{ readonly _tag: 'retroactive_schedule' }>
  | Readonly<{ readonly _tag: 'revision_conflict'; readonly currentRevision: number }>;

interface CustomerPriceGroupMigrationTarget {
  readonly assignmentRef: CustomerPriceGroupAssignmentRef;
  readonly expectedProfileRevision: number;
  readonly expectedRevision: number;
  readonly profile: CommerceCustomerProfileTarget;
}

export interface MigrateCustomerPriceGroupStoreInput {
  readonly actionInvocationId: string;
  readonly compatibility: PriceGroupCompatibilityIdentity;
  /** When present, persistence must verify every target Profile association atomically. */
  readonly counterpartyRef?: CounterpartyRef;
  readonly effectiveFrom: PriceGroupInstant;
  readonly principalId: string;
  readonly reason: string;
  readonly recordedAt: PriceGroupInstant;
  readonly sourcePriceGroupRef: PriceGroupRef;
  readonly targetPriceGroupRef: PriceGroupRef;
  readonly targets: readonly CustomerPriceGroupMigrationTarget[];
  readonly tenantId: string;
}

export interface CustomerPriceGroupMigrationConflictItem {
  readonly assignmentRef: CustomerPriceGroupAssignmentRef;
  readonly reason: 'ASSIGNMENT_CHANGED' | 'ASSIGNMENT_MISSING' | 'OVERLAP' | 'PROFILE_INELIGIBLE';
}

export type MigrateCustomerPriceGroupStoreResult =
  | Readonly<{
      readonly _tag: 'applied';
      readonly assignments: readonly CustomerPriceGroupAssignment[];
      readonly changed: boolean;
    }>
  | Readonly<{
      readonly _tag: 'conflicts';
      readonly conflicts: readonly CustomerPriceGroupMigrationConflictItem[];
    }>
  | Readonly<{ readonly _tag: 'retroactive_schedule' }>;

export type CustomerPriceGroupAssignmentLookup =
  | Readonly<{
      readonly _tag: 'found';
      readonly assignments: readonly CustomerPriceGroupAssignment[];
    }>
  | Readonly<{ readonly _tag: 'profile_not_found' }>;

/** Owner-local persistence implementation must serialize writes and enforce non-overlap. */
export interface CustomerPriceGroupAssignmentStorePort {
  readonly assign: (
    input: AssignCustomerPriceGroupStoreInput,
  ) => Effect.Effect<AssignCustomerPriceGroupStoreResult, CustomerPriceGroupPersistenceUnavailable>;
  readonly list: (
    profile: CommerceCustomerProfileTarget,
  ) => Effect.Effect<CustomerPriceGroupAssignmentLookup, CustomerPriceGroupPersistenceUnavailable>;
  readonly migrate: (
    input: MigrateCustomerPriceGroupStoreInput,
  ) => Effect.Effect<MigrateCustomerPriceGroupStoreResult, CustomerPriceGroupPersistenceUnavailable>;
  readonly remove: (
    input: RemoveCustomerPriceGroupStoreInput,
  ) => Effect.Effect<RemoveCustomerPriceGroupStoreResult, CustomerPriceGroupPersistenceUnavailable>;
  /** Returns at most two assignments current at the trusted instant so overlap is still detectable. */
  readonly resolve: (
    profile: CommerceCustomerProfileTarget,
    effectiveAt: PriceGroupInstant,
  ) => Effect.Effect<CustomerPriceGroupAssignmentLookup, CustomerPriceGroupPersistenceUnavailable>;
}

const persistenceNotWired = () =>
  Effect.fail(
    new CustomerPriceGroupPersistenceUnavailable({
      code: 'customer_price_group_persistence_unavailable',
      reason: 'Customer Price Group Assignment persistence is not available',
    }),
  );

/** Fail-closed runtime default; deployment wiring must replace it with the owner-local adapter. */
// eslint-disable-next-line no-unused-vars -- Retain the default that keeps the shared fail-closed persistence helper structurally exercised.
const unavailableCustomerPriceGroupAssignmentStore: CustomerPriceGroupAssignmentStorePort = {
  assign: persistenceNotWired,
  list: persistenceNotWired,
  migrate: persistenceNotWired,
  remove: persistenceNotWired,
  resolve: persistenceNotWired,
};

// eslint-disable-next-line no-unused-vars -- Retain the fail-closed value that keeps profile validation a runtime port rather than a type-only seam.
const unavailableCustomerPriceGroupProfileValidationPort: CustomerPriceGroupProfileValidationPort = {
  inspect: () =>
    Effect.fail(
      new CustomerPriceGroupProfileUnavailable({
        code: 'customer_price_group_profile_unavailable',
        reason: 'The governed Customer Profile trading gate is not available',
      }),
    ),
};
