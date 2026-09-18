import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Console, Effect, FileSystem, Function as Fn, Layer, Path, Redacted, Result, Schema } from 'effect';
import type { Scope } from 'effect';
import { Client } from 'pg';
import type { QueryResultRow } from 'pg';
import { Command, Flag } from 'effect/unstable/cli';

import {
  AuthBindingIdSchema,
  BindingSubjectTypeSchema,
  PrincipalIdSchema,
  ProviderSubjectIdSchema,
  TenantIdSchema,
} from '../src/auth/external-identity-contracts.ts';

const AUTH_NAMESPACE_INVENTORY_EXPORT_VERSION = 1 as const;
export const AUTH_NAMESPACE_INVENTORY_EXPORT_STATUS = 'unreviewed' as const;

const provider = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));

/** Rows contain only the Core binding tuple; namespace provenance remains a human review step. */
const AuthNamespaceInventoryExportEntrySchema = Schema.Struct({
  principalAuthBindingId: AuthBindingIdSchema,
  principalId: PrincipalIdSchema,
  provider,
  providerSubjectId: ProviderSubjectIdSchema,
  subjectType: BindingSubjectTypeSchema,
  tenantId: TenantIdSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

/** The marker and omitted review fields make this artifact intentionally incompatible with preparation. */
export const AuthNamespaceInventoryExportDocumentSchema = Schema.Struct({
  entries: Schema.Array(AuthNamespaceInventoryExportEntrySchema),
  reviewStatus: Schema.Literal(AUTH_NAMESPACE_INVENTORY_EXPORT_STATUS),
  version: Schema.Literal(AUTH_NAMESPACE_INVENTORY_EXPORT_VERSION),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

export type AuthNamespaceInventoryExportEntry = Schema.Schema.Type<typeof AuthNamespaceInventoryExportEntrySchema>;
export type AuthNamespaceInventoryExportDocument = Schema.Schema.Type<
  typeof AuthNamespaceInventoryExportDocumentSchema
>;

interface AuthNamespaceInventoryExportResult {
  readonly bindingCount: number;
  readonly outputPath: string;
}

const UNEXPECTED_AUTH_NAMESPACE_INVENTORY_EXPORT_FAILURE =
  'auth_namespace_inventory_export_failed: Unexpected exporter failure';

export class AuthNamespaceInventoryExportError extends Schema.TaggedError<AuthNamespaceInventoryExportError>()(
  'AuthNamespaceInventoryExportError',
  {
    cause: Schema.optionalKey(Schema.Unknown),
    code: Schema.Literals(['database_unavailable', 'inventory_invalid', 'output_exists', 'output_unavailable']),
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export const formatAuthNamespaceInventoryExportFailure = (error: AuthNamespaceInventoryExportError): string =>
  `${error.code}: ${error.reason}`;

const sanitizeAuthNamespaceInventoryExportFailure: <Failure>(error: Failure) => string = (error) =>
  Schema.is(AuthNamespaceInventoryExportError)(error)
    ? formatAuthNamespaceInventoryExportFailure(error)
    : UNEXPECTED_AUTH_NAMESPACE_INVENTORY_EXPORT_FAILURE;

/** Keep raw driver and filesystem causes inside the Effect failure while exposing only stable CLI text. */
export const runAuthNamespaceInventoryExportCli: <A, E, R>(
  program: Effect.Effect<A, E, R>,
) => Effect.Effect<A, string, R> = (program) =>
  program.pipe(
    Effect.mapError(sanitizeAuthNamespaceInventoryExportFailure),
    Effect.catchDefect(() => Effect.fail(UNEXPECTED_AUTH_NAMESPACE_INVENTORY_EXPORT_FAILURE)),
    Effect.tapError((message) => Console.error(message)),
  );

const failure = (
  code: AuthNamespaceInventoryExportError['code'],
  reason: string,
  cause?: unknown,
): AuthNamespaceInventoryExportError =>
  new AuthNamespaceInventoryExportError(
    cause === undefined
      ? { code, reason }
      : {
          cause,
          code,
          reason,
        },
  );

export interface CoreAuthBindingRow extends QueryResultRow {
  readonly principal_auth_binding_id: string;
  readonly principal_id: string;
  readonly provider: string;
  readonly provider_subject_id: string;
  readonly subject_type: string;
  readonly tenant_id: string;
}

export const CORE_AUTH_BINDINGS_EXPORT_QUERY = `
SELECT principal_auth_binding_id::text, tenant_id::text, principal_id::text, provider, subject_type,
       provider_subject_id
FROM core.principal_auth_bindings
ORDER BY principal_auth_binding_id`;

const rowToEntry = (row: CoreAuthBindingRow): AuthNamespaceInventoryExportEntry =>
  Result.getOrThrow(
    Schema.decodeUnknownResult(AuthNamespaceInventoryExportEntrySchema)({
      principalAuthBindingId: row.principal_auth_binding_id,
      principalId: row.principal_id,
      provider: row.provider,
      providerSubjectId: row.provider_subject_id,
      subjectType: row.subject_type,
      tenantId: row.tenant_id,
    }),
  );

/** Build the review artifact without inferring a namespace, evidence reference, provider, or subject. */
export const makeUnreviewedAuthNamespaceInventory = (
  rows: readonly CoreAuthBindingRow[],
): AuthNamespaceInventoryExportDocument => ({
  entries: rows
    .map(rowToEntry)
    .toSorted((left, right) => left.principalAuthBindingId.localeCompare(right.principalAuthBindingId)),
  reviewStatus: AUTH_NAMESPACE_INVENTORY_EXPORT_STATUS,
  version: AUTH_NAMESPACE_INVENTORY_EXPORT_VERSION,
});

export const encodeAuthNamespaceInventoryExport = (document: AuthNamespaceInventoryExportDocument) =>
  Schema.encodeEffect(Schema.fromJsonString(AuthNamespaceInventoryExportDocumentSchema, { space: 2 }))(document).pipe(
    Effect.map((source) => `${source}\n`),
    Effect.mapError((cause) =>
      failure('inventory_invalid', 'The namespace inventory review artifact could not be encoded', cause),
    ),
  );

const query: <Row extends QueryResultRow>(
  client: Client,
  text: string,
) => Effect.Effect<readonly Row[], AuthNamespaceInventoryExportError> = function query<Row extends QueryResultRow>(
  client: Client,
  text: string,
): Effect.Effect<readonly Row[], AuthNamespaceInventoryExportError> {
  return Effect.suspend(() =>
    Effect.tryPromise({
      catch: (cause) => failure('database_unavailable', 'The Core namespace binding database query failed', cause),
      try: Fn.constant(client.query<Row>(text)),
    }),
  ).pipe(Effect.map(({ rows }) => rows));
};

const acquireClient = (
  connectionString: Redacted.Redacted,
): Effect.Effect<Client, AuthNamespaceInventoryExportError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.suspend(() => {
      const client = new Client({ connectionString: Redacted.value(connectionString), statement_timeout: 30_000 });
      return Effect.tryPromise({
        catch: (cause) => failure('database_unavailable', 'The Core namespace binding database could not open', cause),
        try: Fn.constant(client.connect()),
      }).pipe(Effect.as(client));
    }),
    (client) =>
      Effect.suspend(() =>
        Effect.tryPromise({
          catch: (cause) =>
            failure('database_unavailable', 'The Core namespace binding database could not close', cause),
          try: Fn.constant(client.end()),
        }).pipe(Effect.orDie),
      ),
  );

const decodeRows = (rows: readonly CoreAuthBindingRow[]) =>
  Effect.forEach(
    rows,
    (row) =>
      Schema.decodeUnknownEffect(AuthNamespaceInventoryExportEntrySchema)({
        principalAuthBindingId: row.principal_auth_binding_id,
        principalId: row.principal_id,
        provider: row.provider,
        providerSubjectId: row.provider_subject_id,
        subjectType: row.subject_type,
        tenantId: row.tenant_id,
      }).pipe(
        Effect.mapError((cause) =>
          failure('inventory_invalid', 'The Core namespace binding database returned invalid binding data', cause),
        ),
      ),
    { concurrency: 1 },
  );

export interface WriteAuthNamespaceInventoryExportInput {
  readonly document: AuthNamespaceInventoryExportDocument;
  readonly outputPath: string;
}

export const writeAuthNamespaceInventoryExport = (
  input: WriteAuthNamespaceInventoryExportInput,
): Effect.Effect<void, AuthNamespaceInventoryExportError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* writeAuthNamespaceInventoryExportEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const exists = yield* fileSystem
      .exists(input.outputPath)
      .pipe(
        Effect.mapError((cause) =>
          failure('output_unavailable', 'The requested namespace inventory output could not be inspected', cause),
        ),
      );
    if (exists) {
      return yield* failure('output_exists', 'The requested namespace inventory output already exists');
    }

    const source = yield* encodeAuthNamespaceInventoryExport(input.document);
    yield* fileSystem
      .makeDirectory(path.dirname(input.outputPath), { mode: 0o700, recursive: true })
      .pipe(
        Effect.mapError((cause) =>
          failure(
            'output_unavailable',
            'The requested namespace inventory output directory could not be created',
            cause,
          ),
        ),
      );
    yield* fileSystem
      .writeFileString(input.outputPath, source, { flag: 'wx', mode: 0o600 })
      .pipe(
        Effect.mapError((cause) =>
          failure('output_unavailable', 'The requested namespace inventory output could not be written', cause),
        ),
      );
    return yield* Effect.void;
  });

interface ExportAuthNamespaceInventoryInput {
  readonly connectionString: Redacted.Redacted;
  readonly outputPath: string;
}

const exportAuthNamespaceInventory = (
  input: ExportAuthNamespaceInventoryInput,
): Effect.Effect<
  AuthNamespaceInventoryExportResult,
  AuthNamespaceInventoryExportError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* exportAuthNamespaceInventoryEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const outputExists = yield* fileSystem
      .exists(input.outputPath)
      .pipe(
        Effect.mapError((cause) =>
          failure('output_unavailable', 'The requested namespace inventory output could not be inspected', cause),
        ),
      );
    if (outputExists) {
      return yield* failure('output_exists', 'The requested namespace inventory output already exists');
    }

    const client = yield* acquireClient(input.connectionString);
    const rows = yield* query<CoreAuthBindingRow>(client, CORE_AUTH_BINDINGS_EXPORT_QUERY);
    yield* decodeRows(rows);
    const document = makeUnreviewedAuthNamespaceInventory(rows);
    yield* writeAuthNamespaceInventoryExport({ document, outputPath: input.outputPath });
    return {
      bindingCount: document.entries.length,
      outputPath: input.outputPath,
    };
  }).pipe(Effect.scoped);

const command = Command.make(
  'export-auth-namespace-inventory',
  {
    databaseUrl: Flag.string('database-url'),
    outputPath: Flag.string('output'),
  },
  ({ databaseUrl, outputPath }) =>
    exportAuthNamespaceInventory({ connectionString: Redacted.make(databaseUrl), outputPath }).pipe(
      Effect.tap((result) => Console.log(`Exported ${result.bindingCount} unreviewed Core authentication binding(s)`)),
      Effect.asVoid,
    ),
);

const main = command.pipe(Command.run({ version: '1.0.0' }), runAuthNamespaceInventoryExportCli);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(Layer.effectDiscard(main).pipe(Layer.provide(NodeServices.layer))).pipe(Effect.scoped),
    { disableErrorReporting: true },
  );
}
