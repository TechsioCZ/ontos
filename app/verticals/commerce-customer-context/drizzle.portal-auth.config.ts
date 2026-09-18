// oxlint-disable-next-line github/filenames-match-regex -- Drizzle Kit requires this provider-specific config filename; expires: 2027-03-01.
import { defineConfig } from 'drizzle-kit';
import { Redacted } from 'effect';

import { readCommercePortalAuthDatabaseAdminUrlForDrizzle } from './scripts/portal-auth-database-config.mts';

export default defineConfig({
  dbCredentials: {
    url: Redacted.value(readCommercePortalAuthDatabaseAdminUrlForDrizzle()),
  },
  dialect: 'postgresql',
  migrations: {
    schema: 'drizzle',
    table: '__drizzle_migrations_commerce_portal_auth',
  },
  out: './drizzle-portal-auth',
  schema: './src/portal-auth/persistence/portal-auth-tables.ts',
});
