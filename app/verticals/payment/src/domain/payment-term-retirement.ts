import type { PaymentTermDefinitionSnapshot } from '@app/payment-term-catalog-contracts/payment-term';
import { DateTime } from 'effect';

/**
 * Whether a C15 Payment Term snapshot is already retired at `at`. An owner answer that calls a term
 * usable while its own snapshot says the term was retired is contradictory evidence, so both
 * applicability and authorization refuse it. A scheduled retirement (`effectiveTo` still in the future)
 * keeps the term Current until it is reached.
 */
export const isPaymentTermSnapshotRetiredAt = (snapshot: PaymentTermDefinitionSnapshot, at: DateTime.Utc): boolean => {
  const { effectiveTo } = snapshot.lifecycle;
  return effectiveTo !== null && DateTime.isLessThanOrEqualTo(DateTime.makeUnsafe(effectiveTo), at);
};
