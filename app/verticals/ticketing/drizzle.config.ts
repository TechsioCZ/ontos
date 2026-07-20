// @effect-diagnostics processEnv:off
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://ontos:ontos@localhost:5435/ontos_app',
  },
  dialect: 'postgresql',
  migrations: {
    schema: 'drizzle_ticketing',
    table: '__drizzle_migrations',
  },
  out: './drizzle',
  schema: './src/db/schema.ts',
  strict: true,
  verbose: true,
});
