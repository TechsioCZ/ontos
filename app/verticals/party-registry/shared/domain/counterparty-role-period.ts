import type { CounterpartyRolePeriod, CounterpartyRoleType } from './counterparty-contract.ts';

const counterpartyContextEvidenceMethods = new Set([
  'APPROVED_COMMERCIAL_RELATIONSHIP',
  'BINDING_ORDER',
  'BINDING_PURCHASE_ORDER',
  'COMPLETED_VENDOR_ONBOARDING',
  'MIGRATION_REVIEW',
  'SIGNED_CONTRACT',
]);

const customerEvidenceMethods = new Set([
  'APPROVED_PURCHASING_RELATIONSHIP',
  'BINDING_ORDER',
  'MIGRATION_REVIEW',
  'SIGNED_CONTRACT',
]);

const supplierEvidenceMethods = new Set([
  'APPROVED_SUPPLIER_RELATIONSHIP',
  'BINDING_PURCHASE_ORDER',
  'COMPLETED_VENDOR_ONBOARDING',
  'MIGRATION_REVIEW',
  'SIGNED_CONTRACT',
]);

const customerEndEvidenceMethods = new Set([
  'CONFIRMED_CUSTOMER_RELATIONSHIP_END',
  'CONTRACT_EXPIRY_CONFIRMED',
  'MIGRATION_REVIEW',
  'SIGNED_TERMINATION_AGREEMENT',
]);

const supplierEndEvidenceMethods = new Set([
  'CONFIRMED_SUPPLIER_RELATIONSHIP_END',
  'CONTRACT_EXPIRY_CONFIRMED',
  'MIGRATION_REVIEW',
  'SIGNED_TERMINATION_AGREEMENT',
]);

export const counterpartyContextEvidenceIsSufficient = (method: string): boolean =>
  counterpartyContextEvidenceMethods.has(method);

export const roleEvidenceIsSufficient = (roleType: CounterpartyRoleType, method: string): boolean =>
  (roleType === 'CUSTOMER' ? customerEvidenceMethods : supplierEvidenceMethods).has(method);

export const roleEndEvidenceIsSufficient = (
  roleType: CounterpartyRoleType,
  method: string,
): boolean =>
  (roleType === 'CUSTOMER' ? customerEndEvidenceMethods : supplierEndEvidenceMethods).has(method);

export const rolePeriodIsCurrentAt = (
  period: Pick<CounterpartyRolePeriod, 'state' | 'validFrom' | 'validTo'>,
  instant: string,
): boolean =>
  period.state === 'ACTIVE' &&
  period.validFrom <= instant &&
  (period.validTo === null || instant < period.validTo);

export interface RolePeriodStorageState {
  readonly isCurrent: boolean;
  readonly state: 'ACTIVE' | 'ENDED';
}

export const rolePeriodStorageStateAt = (
  period: Readonly<{ validFrom: string; validTo: null | string }>,
  recordedAt: string,
): RolePeriodStorageState => {
  const ended = period.validTo !== null && period.validTo <= recordedAt;
  return {
    isCurrent:
      !ended &&
      period.validFrom <= recordedAt &&
      (period.validTo === null || recordedAt < period.validTo),
    state: ended ? 'ENDED' : 'ACTIVE',
  };
};

export const rolePeriodsOverlap = (
  left: Readonly<{ validFrom: string; validTo: null | string }>,
  right: Readonly<{ validFrom: string; validTo: null | string }>,
): boolean =>
  (left.validTo === null || right.validFrom < left.validTo) &&
  (right.validTo === null || left.validFrom < right.validTo);
