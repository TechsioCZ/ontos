import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { Cause, DateTime, Effect, Schema } from 'effect';

import { auditEvents, principalAuthBindings, principals } from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import { defineSystemModuleEntrypoint } from '../modules/module-entrypoint.ts';
import { OperationContextUnavailable } from '../operations/errors.ts';
import type { OperationalScope } from '../operations/context.ts';
import { defineRead } from '../reads/definition.ts';
import { validateManagedApiKeyTarget } from './managed-api-key-scope.ts';
import { ReadHandlerUnavailable } from '../reads/errors.ts';
import { isTrustedSystemPrincipalContext } from './system-principal-context-provenance.ts';

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
  authBindingId: Schema.optionalKey(AuthBindingIdSchema),
  createdAt: Schema.optionalKey(Schema.DateTimeUtc),
  revokedAt: Schema.optionalKey(Schema.OptionFromNullOr(Schema.DateTimeUtc)),
  status: Schema.optionalKey(BindingStatusSchema),
});
const PaginationInput = Schema.Struct(paginationInput);
/**
 * The tenant-managed key list names no company: it runs in the tenant context and is decided by the
 * tenant's own identity administration (O7, O12). A company administrator has no tenant context, so
 * this input is deliberately a separate carrier from the company-agent one below.
 */
const TenantManagedInput = Schema.Struct({ ...paginationInput, scope: Schema.Literal('tenant-managed') });
/**
 * The company-agent key list names exactly one agent inside exactly one company (O28): it runs in that
 * company's context, where its own access administrator holds the power, and never in the tenant's.
 */
const CompanyAgentInput = Schema.Struct({
  ...paginationInput,
  principalId: PrincipalIdSchema,
  scope: Schema.Literal('company-agent'),
});
const ManagedInput = Schema.Union([TenantManagedInput, CompanyAgentInput]);
const SelfResult = Schema.Struct({
  items: Schema.Array(bindingMetadata),
  nextOffset: Schema.OptionFromNullOr(Schema.Finite),
});
const ManagedItem = Schema.Struct({
  authBindingId: Schema.optionalKey(Schema.OptionFromNullOr(AuthBindingIdSchema)),
  bindingCreatedAt: Schema.optionalKey(Schema.OptionFromNullOr(Schema.DateTimeUtc)),
  bindingRevokedAt: Schema.optionalKey(Schema.OptionFromNullOr(Schema.DateTimeUtc)),
  bindingStatus: Schema.optionalKey(Schema.OptionFromNullOr(BindingStatusSchema)),
  displayName: Schema.optionalKey(Schema.String),
  kind: Schema.Literals(['service', 'integration', 'agent']),
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
  const error = new ReadHandlerUnavailable({
    code: 'read_handler_unavailable',
    reason,
  });
  Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  return error;
};

interface IdentityReadServices {
  readonly listManaged: (
    input: typeof ManagedInput.Type,
  ) => Effect.Effect<Schema.Schema.Type<typeof ManagedResult>, ReadHandlerUnavailable>;
  readonly listSelf: (input: {
    readonly limit: number;
    readonly offset: number;
  }) => Effect.Effect<Schema.Schema.Type<typeof SelfResult>, ReadHandlerUnavailable>;
}

const services = (
  transaction: ScopedTransactionExecutor,
  tenantId: string,
  principalId: string,
  authenticationNamespaceId?: string,
  legalEntityId?: string,
): IdentityReadServices => ({
  listManaged: Effect.fn('ManagedPrincipalsRead.listManaged')(function* listManaged(input: typeof ManagedInput.Type) {
    const { limit, offset } = input;
    if (input.scope === 'company-agent') {
      yield* validateManagedApiKeyTarget(transaction, { ...input, legalEntityId, tenantId }).pipe(
        Effect.mapError((cause) => readUnavailable('The company agent key target is unavailable', cause)),
      );
    }
    return yield* transaction
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
          ...(authenticationNamespaceId === undefined
            ? []
            : [eq(principalAuthBindings.authenticationNamespaceId, authenticationNamespaceId)]),
          eq(principalAuthBindings.subjectType, 'api_key'),
          or(eq(principalAuthBindings.status, 'active'), eq(principalAuthBindings.status, 'disabled')),
          ...(input.scope === 'company-agent'
            ? [
                sql`exists (select 1 from ${auditEvents} where
            ${auditEvents.tenantId} = ${principalAuthBindings.tenantId}
            and ${auditEvents.actionInvocationId} = ${principalAuthBindings.createdByInvocationId}
            and ${auditEvents.legalEntityId} = ${legalEntityId}
            and ${auditEvents.eventType} = 'action.executed' and ${auditEvents.outcome} = 'succeeded'
            and ${auditEvents.evidenceJson}->>'actionKey' = 'core.identity.bind-managed-api-key')`,
              ]
            : []),
        ),
      )
      .where(
        and(
          eq(principals.tenantId, tenantId),
          input.scope === 'company-agent'
            ? and(eq(principals.kind, 'agent'), eq(principals.principalId, input.principalId))
            : or(eq(principals.kind, 'service'), eq(principals.kind, 'integration')),
          // The platform's own principals and their keys are the platform's to manage, not a tenant administrator's.
          isNull(principals.platformRole),
        ),
      )
      .orderBy(asc(principals.displayName), asc(principals.principalId), asc(principalAuthBindings.createdAt))
      .limit(limit + 1)
      .offset(offset)
      .pipe(
        Effect.mapError((cause) => readUnavailable('Managed identities are temporarily unavailable', cause)),
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
            (
              row,
            ): row is typeof row & {
              readonly kind: 'agent' | 'integration' | 'service';
            } => row.kind === 'service' || row.kind === 'integration' || row.kind === 'agent',
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
          Schema.decodeEffect(ManagedResultJson)(result).pipe(
            Effect.mapError((cause) => readUnavailable('Managed identities are temporarily unavailable', cause)),
          ),
        ),
      );
  }),
  listSelf: ({ limit, offset }) =>
    authenticationNamespaceId === undefined
      ? Effect.fail(
          readUnavailable(
            'Identity bindings are temporarily unavailable',
            new Cause.IllegalArgumentError('An authentication namespace is required for self API-key reads'),
          ),
        )
      : transaction
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
              eq(principalAuthBindings.authenticationNamespaceId, authenticationNamespaceId),
              eq(principalAuthBindings.subjectType, 'api_key'),
            ),
          )
          .orderBy(asc(principalAuthBindings.createdAt), asc(principalAuthBindings.principalAuthBindingId))
          .limit(limit + 1)
          .offset(offset)
          .pipe(
            Effect.mapError((cause) => readUnavailable('Identity bindings are temporarily unavailable', cause)),
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
                revokedAt: row.revokedAt === null ? null : DateTime.formatIso(DateTime.fromDateUnsafe(row.revokedAt)),
              })),
              nextOffset: rows.length > limit ? offset + limit : null,
            })),
            Effect.flatMap((result) =>
              Schema.decodeEffect(SelfResultJson)(result).pipe(
                Effect.mapError((cause) => readUnavailable('Identity bindings are temporarily unavailable', cause)),
              ),
            ),
          ),
});

