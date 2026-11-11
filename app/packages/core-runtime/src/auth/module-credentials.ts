import { and, eq, isNull, like, sql } from 'drizzle-orm';
import { DateTime, Duration, Effect, Option, Schema } from 'effect';

import { stableUuid } from '../access/catalog/stable-id.ts';
import {
  applicationCompositionAuthority,
  auditEvents,
  principalAuthBindings,
  principals,
  tenants,
} from '../db/schema.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../db/types.ts';
import { ModuleAppIdSchema } from './hosted-module-credentials.ts';
import { ModuleCredentialUnavailableError } from './module-credential-unavailable-error.ts';
import { principalManagementRepositoryFromTransaction } from './principal-management.ts';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from './staff-authentication-namespace.ts';

export { ModuleCredentialUnavailableError } from './module-credential-unavailable-error.ts';

/**
 * The platform tenant. The platform creates it and nobody administers it: it has no person, membership, Role or
 * company, so no Action, grant or tenant-managed key can reach what it holds. It holds exactly one service
 * principal per calling module, and the module credentials the platform issues to those principals.
 */
export const PLATFORM_TENANT = Object.freeze({
  defaultLocale: 'cs',
  name: 'OntOS platform',
  slug: 'ontos-platform',
  tenantId: stableUuid('ontos.platform/tenant'),
});

const MODULE_PRINCIPAL_PREFIX = 'module:';

/** The display name that marks a platform tenant service principal as one module's credential holder. */
export const modulePrincipalDisplayName = (appId: string): string => `${MODULE_PRINCIPAL_PREFIX}${appId}`;

/** The module a platform tenant service principal holds credentials for, when its name marks one. */
export const moduleAppIdOf = (displayName: string): Option.Option<string> => {
  if (!displayName.startsWith(MODULE_PRINCIPAL_PREFIX)) {
    return Option.none();
  }
  const appId = displayName.slice(MODULE_PRINCIPAL_PREFIX.length);
  return Schema.is(ModuleAppIdSchema)(appId) ? Option.some(appId) : Option.none();
};

/** One active module credential: the module, its holder and the bound key's provider id. Never the key itself. */
export interface ModuleCredentialEnrolment {
  readonly appId: string;
  readonly authBindingId: string;
  /** When the binding was written, on the database clock; only an older credential is ever superseded. */
  readonly boundAt: Date;
  readonly principalId: string;
  readonly providerKeyId: string;
}

const DATABASE_OPERATION_TIMEOUT = Duration.seconds(30);

const unavailable = (reason: string) => (cause: unknown) => new ModuleCredentialUnavailableError({ cause, reason });

/**
 * Every active module credential the platform has bound: active API-key bindings of active service principals of the
 * platform tenant whose name marks a module. Bindings are derived from this enrolment, so it is the only place that
 * says which key belongs to which module.
 */
export const loadModuleCredentialEnrolment = Effect.fn('ModuleCredentials.loadEnrolment')(function* loadEnrolment(
  executor: Pick<CoreDatabaseExecutor, 'select'>,
) {
  const rows = yield* executor
    .select({
      authBindingId: principalAuthBindings.principalAuthBindingId,
      boundAt: principalAuthBindings.createdAt,
      displayName: principals.displayName,
      principalId: principals.principalId,
      providerKeyId: principalAuthBindings.providerSubjectId,
    })
    .from(principalAuthBindings)
    .innerJoin(
      principals,
      and(
        eq(principals.tenantId, principalAuthBindings.tenantId),
        eq(principals.principalId, principalAuthBindings.principalId),
      ),
    )
    .innerJoin(tenants, eq(tenants.tenantId, principals.tenantId))
    .where(
      and(
        eq(principalAuthBindings.tenantId, PLATFORM_TENANT.tenantId),
        eq(principalAuthBindings.authenticationNamespaceId, STAFF_AUTHENTICATION_NAMESPACE_ID),
        eq(principalAuthBindings.provider, 'better_auth'),
        eq(principalAuthBindings.subjectType, 'api_key'),
        eq(principalAuthBindings.status, 'active'),
        isNull(principalAuthBindings.revokedAt),
        eq(principals.kind, 'service'),
        eq(principals.status, 'active'),
        like(principals.displayName, `${MODULE_PRINCIPAL_PREFIX}%`),
        eq(tenants.status, 'active'),
      ),
    )
    .pipe(
      Effect.timeout(DATABASE_OPERATION_TIMEOUT),
      Effect.mapError(unavailable('The module credential enrolment could not be read')),
    );
  return rows.flatMap((row): ModuleCredentialEnrolment[] =>
    Option.match(moduleAppIdOf(row.displayName), {
      onNone: () => [],
      onSome: (appId) => [
        {
          appId,
          authBindingId: row.authBindingId,
          boundAt: row.boundAt,
          principalId: row.principalId,
          providerKeyId: row.providerKeyId,
        },
      ],
    }),
  );
});

