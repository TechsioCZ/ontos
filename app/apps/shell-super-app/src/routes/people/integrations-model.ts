import type { ConnectorPartnerKind } from '@app/shared-contracts/integrations/connector-partners';

import type { ManagedApiKeyListResponse } from '../../../shared/browser-api.ts';

type ManagedItem = ManagedApiKeyListResponse['items'][number];

/** One integration of the Tenant, as the tenant-managed list shows it (one row per key, folded here). */
export interface IntegrationEntry {
  readonly displayName: string | null;
  readonly integrationKind: ConnectorPartnerKind | null;
  readonly principalId: ManagedItem['principalId'];
  readonly principalStatus: ManagedItem['principalStatus'];
}

/** The Tenant's integrations in list order: every `integration` row of the tenant-managed list, once per Principal. */
export const integrationEntries = (items: readonly ManagedItem[]): readonly IntegrationEntry[] => {
  const entries = new Map<string, IntegrationEntry>();
  for (const item of items) {
    if (item.kind === 'integration' && !entries.has(item.principalId)) {
      entries.set(item.principalId, {
        displayName: item.displayName ?? null,
        integrationKind: item.integrationKind ?? null,
        principalId: item.principalId,
        principalStatus: item.principalStatus,
      });
    }
  }
  return [...entries.values()];
};
