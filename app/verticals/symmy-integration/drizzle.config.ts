import type { Config } from 'drizzle-kit';
import { defineWorkspaceDrizzleConfig } from '../../packages/core-runtime/src/environment/drizzle-config.ts';

const config: Config = defineWorkspaceDrizzleConfig({
  out: './drizzle',
  schema: './src/db/schema.ts',
  table: '__drizzle_migrations_symmy_integration',
});

export default config;
