import { Schema } from 'effect';

import { LegalEntityIdSchema, SafeTenantIdentitySchema } from '../../../shared/api.ts';
import type { AuthenticatedHomePageModel } from '../../../src/routes/[lang]/home-page-model.ts';

/** The authenticated shell every route page test renders its own model on top of. */
export const authenticatedShellFixture = (): AuthenticatedHomePageModel => ({
  compositionRevision: '1'.repeat(64),
  contextState: 'authenticated',
  identity: Schema.decodeUnknownSync(SafeTenantIdentitySchema)({
    displayName: 'Ada Lovelace',
    email: 'ada@example.test',
    principalId: 'principal-1',
    tenantId: 'tenant-1',
  }),
  legalEntities: { items: [], state: 'available' },
  navigation: { items: [], state: 'available', unavailableDeployments: [] },
  selectedLegalEntityId: Schema.decodeUnknownSync(LegalEntityIdSchema)('20000000-0000-4000-8000-000000000001'),
  state: 'authenticated',
  tenants: { items: [], state: 'available' },
});
