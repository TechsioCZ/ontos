import type { Config } from 'drizzle-kit';
import { defineWorkspaceDrizzleConfig } from '@app/core-runtime/drizzle-config';

const config: Config = defineWorkspaceDrizzleConfig({
  out: './drizzle',
  schema: './src/services/persistence-schema.service.ts',
  table: '__drizzle_migrations_promotion',
});

export default config;
