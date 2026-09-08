import { defineWorkspaceDrizzleConfig } from './src/environment/drizzle-config.ts';

export default defineWorkspaceDrizzleConfig({
  out: './drizzle',
  schema: './src/db/schema.ts',
  table: '__drizzle_migrations_core',
});
