import { defineWorkspaceDrizzleConfig } from './src/environment/drizzle-config.ts';

export default defineWorkspaceDrizzleConfig({
  out: './drizzle',
  schema: '../../database/core-schema.cts',
  table: '__drizzle_migrations_core',
});
