import { defineWorkspaceDrizzleConfig } from '@app/core-runtime/drizzle-config';

export default defineWorkspaceDrizzleConfig({
  out: './drizzle',
  schema: './src/services/persistence-schema.service.ts',
  table: '__drizzle_migrations_promotion',
});
