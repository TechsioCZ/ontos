import { CoreDatabase } from '@app/core-runtime/db/client';
import {
  bindModuleCredential,
  ensureModulePrincipal,
  ensurePlatformTenant,
  loadCompositionAuthorityActivation,
  loadModuleCredentialEnrolment,
  ModuleCredentialUnavailableError,
  modulePrincipalDisplayName,
  PLATFORM_TENANT,
  recordModuleCredentialPass,
  revokeModuleCredential,
} from '@app/core-runtime/auth/module-credentials';
import type {
  AuditedModuleCredential,
  ModuleCredentialEnrolment,
  ModuleCredentialPass,
} from '@app/core-runtime/auth/module-credentials';
import { eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Result, Schema } from 'effect';
import type { Redacted } from 'effect';

import { ApiKeyService } from './api-key-service.ts';
import { AuthDatabase } from './db/client.ts';
import { apikey, user } from './db/schema.ts';
import { PLATFORM_KEY_OWNER } from './platform-key-owner.ts';
import { ModuleCredentialAttestationJson, ModuleCredentialAttestationSchema } from './module-credential-attestation.ts';
import type { ModuleCredentialAttestation, ModuleCredentialRelease } from './module-credential-attestation.ts';

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

/** Records what the key was issued for, replacing its pending marker once its binding committed. */
const attestKey = Effect.fn('ModuleCredentialProvisioning.attestKey')(function* attestModuleCredential(
  providerKeyId: string,
  attestation: ModuleCredentialAttestation,
) {
  const { executor } = yield* AuthDatabase;
  const metadata = yield* Schema.encodeEffect(ModuleCredentialAttestationJson)(attestation);
  const updatedAt = yield* DateTime.nowAsDate;
  yield* executor.update(apikey).set({ metadata, updatedAt }).where(eq(apikey.id, providerKeyId));
});

/**
 * Issues one fresh module credential for each calling module of the issuing host's release: the platform tenant and
 * each module's service principal are ensured, a key owned by the platform key owner is issued, bound to that
 * principal through the same writers the identity Actions use, and attested with the module's build marker and the
 * release's composition revision (the Shell binds it for exactly those). A key that cannot be bound or attested is
 * disabled at once. Modules are independent: one that fails is reported and gets no key, and every other module still
 * gets its own. The pass is audited in the platform tenant, with module ids and provider key ids only.
 */
export const provisionModuleCredentials = Effect.fn('ModuleCredentialProvisioning.provision')(
  function* provision(input: {
    readonly appIds: readonly string[];
    readonly hostId: string;
    readonly operationId: string;
    readonly release: ModuleCredentialRelease;
  }) {
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
      const buildMarker = input.release.buildMarkers[appId];
      if (buildMarker === undefined) {
        return yield* new ModuleCredentialUnavailableError({
          reason: `The issuing release does not serve ${appId}, so nothing can be attested for it`,
        });
      }
      const attestation = yield* Schema.decodeUnknownEffect(ModuleCredentialAttestationSchema)({
        appId,
        buildMarker,
        compositionRevision: input.release.compositionRevision,
        ontosModuleCredential: 'attested_v1',
      }).pipe(Effect.mapError(unavailable(`The release of ${appId} cannot be attested`)));
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
      // The binding is the commit point; the attestation then replaces the pending marker, which only drives cleanup
      // of unbound keys. A bound key without an attestation binds nothing in the Shell.
      yield* database.executor
        .transaction((transaction) =>
          bindModuleCredential(transaction, { principalId, providerKeyId: issued.providerKeyId }),
        )
        .pipe(
          Effect.andThen(attestKey(issued.providerKeyId, attestation)),
          Effect.mapError(unavailable(`The module credential of ${appId} could not be bound and attested`)),
          Effect.tapError(() => keys.setEnabled(issued.providerKeyId, false).pipe(Effect.ignore)),
        );
      return { appId, providerKeyId: issued.providerKeyId, secret: issued.secret };
    });
    const outcomes = yield* Effect.forEach(appIds, (appId) => provisionModule(appId).pipe(Effect.result), {
      concurrency: 1,
    });
    const credentials = new Map<string, Redacted.Redacted>();
    const issued: AuditedModuleCredential[] = [];
    const failedAppIds: string[] = [];
    for (const [index, outcome] of outcomes.entries()) {
      if (Result.isSuccess(outcome)) {
        credentials.set(outcome.success.appId, outcome.success.secret);
        issued.push({ appId: outcome.success.appId, providerKeyId: outcome.success.providerKeyId });
      } else {
        failedAppIds.push(appIds[index] ?? '');
      }
    }
    yield* recordModuleCredentialPass(database.executor, {
      compositionRevision: input.release.compositionRevision,
      credentials: issued,
      failed: failedAppIds,
      hostId: input.hostId,
      kind: 'issued',
      operationId: input.operationId,
      outcome: failedAppIds.length === 0 ? 'succeeded' : 'failed',
      outcomeCode: failedAppIds.length === 0 ? 'module_credentials_issued' : 'module_credentials_partially_issued',
    });
    return {
      credentials,
      failedAppIds,
      providerKeyIds: new Set(issued.map(({ providerKeyId }) => providerKeyId)),
    } satisfies ProvisionedModuleCredentials;
  },
);

