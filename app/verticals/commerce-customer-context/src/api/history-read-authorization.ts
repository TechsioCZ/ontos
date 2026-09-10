import type {
  BusinessPermissionCode,
  OperationalScope,
  ResolvedReadPermissionTarget,
} from '@app/core-runtime';
import type { CounterpartyRef } from '../../shared/domain/access-contract.ts';
import type {
  CustomerHistorySubject,
  HistoricalRecordRef,
} from '../../shared/domain/record-visibility-contracts.ts';
import type { CounterpartyPurchasingProfileRef } from '../../shared/resources/counterparty-purchasing-profile.ts';
import type { RetailCustomerProfileRef } from '../../shared/resources/retail-customer-profile.ts';

interface RetailTargetInput {
  readonly profileRef: RetailCustomerProfileRef;
  readonly refs?: readonly HistoricalRecordRef[];
}

interface CounterpartyTargetInput {
  readonly counterpartyRef: CounterpartyRef;
  readonly profileRef: CounterpartyPurchasingProfileRef;
  readonly refs?: readonly HistoricalRecordRef[];
}

const exactTenant = (
  scope: OperationalScope,
  refs: readonly { readonly tenantId: string }[],
): string => (refs.every((ref) => ref.tenantId === scope.tenantId) ? scope.tenantId : '');

const retailTarget = (
  input: RetailTargetInput,
  scope: OperationalScope,
  permission: BusinessPermissionCode,
): ResolvedReadPermissionTarget => ({
  businessPermission: {
    permission,
    target: {
      kind: 'retail_profile',
      legalEntityId: scope.legalEntityId ?? '',
      profileId: input.profileRef.resourceId,
      tenantId: exactTenant(scope, [input.profileRef, ...(input.refs ?? [])]),
    },
  },
  kind: 'business_permission',
});

const counterpartyTarget = (
  input: CounterpartyTargetInput,
  scope: OperationalScope,
  permission: BusinessPermissionCode,
): ResolvedReadPermissionTarget => ({
  businessPermission: {
    permission,
    target: {
      counterpartyId: input.counterpartyRef.resourceId,
      kind: 'counterparty',
      legalEntityId: scope.legalEntityId ?? '',
      tenantId: exactTenant(scope, [
        input.counterpartyRef,
        input.profileRef,
        ...(input.refs ?? []),
      ]),
    },
  },
  kind: 'business_permission',
});

export const retailHistoryTarget = (input: RetailTargetInput, scope: OperationalScope) =>
  retailTarget(input, scope, 'retail.history.read');

export const retailRepeatTarget = (input: RetailTargetInput, scope: OperationalScope) =>
  retailTarget(input, scope, 'retail.repeat_order');

export const counterpartyOwnHistoryTarget = (
  input: CounterpartyTargetInput,
  scope: OperationalScope,
) => counterpartyTarget(input, scope, 'counterparty.history.read_own');

export const counterpartyAllHistoryTarget = (
  input: CounterpartyTargetInput,
  scope: OperationalScope,
) => counterpartyTarget(input, scope, 'counterparty.history.read_all');

export const counterpartyPurchaseTarget = (
  input: CounterpartyTargetInput,
  scope: OperationalScope,
) => counterpartyTarget(input, scope, 'counterparty.purchase.prepare');

export const subjectHistoryTarget = (
  input: {
    readonly refs?: readonly HistoricalRecordRef[];
    readonly subject: CustomerHistorySubject;
  },
  scope: OperationalScope,
): ResolvedReadPermissionTarget =>
  input.subject.kind === 'RETAIL_PROFILE'
    ? retailHistoryTarget(
        {
          profileRef: input.subject.profileRef,
          refs: input.refs ?? [],
        },
        scope,
      )
    : counterpartyOwnHistoryTarget(
        {
          counterpartyRef: input.subject.counterpartyRef,
          profileRef: input.subject.profileRef,
          refs: input.refs ?? [],
        },
        scope,
      );

export const subjectRepeatTarget = (
  input: {
    readonly refs?: readonly HistoricalRecordRef[];
    readonly subject: CustomerHistorySubject;
  },
  scope: OperationalScope,
): ResolvedReadPermissionTarget =>
  input.subject.kind === 'RETAIL_PROFILE'
    ? retailRepeatTarget(
        {
          profileRef: input.subject.profileRef,
          refs: input.refs ?? [],
        },
        scope,
      )
    : counterpartyPurchaseTarget(
        {
          counterpartyRef: input.subject.counterpartyRef,
          profileRef: input.subject.profileRef,
          refs: input.refs ?? [],
        },
        scope,
      );
