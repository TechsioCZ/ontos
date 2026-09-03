// @effect-diagnostics asyncFunction:off
import { and, asc, eq, or } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import { principalAuthBindings, principals } from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import { defineSystemModuleEntrypoint } from '../modules/module-entrypoint.ts';
import { defineRead } from '../reads/definition.ts';
import { ReadHandlerUnavailable } from '../reads/errors.ts';

const uuid = Schema.String.check(Schema.isUUID());
const paginationInput = {
  limit: Schema.Finite.check(Schema.isInt(), Schema.isBetween({ maximum: 100, minimum: 1 })),
  offset: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
};
const bindingMetadata = Schema.Struct({
  authBindingId: uuid,
  createdAt: Schema.String,
  revokedAt: Schema.NullOr(Schema.String),
  status: Schema.Literals(['active', 'disabled', 'revoked']),
});
const SelfInput = Schema.Struct(paginationInput);
const SelfResult = Schema.Struct({
  items: Schema.Array(bindingMetadata),
  nextOffset: Schema.NullOr(Schema.Finite),
});
const ManagedInput = Schema.Struct(paginationInput);
const ManagedItem = Schema.Struct({
  authBindingId: Schema.NullOr(uuid),
  bindingCreatedAt: Schema.NullOr(Schema.String),
  bindingRevokedAt: Schema.NullOr(Schema.String),
  bindingStatus: Schema.NullOr(Schema.Literals(['active', 'disabled', 'revoked'])),
  displayName: Schema.String,
  kind: Schema.Literals(['service', 'integration']),
  principalId: uuid,
  principalStatus: Schema.Literals(['active', 'disabled', 'archived']),
});
const ManagedResult = Schema.Struct({
  items: Schema.Array(ManagedItem),
  nextOffset: Schema.NullOr(Schema.Finite),
});

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
      catch: () =>
        new ReadHandlerUnavailable({
          code: 'read_handler_unavailable',
          reason: 'Managed identities are temporarily unavailable',
        }),
      try: async () => {
        const rows = await transaction
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
          .offset(offset);
        const eligible = rows.filter(
          (row): row is typeof row & { readonly kind: 'integration' | 'service' } =>
            row.kind === 'service' || row.kind === 'integration',
        );
        return {
          items: eligible.slice(0, limit).map((row) => ({
            ...row,
            bindingCreatedAt: row.bindingCreatedAt?.toISOString() ?? null,
            bindingRevokedAt: row.bindingRevokedAt?.toISOString() ?? null,
            kind: row.kind,
          })),
          nextOffset: rows.length > limit ? offset + limit : null,
        };
      },
    }),
  listSelf: ({ limit, offset }) =>
    Effect.tryPromise({
      catch: () =>
        new ReadHandlerUnavailable({
          code: 'read_handler_unavailable',
          reason: 'Identity bindings are temporarily unavailable',
        }),
      try: async () => {
        const rows = await transaction
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
          .offset(offset);
        return {
          items: rows.slice(0, limit).map((row) => ({
            ...row,
            createdAt: row.createdAt.toISOString(),
            revokedAt: row.revokedAt?.toISOString() ?? null,
          })),
          nextOffset: rows.length > limit ? offset + limit : null,
        };
      },
    }),
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
