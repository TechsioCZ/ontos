import { and, asc, eq, or } from 'drizzle-orm';
import { Cause, DateTime, Effect, Schema } from 'effect';
import { principalAuthBindings, principals } from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import { defineSystemModuleEntrypoint } from '../modules/module-entrypoint.ts';
import { defineRead } from '../reads/definition.ts';
import { ReadHandlerUnavailable } from '../reads/errors.ts';

const uuid = Schema.String.check(Schema.isUUID());
const AuthBindingIdSchema = uuid.pipe(Schema.brand('AuthBindingId'));
const PrincipalIdSchema = uuid.pipe(Schema.brand('PrincipalId'));
const BindingStatusSchema = Schema.Literals(['active', 'disabled', 'revoked']);
const databaseReadTimeout = '30 seconds';
const paginationInput = {
  limit: Schema.Finite.check(Schema.isInt(), Schema.isBetween({ maximum: 100, minimum: 1 })),
  offset: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
};
const bindingMetadata = Schema.Struct({
  authBindingId: AuthBindingIdSchema,
  createdAt: Schema.DateTimeUtc,
  revokedAt: Schema.OptionFromNullOr(Schema.DateTimeUtc),
  status: BindingStatusSchema,
});
const SelfInput = Schema.Struct(paginationInput);
const SelfResult = Schema.Struct({
  items: Schema.Array(bindingMetadata),
  nextOffset: Schema.OptionFromNullOr(Schema.Finite),
});
const ManagedInput = Schema.Struct(paginationInput);
const ManagedItem = Schema.Struct({
  authBindingId: Schema.OptionFromNullOr(AuthBindingIdSchema),
  bindingCreatedAt: Schema.OptionFromNullOr(Schema.DateTimeUtc),
  bindingRevokedAt: Schema.OptionFromNullOr(Schema.DateTimeUtc),
  bindingStatus: Schema.OptionFromNullOr(BindingStatusSchema),
  displayName: Schema.String,
  kind: Schema.Literals(['service', 'integration']),
  principalId: PrincipalIdSchema,
  principalStatus: Schema.Literals(['active', 'disabled', 'archived']),
});
const ManagedResult = Schema.Struct({
  items: Schema.Array(ManagedItem),
  nextOffset: Schema.OptionFromNullOr(Schema.Finite),
});
const SelfResultJson = Schema.toCodecJson(SelfResult);
const ManagedResultJson = Schema.toCodecJson(ManagedResult);

const readUnavailable = (reason: string, cause: unknown): ReadHandlerUnavailable => {
  const error = new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason });
  Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  return error;
};

interface IdentityReadServices {
  readonly listManaged: (input: {
    readonly limit: number;
    readonly offset: number;
  }) => Effect.Effect<Schema.Schema.Type<typeof ManagedResult>, ReadHandlerUnavailable>;
  readonly listSelf: (input: {
    readonly limit: number;
    readonly offset: number;
  }) => Effect.Effect<Schema.Schema.Type<typeof SelfResult>, ReadHandlerUnavailable>;
}

