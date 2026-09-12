/* eslint-disable effect-native/no-manual-tag-comparison -- These checks narrow external catalog and persisted assignment discriminants into exact public resolution outcomes; expires: 2027-03-01. */
import { Effect } from 'effect';
import type {
  CommerceCustomerProfileTarget,
  CustomerPriceGroupAssignment,
  CustomerPriceGroupResolution,
  PriceGroupCatalogOutcome,
  PriceGroupInstant,
} from './price-group-contracts.ts';
import {
  isCustomerPriceGroupAssignmentCurrent,
  samePriceGroupRef,
  sameProfileTarget,
} from './price-group-contracts.ts';
import { CustomerPriceGroupCatalogUnavailable } from './price-group-errors.ts';
import type { PriceGroupCatalogPort } from './price-group-ports.ts';
import { CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT } from './price-group-ports.ts';

const broken = (
  assignment: CustomerPriceGroupAssignment,
  outcome: Exclude<PriceGroupCatalogOutcome, { readonly _tag: 'USABLE' }>,
): CustomerPriceGroupResolution => ({
  _tag: 'BROKEN',
  assignmentRef: assignment.assignmentRef,
  assignmentRevision: assignment.revision,
  catalogRevision: outcome._tag === 'MISSING' ? null : outcome.catalogRevision,
  priceGroupRef: assignment.priceGroupRef,
  reason: outcome._tag,
});

/**
 * Resolves one profile at a caller-supplied trusted operation time. Catalog failures remain errors:
 * they must never be collapsed into NONE, because that would silently grant default pricing.
 */
export const resolveCustomerPriceGroupAt = Effect.fn('CustomerPriceGroup.resolveCustomerPriceGroupAt')(
  function* resolveAt(
    profile: CommerceCustomerProfileTarget,
    assignments: readonly CustomerPriceGroupAssignment[],
    effectiveAt: PriceGroupInstant,
    catalog: PriceGroupCatalogPort,
  ) {
    const current = assignments.filter(
      (assignment) =>
        sameProfileTarget(profile, assignment.profile) &&
        isCustomerPriceGroupAssignmentCurrent(assignment, effectiveAt),
    );

    if (current.length === 0) {
      return { _tag: 'NONE' } as const;
    }
    if (current.length > 1) {
      return { _tag: 'INCONSISTENT', currentAssignmentCount: current.length } as const;
    }

    const [assignment] = current;
    if (assignment === undefined) {
      return { _tag: 'NONE' } as const;
    }
    const outcome = yield* catalog.resolveCurrent(
      assignment.priceGroupRef,
      CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT,
      effectiveAt,
      assignment.compatibility,
    );

    if (outcome._tag !== 'USABLE') {
      return broken(assignment, outcome);
    }
    if (
      !samePriceGroupRef(outcome.priceGroupRef, assignment.priceGroupRef) ||
      outcome.compatibility.contractId !== CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT
    ) {
      return {
        _tag: 'BROKEN',
        assignmentRef: assignment.assignmentRef,
        assignmentRevision: assignment.revision,
        catalogRevision: outcome.compatibility.catalogRevision,
        priceGroupRef: assignment.priceGroupRef,
        reason: 'INCOMPATIBLE',
      } as const;
    }

    return {
      _tag: 'ASSIGNED',
      assignmentRef: assignment.assignmentRef,
      assignmentRevision: assignment.revision,
      compatibility: outcome.compatibility,
      effectiveFrom: assignment.effectiveFrom,
      effectiveTo: assignment.effectiveTo,
      priceGroupRef: assignment.priceGroupRef,
    } as const;
  },
);

/** Fail-closed default until Pricing publishes #334's governed PriceGroup catalog port. */
export const unavailablePriceGroupCatalogPort: PriceGroupCatalogPort = {
  resolveCurrent: () =>
    Effect.fail(
      new CustomerPriceGroupCatalogUnavailable({
        code: 'customer_price_group_catalog_unavailable',
        reason: 'Pricing has not published the governed PriceGroup catalog contract (#334)',
      }),
    ),
};
