// @effect-diagnostics processEnv:off
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as authSchema from './auth-schema.ts';
import * as coreSchema from './schema.ts';

const databaseUrl =
  process.env['DATABASE_URL']?.trim() || 'postgres://ontos:ontos@localhost:5435/ontos_app';

export const sqlClient = postgres(databaseUrl, {
  max: 1,
});

export const db = drizzle(sqlClient, {
  schema: {
    ...authSchema,
    ...coreSchema,
  },
});