export const selfApiKeyBindingsRead = defineRead<
  typeof PaginationInput,
  typeof SelfResult,
  'core.identity',
  IdentityReadServices,
  ReadHandlerUnavailable,
  never
>(
  {
    accessDeclaration: {
      key: 'core.identity.self-api-key.list',
      kind: 'admin',
      modes: ['run'],
      placement: { group: 'identity', level: 'manage' },
      risk: 'sensitive',
      selectors: [],
    },
    // Credential linkage/status metadata is security-sensitive (O58): the parent admin read decides
    // the record, and this group governs the authentication-metadata fields of its list.
    accessFieldGroups: [
      {
        fieldClass: 'authentication_metadata',
        fields: ['items.authBindingId', 'items.createdAt', 'items.revokedAt', 'items.status'],
        key: 'core.identity.self-api-key.read-authentication-metadata',
        kind: 'field_read',
        modes: ['run'],
        placement: { group: 'identity', level: 'manage' },
        risk: 'sensitive',
        selectors: [],
      },
    ],
    accessKind: 'list',
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'protected' },
      entrypointKey: 'core.identity.self-api-key-bindings',
      moduleKey: 'core.identity',
      role: 'api',
    }),
    evidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'core.identity.self-api-key-bindings.access.v1',
    },
    inputSchema: PaginationInput,
    legalEntityScope: 'optional',
    owningModuleKey: 'core.identity',
    policies: [],
    readKey: 'core.identity.self-api-key-bindings',
    resultSchema: SelfResult,
    schemaVersion: '1',
  },
  {
    load: (input, context) =>
      context.services.listSelf(input).pipe(
        Effect.map((result) => ({
          evidence: { resultCount: result.items.length },
          result,
        })),
      ),
  },
  (transaction, scope) =>
    scope.authenticationNamespaceId === undefined
      ? Effect.fail(
          new OperationContextUnavailable({
            code: 'operation_context_unavailable',
            reason: 'The authenticated identity namespace is unavailable',
          }),
        )
      : Effect.succeed(services(transaction, scope.tenantId, scope.principalId, scope.authenticationNamespaceId)),
);

/**
 * The one owner-side service factory both managed-key reads share. `scope.authMethod === 'system'`
 * runs under the trusted system identity with no authentication namespace; every other caller must
 * carry the namespace of the session or key that authenticated it.
 */
