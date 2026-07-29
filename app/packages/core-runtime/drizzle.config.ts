// @effect-diagnostics processEnv:off
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

const rootEnvironmentPath = fileURLToPath(new URL('../../.env', import.meta.url));
const dotenvResult = loadDotenv({
  path: rootEnvironmentPath,
  quiet: true,
});

if (
  dotenvResult.error !== undefined &&
  dotenvResult.error.code !== 'NOT_FOUND_DOTENV_ENVIRONMENT'
) {
  throw dotenvResult.error;
}

const databaseUrl = process.env['DATABASE_URL']?.trim();

if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error(`DATABASE_URL is required in ${rootEnvironmentPath} or the process environment`);
}

export default defineConfig({
  dbCredentials: {
    url: databaseUrl,
  },
  dialect: 'postgresql',
  out: './drizzle',
  schema: './src/db/schema.ts',
  strict: true,
  verbose: true,
});
