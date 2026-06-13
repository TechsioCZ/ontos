// @effect-diagnostics processEnv:off
import { betterAuth } from 'better-auth';
import { Pool } from 'pg';
import { readCoreRuntimeEnv } from '../env.ts';

const env = readCoreRuntimeEnv();

export const betterAuthConfig = {
  appName: 'OntOS MVP',
  baseURL: env.betterAuthUrl,
  database: new Pool({
    connectionString: env.databaseUrl,
    options: '-c search_path=auth,public',
  }),
  emailAndPassword: {
    enabled: true,
  },
  secret: env.betterAuthSecret,
} as unknown as Parameters<typeof betterAuth>[0];

export const auth = betterAuth(betterAuthConfig);

export default auth;
