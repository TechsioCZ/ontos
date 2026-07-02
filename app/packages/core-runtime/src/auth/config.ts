// @effect-diagnostics processEnv:off
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { authTables } from '../db/auth-schema.ts';
import { db } from '../db/client.ts';

const baseUrl = process.env['BETTER_AUTH_URL']?.trim() || 'http://localhost:3020';
const secret = process.env['BETTER_AUTH_SECRET']?.trim() || 'app-local-better-auth-secret-32-bytes';

export const auth = betterAuth({
  basePath: '/shell-super-app-api/auth',
  baseURL: baseUrl,
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: authTables,
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },
  secret,
  trustedOrigins: [baseUrl],
});