/** What one retire pass did: whether this host held the authority, and how many credentials it retired. */
export interface ModuleCredentialRetirement {
  readonly failed: number;
  readonly holdsAuthority: boolean;
  readonly retired: number;
}

const holdsAuthorityNow = Effect.fn('ModuleCredentialProvisioning.holdsAuthorityNow')(function* readAuthorityHolder(
  compositionRevision: string,
) {
  const database = yield* CoreDatabase;
  const authority = yield* loadCompositionAuthorityActivation(database.executor);
  return authority.pipe(
    Option.filter((current) => current.revision === compositionRevision && current.phase === 'active'),
  );
});

/**
 * Retires the module credentials the issuing host's release superseded, and only when that release holds the
 * authority now. The cutoff is the moment its revision took the authority (the authority row's
 * `revision_activated_at`): a credential bound before it is superseded, its binding revoked and its key disabled; a
 * credential bound after it (another container of this release, an observe-only host, a newer host booting) is never
 * touched, and neither are this pass's own. A host whose revision does not hold the authority retires nothing. The
 * pass is audited either way. Returns the counts, so the caller can report and retry.
 */
export const retireSupersededModuleCredentials = Effect.fn('ModuleCredentialProvisioning.retire')(
  function* retire(input: {
    readonly compositionRevision: string;
    readonly current: ReadonlySet<string>;
    readonly hostId: string;
    readonly operationId: string;
  }) {
    const database = yield* CoreDatabase;
    const keys = yield* ApiKeyService;
    const audit = (pass: Pick<ModuleCredentialPass, 'credentials' | 'cutoff' | 'failed' | 'outcome' | 'outcomeCode'>) =>
      recordModuleCredentialPass(database.executor, {
        ...pass,
        compositionRevision: input.compositionRevision,
        hostId: input.hostId,
        kind: 'retired',
        operationId: input.operationId,
      });
    const authority = yield* holdsAuthorityNow(input.compositionRevision);
    if (Option.isNone(authority)) {
      yield* audit({ credentials: [], failed: [], outcome: 'denied', outcomeCode: 'not_authority_holder' });
      return { failed: 0, holdsAuthority: false, retired: 0 } satisfies ModuleCredentialRetirement;
    }
    const cutoff = authority.value.revisionActivatedAt;
    const enrolment = yield* loadModuleCredentialEnrolment(database.executor);
    const superseded = enrolment.filter(
      (credential) => !input.current.has(credential.providerKeyId) && credential.boundAt.getTime() < cutoff.getTime(),
    );
    const retireOne = Effect.fn('ModuleCredentialProvisioning.retireOne')(function* retireOne(
      credential: ModuleCredentialEnrolment,
    ) {
      return yield* database.executor
        .transaction(
          Effect.fn('ModuleCredentialProvisioning.revokeWhileHoldingAuthority')(
            function* revokeWhileHoldingAuthority(transaction) {
              // The authority is re-read with each revocation: a host that lost it in the meantime stops retiring.
              const still = yield* loadCompositionAuthorityActivation(transaction);
              if (Option.isNone(still) || still.value.revision !== input.compositionRevision) {
                return false;
              }
              yield* revokeModuleCredential(transaction, credential);
              return true;
            },
          ),
        )
        .pipe(
          Effect.tap((revoked) => (revoked ? keys.setEnabled(credential.providerKeyId, false) : Effect.void)),
          Effect.mapError(unavailable('A superseded module credential could not be retired')),
          Effect.result,
        );
    });
    const outcomes = yield* Effect.forEach(superseded, retireOne, { concurrency: 1 });
    const retired = superseded.filter((_, index) => {
      const outcome = outcomes[index];
      return outcome !== undefined && Result.isSuccess(outcome) && outcome.success;
    });
    const failed = superseded.filter((_, index) => {
      const outcome = outcomes[index];
      return outcome === undefined || Result.isFailure(outcome);
    });
    yield* audit({
      credentials: retired.map(({ appId, providerKeyId }) => ({ appId, providerKeyId })),
      cutoff,
      failed: failed.map(({ providerKeyId }) => providerKeyId),
      outcome: failed.length === 0 ? 'succeeded' : 'failed',
      outcomeCode: failed.length === 0 ? 'module_credentials_retired' : 'module_credentials_partially_retired',
    });
    return {
      failed: failed.length,
      holdsAuthority: true,
      retired: retired.length,
    } satisfies ModuleCredentialRetirement;
  },
);
