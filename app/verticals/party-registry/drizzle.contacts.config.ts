import { APP_ENV_PATH } from '@app/core-runtime/workspace-environment';
import { defineConfig } from 'drizzle-kit';
import { Redacted, Result, Schema } from 'effect';

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
      Schema.Redacted(Schema.Trim.pipe(Schema.check(Schema.isMinLength(1)))),
    )(configValues.DATABASE_ADMIN_URL),
  ),
);

export default defineConfig({
  dbCredentials: {
    url: databaseUrl,
  },
  dialect: 'postgresql',
  migrations: {
    schema: 'drizzle',
    table: '__drizzle_migrations_contacts',
  },
  out: './drizzle-contacts',
  schema: './src/db/engagement-schema.ts',
  strict: true,
  verbose: true,
});
