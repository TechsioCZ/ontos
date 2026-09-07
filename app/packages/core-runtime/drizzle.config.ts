import { Redacted, Result, Schema } from 'effect';
import { defineConfig } from 'drizzle-kit';
import { APP_ENV_PATH } from './src/environment/workspace-environment.ts';

const nodeFileSystem = process.getBuiltinModule('node:fs');
const nodeProcess = process.getBuiltinModule('node:process');
const nodeUtilities = process.getBuiltinModule('node:util');
const fileConfig = nodeFileSystem.existsSync(APP_ENV_PATH)
  ? Result.getOrThrow(
      Result.try(() => nodeUtilities.parseEnv(nodeFileSystem.readFileSync(APP_ENV_PATH, 'utf-8'))),
    )
  : {};
const configValues = { ...fileConfig, ...nodeProcess.env };
const databaseUrl = Redacted.value(
  Result.getOrThrow(
    Schema.decodeUnknownResult(
      Schema.RedactedFromValue(Schema.Trim.pipe(Schema.check(Schema.isMinLength(1)))),
    )(configValues['DATABASE_ADMIN_URL']),
  ),
);

export default defineConfig({
  dbCredentials: {
    url: databaseUrl,
  },
  dialect: 'postgresql',
  migrations: {
    schema: 'drizzle',
    table: '__drizzle_migrations_core',
  },
  out: './drizzle',
  schema: './src/db/schema.ts',
  strict: true,
  verbose: true,
});
