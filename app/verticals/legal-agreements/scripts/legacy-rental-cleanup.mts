import { isDeepStrictEqual } from 'node:util';
import type { AgreementsState } from '../shared/apis/records.ts';

export const legacyRentalScope = {
  tenantId: '70000000-0000-4000-8000-000000000020',
  legalEntityId: '71000000-0000-4000-8000-000000000020',
} as const;
const legacyContractIds = new Set(['76000000-0000-4000-8000-000000000023', '76000000-0000-4000-8000-000000000024']);

/** Retire only the unchanged, original synthetic rental fixture, never real or edited contracts. */
export const retireLegacyRental = (
  scope: { readonly tenantId: string; readonly legalEntityId: string },
  state: AgreementsState,
  baseline: AgreementsState,
): AgreementsState => {
  if (scope.tenantId !== legacyRentalScope.tenantId || scope.legalEntityId !== legacyRentalScope.legalEntityId) {
    throw new Error('Legacy rental cleanup is restricted to the Obchodní firma demo scope');
  }
  const isLegacy = (id: string | undefined) => id !== undefined && legacyContractIds.has(id);
  const contracts = state.contracts.filter((row) => isLegacy(row.contractRef.resourceId));
  const documents = state.documents.filter((row) => isLegacy(row.contractRef?.resourceId));
  if (
    state.contracts.some(
      (row) => !isLegacy(row.contractRef.resourceId) && isLegacy(row.supersedesContractRef?.resourceId),
    )
  ) {
    throw new Error('Legacy contract has a successor; preserve it for manual review');
  }
  if (
    contracts.some((row) => !baseline.contracts.some((original) => isDeepStrictEqual(row, original))) ||
    documents.some((row) => !baseline.documents.some((original) => isDeepStrictEqual(row, original)))
  ) {
    throw new Error('Legacy rental fixture was edited; no records removed');
  }
  if (contracts.length + documents.length === 0) return state;
  return {
    ...state,
    contracts: state.contracts.filter((row) => !isLegacy(row.contractRef.resourceId)),
    documents: state.documents.filter((row) => !isLegacy(row.contractRef?.resourceId)),
  };
};
