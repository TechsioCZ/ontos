// @effect-diagnostics processEnv:off
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { readCoreRuntimeEnv } from '../env.ts';
import * as schema from './schema.ts';

export type CoreDb = ReturnType<typeof createCoreDb>;

export const createCoreDb = (databaseUrl = readCoreRuntimeEnv().databaseUrl) => {
  const sql = postgres(databaseUrl, {
    idle_timeout: 20,
    max: 5,
    prepare: false,
  });

  return drizzle(sql, { schema });
};

export const coreDb = createCoreDb();