type PlatformTransaction = Pick<CoreTransaction, 'insert' | 'select' | 'update'>;

/**
 * Creates the platform tenant once and proves that the row is the platform's own: the deterministic id must carry the
 * reserved slug and be active. A slug held by another tenant, or a disabled platform tenant, fails closed.
 */
export const ensurePlatformTenant = Effect.fn('ModuleCredentials.ensurePlatformTenant')(function* ensureTenant(
  transaction: PlatformTransaction,
) {
  yield* transaction
    .insert(tenants)
    .values({
      defaultLocale: PLATFORM_TENANT.defaultLocale,
      name: PLATFORM_TENANT.name,
      slug: PLATFORM_TENANT.slug,
      status: 'active',
      tenantId: PLATFORM_TENANT.tenantId,
    })
    .onConflictDoNothing()
    .pipe(Effect.mapError(unavailable('The platform tenant could not be created')));
  const [row] = yield* transaction
    .select({ slug: tenants.slug, status: tenants.status })
    .from(tenants)
    .where(eq(tenants.tenantId, PLATFORM_TENANT.tenantId))
    .limit(1)
    .pipe(Effect.mapError(unavailable('The platform tenant could not be read')));
  if (row === undefined || row.slug !== PLATFORM_TENANT.slug || row.status !== 'active') {
    return yield* new ModuleCredentialUnavailableError({
      reason: 'The platform tenant is missing, held under another slug or not active',
    });
  }
  return yield* Effect.void;
});

/**
 * The module's credential holder: the one active service principal the platform created for it, created through the
 * same writer `core.identity.create-non-human-principal` uses when it does not exist yet. Returns its principal id.
 */
export const ensureModulePrincipal = Effect.fn('ModuleCredentials.ensureModulePrincipal')(function* ensurePrincipal(
  transaction: PlatformTransaction,
  appId: string,
) {
  if (!Schema.is(ModuleAppIdSchema)(appId)) {
    return yield* new ModuleCredentialUnavailableError({ reason: 'A module credential needs a topology app id' });
  }
  const displayName = modulePrincipalDisplayName(appId);
  const existing = yield* transaction
    .select({ principalId: principals.principalId, status: principals.status })
    .from(principals)
    .where(
      and(
        eq(principals.tenantId, PLATFORM_TENANT.tenantId),
        eq(principals.kind, 'service'),
        eq(principals.displayName, displayName),
      ),
    )
    .orderBy(principals.createdAt, principals.principalId)
    .pipe(Effect.mapError(unavailable('The module principal could not be read')));
  const [current] = existing;
  if (current !== undefined) {
    if (current.status !== 'active') {
      return yield* new ModuleCredentialUnavailableError({ reason: `The module principal of ${appId} is not active` });
    }
    return current.principalId;
  }
  const repository = principalManagementRepositoryFromTransaction(transaction, STAFF_AUTHENTICATION_NAMESPACE_ID);
  const created = yield* repository
    .createNonHumanPrincipal({ displayName, kind: 'service', tenantId: PLATFORM_TENANT.tenantId })
    .pipe(Effect.mapError(unavailable(`The module principal of ${appId} could not be created`)));
  return created.principalId;
});

/** Binds a newly issued key to the module's principal, through the writer `core.identity.bind-managed-api-key` uses. */
export const bindModuleCredential = Effect.fn('ModuleCredentials.bind')(function* bind(
  transaction: PlatformTransaction,
  input: { readonly principalId: string; readonly providerKeyId: string },
) {
  const repository = principalManagementRepositoryFromTransaction(transaction, STAFF_AUTHENTICATION_NAMESPACE_ID);
  const bound = yield* repository
    .bindApiKey({
      managed: true,
      principalId: input.principalId,
      providerSubjectId: input.providerKeyId,
      tenantId: PLATFORM_TENANT.tenantId,
    })
    .pipe(Effect.mapError(unavailable('The module credential could not be bound')));
  return bound.authBindingId;
});

