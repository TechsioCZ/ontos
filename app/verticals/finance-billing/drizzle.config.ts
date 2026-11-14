import type { Config } from 'drizzle-kit';
import { defineWorkspaceDrizzleConfig } from '../../packages/core-runtime/src/environment/drizzle-config.ts';

const config: Config = defineWorkspaceDrizzleConfig({
  out: './drizzle',
  schema: './src/database/schema.ts',
  table: '__drizzle_migrations_finance_billing',
});

export default config;
