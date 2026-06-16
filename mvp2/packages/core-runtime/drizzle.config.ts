// @effect-diagnostics processEnv:off
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://ontos:ontos@localhost:5433/ontos',
  },
  dialect: 'postgresql',
  out: './drizzle',
  schema: ['./src/db/schema.ts', './src/db/auth-schema.ts'],
  strict: true,
  verbose: true,
});