const managedReadServices = (transaction: ScopedTransactionExecutor, scope: OperationalScope) => {
  if (scope.authMethod === 'system') {
    return isTrustedSystemPrincipalContext(scope)
      ? Effect.succeed(services(transaction, scope.tenantId, scope.principalId, undefined, scope.legalEntityId))
      : Effect.fail(
          new OperationContextUnavailable({
            code: 'operation_context_unavailable',
            reason: 'The trusted system identity context is unavailable',
          }),
        );
  }
  if (scope.authenticationNamespaceId === undefined) {
    return Effect.fail(
      new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'The authenticated identity namespace is unavailable',
      }),
    );
  }
  return Effect.succeed(
    services(transaction, scope.tenantId, scope.principalId, scope.authenticationNamespaceId, scope.legalEntityId),
  );
};

/** The field groups both managed-key lists declare, with the exact keys their own declaration owns. */
const managedAccessFieldGroups = (keyPrefix: string) =>
  [
    {
      fieldClass: 'personal_data',
      fields: ['items.displayName'],
      key: `${keyPrefix}.read-personal-data`,
      kind: 'field_read',
      modes: ['run'],
      placement: { group: 'identity', level: 'manage' },
      risk: 'sensitive',
      selectors: [],
    },
    {
      fieldClass: 'authentication_metadata',
      fields: ['items.authBindingId', 'items.bindingCreatedAt', 'items.bindingRevokedAt', 'items.bindingStatus'],
      key: `${keyPrefix}.read-authentication-metadata`,
      kind: 'field_read',
      modes: ['run'],
      placement: { group: 'identity', level: 'manage' },
      risk: 'sensitive',
      selectors: [],
    },
  ] as const;

/**
 * Tenant-managed keys: `legalEntityScope: 'optional'` means the gate decides in the tenant context
 * (O7, O12), so only the tenant's own identity administration may read this list.
 */
export const managedPrincipalsRead = defineRead<
  typeof TenantManagedInput,
  typeof ManagedResult,
  'core.identity',
  IdentityReadServices,
  ReadHandlerUnavailable,
  never
>(
  {
    accessDeclaration: {
      key: 'core.identity.principal.list-managed',
      kind: 'admin',
      modes: ['run'],
      placement: { group: 'identity', level: 'manage' },
      risk: 'sensitive',
      selectors: [],
    },
    // Human principal names are personal data and the credential linkage/status metadata is
    // security-sensitive (O58); each is its own group over this managed-principal list.
    accessFieldGroups: managedAccessFieldGroups('core.identity.principal'),
    accessKind: 'list',
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'protected' },
      entrypointKey: 'core.identity.managed-principals',
      moduleKey: 'core.identity',
      role: 'api',
    }),
    evidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'core.identity.managed-principals.access.v1',
    },
    inputSchema: TenantManagedInput,
    legalEntityScope: 'optional',
    owningModuleKey: 'core.identity',
    policies: [],
    readKey: 'core.identity.managed-principals',
    resultSchema: ManagedResult,
    schemaVersion: '1',
  },
  {
    load: (input, context) =>
      context.services.listManaged(input).pipe(
        Effect.map((result) => ({
          evidence: { resultCount: result.items.length },
          result,
        })),
      ),
  },
  managedReadServices,
);

/**
 * Company-agent keys: `legalEntityScope: 'required'` means the gate decides in the exact named
 * company (O28), so that company's own access administrator may read its agent's keys while a
 * different company's administrator and the tenant-only path may not. The owner implementation is
 * the same one; only the declared carrier and its scope differ.
 */
export const companyManagedPrincipalsRead = defineRead<
  typeof CompanyAgentInput,
  typeof ManagedResult,
  'core.identity',
  IdentityReadServices,
  ReadHandlerUnavailable,
  never
>(
  {
    accessDeclaration: {
      key: 'core.identity.company-agent-key.list-managed',
      kind: 'admin',
      modes: ['run'],
      placement: { group: 'identity', level: 'manage' },
      risk: 'sensitive',
      selectors: [],
    },
    accessFieldGroups: managedAccessFieldGroups('core.identity.company-agent-key'),
    accessKind: 'list',
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'protected' },
      entrypointKey: 'core.identity.company-managed-principals',
      moduleKey: 'core.identity',
      role: 'api',
    }),
    evidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'core.identity.company-managed-principals.access.v1',
    },
    inputSchema: CompanyAgentInput,
    legalEntityScope: 'required',
    owningModuleKey: 'core.identity',
    policies: [],
    readKey: 'core.identity.company-managed-principals',
    resultSchema: ManagedResult,
    schemaVersion: '1',
  },
  {
    load: (input, context) =>
      context.services.listManaged(input).pipe(
        Effect.map((result) => ({
          evidence: { resultCount: result.items.length },
          result,
        })),
      ),
  },
  managedReadServices,
);
