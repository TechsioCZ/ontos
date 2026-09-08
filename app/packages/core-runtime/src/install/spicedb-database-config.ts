import { Redacted, Result, Schema } from 'effect';

export interface SpiceDbDatabaseBootstrapEnvironment {
  readonly DATABASE_ADMIN_URL?: string;
  readonly SPICEDB_DATABASE_URL?: string;
}

const requiredEnvironmentValue = Schema.Trim.check(Schema.isMinLength(1));

const SpiceDbDatabaseBootstrapEnvironmentSchema = Schema.Struct({
  DATABASE_ADMIN_URL: requiredEnvironmentValue,
  SPICEDB_DATABASE_URL: requiredEnvironmentValue,
});

const PostgreSqlUrlSchema = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    url.protocol === 'postgres:' || url.protocol === 'postgresql:'
      ? undefined
      : 'URL must use PostgreSQL'
  )
);

const PercentEncodedUriComponentSchema = Schema.String.check(
  Schema.makeFilter((value) => {
    let issue: string | undefined;
    try {
      decodeURIComponent(value);
    } catch {
      issue = 'URL credentials must use valid percent encoding';
    }
    return issue;
  })
);

const SpiceDbDatabasePairSchema = Schema.Struct({
  admin: Schema.URL,
  spicedb: Schema.URL,
  spicedbUser: Schema.String,
}).check(
  Schema.makeFilter(({ admin, spicedb, spicedbUser }) => {
    if (spicedb.hostname !== admin.hostname || spicedb.port !== admin.port) {
      return 'SPICEDB_DATABASE_URL must target the administrative PostgreSQL service';
    }
    if (spicedbUser !== 'spicedb' || spicedb.pathname !== '/spicedb') {
      return 'SPICEDB_DATABASE_URL must use the spicedb login and database';
    }
    if (spicedb.password.length === 0) {
      return 'SPICEDB_DATABASE_URL must contain the spicedb password';
    }
    return admin.href === spicedb.href || admin.username === spicedb.username
      ? 'Administrative and SpiceDB PostgreSQL identities must be distinct'
      : undefined;
  })
);

const makeSpiceDbDatabaseBootstrapConfig = (fields: {
  readonly adminUrl: string;
  readonly password: Redacted.Redacted;
}) =>
  Object.freeze({
    adminUrl: fields.adminUrl,
    database: 'spicedb' as const,
    get password() {
      return Redacted.value(fields.password);
    },
    user: 'spicedb' as const,
  });

export type SpiceDbDatabaseBootstrapConfig = ReturnType<
  typeof makeSpiceDbDatabaseBootstrapConfig
>;

export const parseSpiceDbDatabaseBootstrapConfig = (
  environment: SpiceDbDatabaseBootstrapEnvironment
): SpiceDbDatabaseBootstrapConfig => {
  const source = Result.getOrThrow(
    Schema.decodeUnknownResult(SpiceDbDatabaseBootstrapEnvironmentSchema)(
      environment
    )
  );
  const admin = Result.getOrThrow(
    Schema.decodeResult(PostgreSqlUrlSchema)(source.DATABASE_ADMIN_URL)
  );
  const spicedb = Result.getOrThrow(
    Schema.decodeResult(PostgreSqlUrlSchema)(source.SPICEDB_DATABASE_URL)
  );
  const pair = Result.getOrThrow(
    Schema.decodeResult(SpiceDbDatabasePairSchema)({
      admin,
      spicedb,
      spicedbUser: decodeURIComponent(
        Result.getOrThrow(
          Schema.decodeResult(PercentEncodedUriComponentSchema)(
            spicedb.username
          )
        )
      ),
    })
  );
  const encodedPassword = Result.getOrThrow(
    Schema.decodeResult(PercentEncodedUriComponentSchema)(pair.spicedb.password)
  );

  return makeSpiceDbDatabaseBootstrapConfig({
    adminUrl: pair.admin.href,
    password: Redacted.make(decodeURIComponent(encodedPassword)),
  });
};
