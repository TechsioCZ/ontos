// @effect-diagnostics nodeBuiltinImport:off processEnv:off
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

const invocationRoot =
  process.env['ULTRAMODERN_WORKSPACE_ROOT'] ?? process.env['INIT_CWD'] ?? process.cwd();
const workspaceRoot = ['apps', 'packages', 'verticals'].includes(
  path.basename(path.dirname(invocationRoot)),
)
  ? path.resolve(invocationRoot, '../..')
  : invocationRoot;
const rootEnvironmentPath = path.resolve(workspaceRoot, '.env');
const dotenvResult = loadDotenv({
  path: rootEnvironmentPath,
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
  throw new Error(
    `DATABASE_ADMIN_URL is required in ${rootEnvironmentPath} or the process environment`,
  );
}

export default defineConfig({
  dbCredentials: {
    url: databaseUrl,
  },
  dialect: 'postgresql',
  migrations: {
    schema: 'drizzle',
    table: '__drizzle_migrations_crm',
  },
  out: './drizzle',
  schema: './src/db/schema.ts',
  strict: true,
  verbose: true,
});
