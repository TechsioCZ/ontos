import type { Config } from 'drizzle-kit';
import { defineWorkspaceDrizzleConfig } from '../../packages/core-runtime/src/environment/drizzle-config.ts';

const config: Config = defineWorkspaceDrizzleConfig({
  out: './drizzle-auth',
  schema: './api/auth/db/schema.ts',
  table: '__drizzle_migrations_auth',
});

export default config;
