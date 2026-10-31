/**
 * Pure decisions behind the customer facade's create flow.
 *
 * `create-party` records every Candidate without a strong (VERIFIED) identifier as an AMBIGUOUS
 * Duplicate Candidate Case, even when no existing Party shares its exact name or IČO. The customer
 * form is an explicit "create" request, so the facade resolves such a case as CREATE_NEW only when the
 * case lists no candidate Parties; any candidate keeps the case open for an Identity Reviewer.
 */
import { Option, Schema } from 'effect';

import type { CustomerListItem } from '../../shared/apis/customer-list.ts';
import type { DuplicateCandidateDetailResponse } from '../../shared/apis/duplicate-candidate-detail.ts';

const normalizedCompanyId = (value: string) => value.replaceAll(/\s+/gu, '');

/** The current customer that already carries this IČO, so a repeated create reuses it. */
export const existingCustomerWithCompanyId = (
  customers: readonly CustomerListItem[],
  companyId: string | undefined,
): Option.Option<CustomerListItem> => {
  const wanted = normalizedCompanyId(companyId ?? '');
  if (wanted.length === 0) {
    return Option.none();
  }
  return Option.fromNullishOr(
    customers.find(
      (customer) =>
        customer.status === 'ACTIVE' &&
        customer.companyId !== null &&
        normalizedCompanyId(customer.companyId) === wanted,
    ),
  );
};

export const AmbiguousCreateDecisionSchema = Schema.Literals(['CREATE_NEW', 'NEEDS_REVIEW']);
export type AmbiguousCreateDecision = typeof AmbiguousCreateDecisionSchema.Type;

/** CREATE_NEW only for an open case without any candidate Party (no exact name or IČO duplicate). */
export const decideAmbiguousCustomerCreate = (
  detail: Pick<DuplicateCandidateDetailResponse, 'candidateParties' | 'lifecycleState'>,
): AmbiguousCreateDecision =>
  detail.lifecycleState === 'OPEN' && detail.candidateParties.length === 0 ? 'CREATE_NEW' : 'NEEDS_REVIEW';
