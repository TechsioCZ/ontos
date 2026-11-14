import { Effect, Redacted } from 'effect';

import type { CommerceTenantWorkloadCredentials } from '../../api/tenant-workload-credentials.ts';

/**
 * Test double for suites whose Tenants are random per test and whose Core identity client is stubbed: every Tenant
 * answers the same fixed test credential. Production selection (`makeCommerceTenantWorkloadCredentials`) never does.
 */
export const everyTenantTestCredentials = (key: string): CommerceTenantWorkloadCredentials => ({
  forTenant: () => Effect.succeed({ coreIdentityApiKey: Redacted.make(key), gatewayApiKey: Redacted.make(key) }),
  tenantIds: [],
});
