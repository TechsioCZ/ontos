import { CoreDatabase } from '@app/core-runtime/db/client';
import {
  bindModuleCredential,
  ensureModulePrincipal,
  ensurePlatformTenant,
  loadModuleCredentialEnrolment,
  ModuleCredentialUnavailableError,
  modulePrincipalDisplayName,
  PLATFORM_TENANT,
  revokeModuleCredential,
} from '@app/core-runtime/auth/module-credentials';
import { eq } from 'drizzle-orm';
import { Effect, Result } from 'effect';
import type { Redacted } from 'effect';

import { ApiKeyService } from './api-key-service.ts';
import { AuthDatabase } from './db/client.ts';
import { user } from './db/schema.ts';

/**
 * The provider user every module credential belongs to. It has no account and no password, so nobody signs in as it,
 * and no principal binding names it, so it never resolves to anyone.
 */
export const PLATFORM_KEY_OWNER = Object.freeze({
  email: 'module-credentials@ontos-platform.invalid',
  id: 'ontos-platform-module-credentials',
  name: 'OntOS platform module credentials',
});

/** One provisioning pass: each calling module's fresh key, in memory only, and the modules that got none. */
export interface ProvisionedModuleCredentials {
  readonly credentials: ReadonlyMap<string, Redacted.Redacted>;
  readonly failedAppIds: readonly string[];
  readonly providerKeyIds: ReadonlySet<string>;
}

const unavailable = (reason: string) => (cause: unknown) => new ModuleCredentialUnavailableError({ cause, reason });

const ensurePlatformKeyOwner = Effect.gen(function* ensurePlatformKeyOwnerEffect() {
  const { executor } = yield* AuthDatabase;
  yield* executor
    .insert(user)
    .values({
      email: PLATFORM_KEY_OWNER.email,
      emailVerified: false,
      id: PLATFORM_KEY_OWNER.id,
      name: PLATFORM_KEY_OWNER.name,
    })
    .onConflictDoNothing()
    .pipe(Effect.mapError(unavailable('The platform key owner could not be created')));
  const [owner] = yield* executor
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, PLATFORM_KEY_OWNER.id))
    .limit(1)
    .pipe(Effect.mapError(unavailable('The platform key owner could not be read')));
  if (owner?.email !== PLATFORM_KEY_OWNER.email) {
    return yield* new ModuleCredentialUnavailableError({
      reason: 'The platform key owner is missing or not the platform',
    });
  }
  return yield* Effect.void;
});

/**
 * Issues one fresh module credential for each calling module: the platform tenant and each module's service principal
 * are ensured, a key owned by the platform key owner is issued, and it is bound to that principal through the same
 * writers the identity Actions use. A key whose binding fails is disabled at once. Modules are independent: one that
 * fails is reported and gets no key, and every other module still gets its own.
 */
export const provisionModuleCredentials = Effect.fn('ModuleCredentialProvisioning.provision')(
  function* provision(input: { readonly appIds: readonly string[]; readonly operationId: string }) {
    const database = yield* CoreDatabase;
    const keys = yield* ApiKeyService;
    yield* ensurePlatformKeyOwner;
    yield* database.executor
      .transaction((transaction) => ensurePlatformTenant(transaction))
      .pipe(Effect.mapError(unavailable('The platform tenant could not be ensured')));
    const appIds = [...new Set(input.appIds)].toSorted();
    const provisionModule = Effect.fn('ModuleCredentialProvisioning.provisionModule')(function* provisionModule(
      appId: string,
    ) {
      const principalId = yield* database.executor
        .transaction((transaction) => ensureModulePrincipal(transaction, appId))
        .pipe(Effect.mapError(unavailable(`The module principal of ${appId} could not be ensured`)));
      const issued = yield* keys
        .issueServerOwned({
          issuerPrincipalId: principalId,
          lifecycleOperationId: input.operationId,
          name: modulePrincipalDisplayName(appId),
          ownerUserId: PLATFORM_KEY_OWNER.id,
          tenantId: PLATFORM_TENANT.tenantId,
        })
        .pipe(Effect.mapError(unavailable(`The module credential of ${appId} could not be issued`)));
      yield* database.executor
        .transaction((transaction) =>
          bindModuleCredential(transaction, { principalId, providerKeyId: issued.providerKeyId }),
        )
        .pipe(
          Effect.mapError(unavailable(`The module credential of ${appId} could not be bound`)),
          Effect.tapError(() => keys.setEnabled(issued.providerKeyId, false).pipe(Effect.ignore)),
        );
      // The binding is the commit point; the pending marker only drives cleanup of unbound keys.
      yield* keys.clearPendingCleanup(issued.providerKeyId).pipe(Effect.ignore);
      return { appId, providerKeyId: issued.providerKeyId, secret: issued.secret };
    });
    const outcomes = yield* Effect.forEach(appIds, (appId) => provisionModule(appId).pipe(Effect.result), {
      concurrency: 1,
    });
    const credentials = new Map<string, Redacted.Redacted>();
    const providerKeyIds = new Set<string>();
    const failedAppIds: string[] = [];
    for (const [index, outcome] of outcomes.entries()) {
      if (Result.isSuccess(outcome)) {
        credentials.set(outcome.success.appId, outcome.success.secret);
        providerKeyIds.add(outcome.success.providerKeyId);
      } else {
        failedAppIds.push(appIds[index] ?? '');
      }
    }
    return { credentials, failedAppIds, providerKeyIds } satisfies ProvisionedModuleCredentials;
  },
);

/**
 * Revokes every module credential bound before this pass's own: its binding is revoked and its key disabled. A
 * credential bound after them belongs to a newer pass (a newer container) and is never touched. Returns how many were
 * retired and how many could not be, so the caller can report and retry.
 */
export const retireSupersededModuleCredentials = Effect.fn('ModuleCredentialProvisioning.retire')(function* retire(
  current: ReadonlySet<string>,
) {
  const database = yield* CoreDatabase;
  const keys = yield* ApiKeyService;
  const enrolment = yield* loadModuleCredentialEnrolment(database.executor);
  const own = enrolment.filter((credential) => current.has(credential.providerKeyId));
  if (own.length === 0) {
    return { failed: 0, retired: 0 };
  }
  const cutoff = Math.min(...own.map((credential) => credential.boundAt.getTime()));
  const superseded = enrolment.filter(
    (credential) => !current.has(credential.providerKeyId) && credential.boundAt.getTime() < cutoff,
  );
  const outcomes = yield* Effect.forEach(
    superseded,
    (credential) =>
      database.executor
        .transaction((transaction) => revokeModuleCredential(transaction, credential))
        .pipe(
          Effect.andThen(keys.setEnabled(credential.providerKeyId, false)),
          Effect.mapError(unavailable('A superseded module credential could not be retired')),
          Effect.result,
        ),
    { concurrency: 1 },
  );
  const retired = outcomes.filter(Result.isSuccess).length;
  return { failed: outcomes.length - retired, retired };
});
