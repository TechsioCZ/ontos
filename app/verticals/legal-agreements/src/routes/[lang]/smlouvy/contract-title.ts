import type { Contract } from '../../../../shared/apis/records.ts';

/** Keep technical references out of record titles, including when rental owners are unavailable. */
export const contractTitle = (
  record: Pick<Contract, 'kind' | 'subject'>,
  unitName: string | undefined,
  counterpartyName: string | null | undefined,
  fallback: string,
): string =>
  record.kind === 'LEASE' ? (unitName ?? record.subject ?? fallback) : (record.subject ?? counterpartyName ?? fallback);
