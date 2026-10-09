import { Redacted, Result, Schema } from 'effect';

/**
 * SpiceDB's PostgreSQL datastore is structured configuration, never an externally supplied URL:
 * the `spicedb` login and database are fixed, they live on the administrative PostgreSQL server,
 * and only the password is a deployment secret. The SpiceDB service builds its own datastore URI
 * from these parts (`scripts/spicedb-datastore-uri.sh`), so it is valid for SpiceDB's Go parser by
 * construction instead of being checked against a copy of that parser.
 */
export interface SpiceDbDatabaseBootstrapEnvironment {
  readonly DATABASE_ADMIN_URL?: string;
  readonly SPICEDB_DATABASE_PASSWORD?: Redacted.Redacted;
}

const SpiceDbDatabaseBootstrapEnvironmentSchema = Schema.Struct({
  DATABASE_ADMIN_URL: Schema.Trim.check(Schema.isMinLength(1)),
  // A password is used byte for byte; it is never trimmed.
  SPICEDB_DATABASE_PASSWORD: Schema.Redacted(Schema.String.check(Schema.isMinLength(1))),
});

const PostgreSqlUrlSchema = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    url.protocol === 'postgres:' || url.protocol === 'postgresql:' ? undefined : 'URL must use PostgreSQL',
  ),
);

const SPICEDB_ROLE = 'spicedb' as const;

const AdministrativeUrlSchema = PostgreSqlUrlSchema.check(
  Schema.makeFilter((admin) =>
    admin.username === SPICEDB_ROLE ? 'Administrative and SpiceDB PostgreSQL identities must be distinct' : undefined,
  ),
);

const makeSpiceDbDatabaseBootstrapConfig = (fields: {
  readonly adminUrl: string;
  readonly password: Redacted.Redacted;
}) =>
  Object.freeze({
    adminUrl: fields.adminUrl,
    database: SPICEDB_ROLE,
    get password() {
      return Redacted.value(fields.password);
    },
    user: SPICEDB_ROLE,
  });

export type SpiceDbDatabaseBootstrapConfig = ReturnType<typeof makeSpiceDbDatabaseBootstrapConfig>;

export const parseSpiceDbDatabaseBootstrapConfig = (
  environment: SpiceDbDatabaseBootstrapEnvironment,
): SpiceDbDatabaseBootstrapConfig => {
  const source = Result.getOrThrow(Schema.decodeUnknownResult(SpiceDbDatabaseBootstrapEnvironmentSchema)(environment));
  const admin = Result.getOrThrow(Schema.decodeResult(AdministrativeUrlSchema)(source.DATABASE_ADMIN_URL));

  return makeSpiceDbDatabaseBootstrapConfig({
    adminUrl: admin.href,
    password: source.SPICEDB_DATABASE_PASSWORD,
  });
};