/** Revokes a superseded module credential's binding, through the API-key binding lifecycle writer. */
export const revokeModuleCredential = Effect.fn('ModuleCredentials.revoke')(function* revoke(
  transaction: PlatformTransaction,
  credential: Pick<ModuleCredentialEnrolment, 'authBindingId' | 'principalId'>,
) {
  const repository = principalManagementRepositoryFromTransaction(transaction, STAFF_AUTHENTICATION_NAMESPACE_ID);
  yield* repository
    .setApiKeyBindingStatus({
      authBindingId: credential.authBindingId,
      expectedStatus: 'active',
      managed: true,
      newStatus: 'revoked',
      principalId: credential.principalId,
      reason: 'Superseded by the module credential of a newer platform provisioning pass',
      tenantId: PLATFORM_TENANT.tenantId,
    })
    .pipe(Effect.mapError(unavailable('The superseded module credential could not be revoked')));
  return yield* Effect.void;
});

/** The authority row's revision and when that revision took the authority, if a release holds it. */
export const loadCompositionAuthorityActivation = Effect.fn('ModuleCredentials.loadAuthorityActivation')(
  function* loadAuthorityActivation(executor: Pick<CoreDatabaseExecutor, 'select'>) {
    const [authority] = yield* executor
      .select({
        phase: applicationCompositionAuthority.phase,
        revision: applicationCompositionAuthority.revision,
        revisionActivatedAt: applicationCompositionAuthority.revisionActivatedAt,
      })
      .from(applicationCompositionAuthority)
      .where(eq(applicationCompositionAuthority.authorityKey, 'active'))
      .limit(1)
      .pipe(
        Effect.timeout(DATABASE_OPERATION_TIMEOUT),
        Effect.mapError(unavailable('The application composition authority could not be read')),
      );
    return Option.fromNullishOr(authority);
  },
);

/** One module credential named in an audit row: the module and the key's provider id, never the key. */
export interface AuditedModuleCredential {
  readonly appId: string;
  readonly providerKeyId: string;
}

/** One issue or retire pass, as the platform tenant's audit records it. */
export interface ModuleCredentialPass {
  readonly compositionRevision: string;
  readonly credentials: readonly AuditedModuleCredential[];
  /** Retire passes only: the moment the host's revision took the authority, before which credentials are superseded. */
  readonly cutoff?: Date;
  readonly failed: readonly string[];
  readonly hostId: string;
  readonly kind: 'issued' | 'retired';
  readonly operationId: string;
  readonly outcome: 'denied' | 'failed' | 'succeeded';
  readonly outcomeCode: string;
  /** Issue passes only: keys that could not be bound and then could not be disabled either. */
  readonly undisabled?: readonly string[];
}

/**
 * Writes one system-actor audit row in the platform tenant for an issue or retire pass, as the authentication
 * observers do: the platform's own server scope, no invented principal, and no key material, only module ids and
 * provider key ids.
 */
export const recordModuleCredentialPass = Effect.fn('ModuleCredentials.recordPass')(function* recordPass(
  executor: Pick<CoreDatabaseExecutor, 'transaction'>,
  pass: ModuleCredentialPass,
) {
  yield* executor
    .transaction(
      Effect.fn('ModuleCredentials.recordPassTransaction')(function* recordScoped(transaction) {
        yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${PLATFORM_TENANT.tenantId}, true)`);
        yield* transaction.insert(auditEvents).values({
          auditProfile: 'sensitive',
          authMethod: 'system',
          eventType: `platform.module_credentials.${pass.kind}`,
          evidenceJson: {
            compositionRevision: pass.compositionRevision,
            credentials: pass.credentials.map(({ appId, providerKeyId }) => ({ appId, providerKeyId })),
            cutoff: pass.cutoff === undefined ? null : DateTime.formatIso(DateTime.makeUnsafe(pass.cutoff)),
            failed: [...pass.failed],
            hostId: pass.hostId,
            operationId: pass.operationId,
            undisabled: [...(pass.undisabled ?? [])],
          },
          outcome: pass.outcome,
          outcomeCode: pass.outcomeCode,
          outcomeStage: 'system',
          principalId: null,
          targetModuleKey: 'core.identity',
          targetResourceId: pass.operationId,
          targetResourceType: 'module_credential_pass',
          tenantId: PLATFORM_TENANT.tenantId,
        });
      }),
    )
    .pipe(Effect.mapError(unavailable('The module credential pass could not be audited')));
  return yield* Effect.void;
});
