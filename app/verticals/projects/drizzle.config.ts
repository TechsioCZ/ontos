// @effect-diagnostics processEnv:off
import { APP_ENV_PATH } from '@app/core-runtime/workspace-environment';
import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

const dotenvResult = loadDotenv({
  path: APP_ENV_PATH,
  quiet: true,
});
const dotenvErrorCode: string | undefined = dotenvResult.error?.code;

if (
  dotenvResult.error !== undefined &&
  dotenvErrorCode !== 'ENOENT' &&
  dotenvErrorCode !== 'NOT_FOUND_DOTENV_ENVIRONMENT'
) {
  throw dotenvResult.error;
}

const databaseUrl = process.env['DATABASE_ADMIN_URL']?.trim();

if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error(`DATABASE_ADMIN_URL is required in ${APP_ENV_PATH} or the process environment`);
}

export default defineConfig({
  dbCredentials: {
    url: databaseUrl,
  },
  dialect: 'postgresql',
  migrations: {
    schema: 'drizzle',
    table: '__drizzle_migrations_projects',
  },
  out: './drizzle',
  schema: './src/db/schema.ts',
  strict: true,
  verbose: true,
});