const services = (
  transaction: ScopedTransactionExecutor,
  tenantId: string,
  principalId: string,
): IdentityReadServices => ({
  listManaged: ({ limit, offset }) =>
    Effect.tryPromise({
      catch: (cause) => readUnavailable('Managed identities are temporarily unavailable', cause),
      try: () =>
        transaction
          .select({
            authBindingId: principalAuthBindings.principalAuthBindingId,
            bindingCreatedAt: principalAuthBindings.createdAt,
            bindingRevokedAt: principalAuthBindings.revokedAt,
            bindingStatus: principalAuthBindings.status,
            displayName: principals.displayName,
            kind: principals.kind,
            principalId: principals.principalId,
            principalStatus: principals.status,
          })
          .from(principals)
          .leftJoin(
            principalAuthBindings,
            and(
              eq(principalAuthBindings.tenantId, principals.tenantId),
              eq(principalAuthBindings.principalId, principals.principalId),
              eq(principalAuthBindings.subjectType, 'api_key'),
            ),
          )
          .where(
            and(
              eq(principals.tenantId, tenantId),
              or(eq(principals.kind, 'service'), eq(principals.kind, 'integration')),
            ),
          )
          .orderBy(
            asc(principals.displayName),
            asc(principals.principalId),
            asc(principalAuthBindings.createdAt),
          )
          .limit(limit + 1)
          .offset(offset),
    }).pipe(
      Effect.timeoutOrElse({
        duration: databaseReadTimeout,
        orElse: () =>
          Effect.fail(
            readUnavailable(
              'Managed identities are temporarily unavailable',
              new Cause.TimeoutError('Database read timed out'),
            ),
          ),
      }),
      Effect.map((rows) => {
        const eligible = rows.filter(
          (row): row is typeof row & { readonly kind: 'integration' | 'service' } =>
            row.kind === 'service' || row.kind === 'integration',
        );
        return {
          items: eligible.slice(0, limit).map((row) => ({
            ...row,
            bindingCreatedAt:
              row.bindingCreatedAt === null
                ? null
                : DateTime.formatIso(DateTime.fromDateUnsafe(row.bindingCreatedAt)),
            bindingRevokedAt:
              row.bindingRevokedAt === null
                ? null
                : DateTime.formatIso(DateTime.fromDateUnsafe(row.bindingRevokedAt)),
            kind: row.kind,
          })),
          nextOffset: rows.length > limit ? offset + limit : null,
        };
      }),
      Effect.flatMap((result) =>
        Schema.decodeUnknownEffect(ManagedResultJson)(result).pipe(
          Effect.mapError((cause) =>
            readUnavailable('Managed identities are temporarily unavailable', cause),
          ),
        ),
      ),
    ),
  listSelf: ({ limit, offset }) =>
    Effect.tryPromise({
      catch: (cause) => readUnavailable('Identity bindings are temporarily unavailable', cause),
      try: () =>
        transaction
          .select({
            authBindingId: principalAuthBindings.principalAuthBindingId,
            createdAt: principalAuthBindings.createdAt,
            revokedAt: principalAuthBindings.revokedAt,
            status: principalAuthBindings.status,
          })
          .from(principalAuthBindings)
          .where(
            and(
              eq(principalAuthBindings.tenantId, tenantId),
              eq(principalAuthBindings.principalId, principalId),
              eq(principalAuthBindings.subjectType, 'api_key'),
            ),
          )
          .orderBy(
            asc(principalAuthBindings.createdAt),
            asc(principalAuthBindings.principalAuthBindingId),
          )
          .limit(limit + 1)
          .offset(offset),
    }).pipe(
      Effect.timeoutOrElse({
        duration: databaseReadTimeout,
        orElse: () =>
          Effect.fail(
            readUnavailable(
              'Identity bindings are temporarily unavailable',
              new Cause.TimeoutError('Database read timed out'),
            ),
          ),
      }),
      Effect.map((rows) => ({
        items: rows.slice(0, limit).map((row) => ({
          ...row,
          createdAt: DateTime.formatIso(DateTime.fromDateUnsafe(row.createdAt)),
          revokedAt:
            row.revokedAt === null
              ? null
              : DateTime.formatIso(DateTime.fromDateUnsafe(row.revokedAt)),
        })),
        nextOffset: rows.length > limit ? offset + limit : null,
      })),
      Effect.flatMap((result) =>
        Schema.decodeUnknownEffect(SelfResultJson)(result).pipe(
          Effect.mapError((cause) =>
            readUnavailable('Identity bindings are temporarily unavailable', cause),
          ),
        ),
      ),
    ),
});

export const selfApiKeyBindingsRead = defineRead<
  typeof SelfInput,
  typeof SelfResult,
  'core.identity',
  IdentityReadServices,
  ReadHandlerUnavailable,
  never
>(
  {
    accessKind: 'list',
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'context_permission', permission: 'module.access' },
      entrypointKey: 'core.identity.self-api-key-bindings',
      moduleKey: 'core.identity',
      role: 'api',
    }),
    evidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'core.identity.self-api-key-bindings.access.v1',
    },
    inputSchema: SelfInput,
    legalEntityScope: 'optional',
    owningModuleKey: 'core.identity',
    permissionTarget: 'tenant',
    policies: [],
    readKey: 'core.identity.self-api-key-bindings',
    resultSchema: SelfResult,
    schemaVersion: '1',
  },
  (input, context) =>
    context.services
      .listSelf(input)
      .pipe(Effect.map((result) => ({ evidence: { resultCount: result.items.length }, result }))),
  (transaction, scope) => Effect.succeed(services(transaction, scope.tenantId, scope.principalId)),
  () => ({ kind: 'tenant', permission: 'access' }),
);

export const managedPrincipalsRead = defineRead<
  typeof ManagedInput,
  typeof ManagedResult,
  'core.identity',
  IdentityReadServices,
  ReadHandlerUnavailable,
  never
>(
  {
    accessKind: 'list',
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'context_permission', permission: 'module.access' },
      entrypointKey: 'core.identity.managed-principals',
      moduleKey: 'core.identity',
      role: 'api',
    }),
    evidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'core.identity.managed-principals.access.v1',
    },
    inputSchema: ManagedInput,
    legalEntityScope: 'optional',
    owningModuleKey: 'core.identity',
    permissionTarget: 'tenant',
    policies: [],
    readKey: 'core.identity.managed-principals',
    resultSchema: ManagedResult,
    schemaVersion: '1',
  },
  (input, context) =>
    context.services
      .listManaged(input)
      .pipe(Effect.map((result) => ({ evidence: { resultCount: result.items.length }, result }))),
  (transaction, scope) => Effect.succeed(services(transaction, scope.tenantId, scope.principalId)),
  () => ({ kind: 'tenant', permission: 'manage_identity' }),
);
