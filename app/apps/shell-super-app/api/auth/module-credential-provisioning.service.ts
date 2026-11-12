import { CoreDatabase } from '@app/core-runtime/db/client';
import {
  bindPlatformCredential,
  ensureModulePrincipal,
  ensurePlatformTenant,
  loadCompositionAuthorityActivation,
  loadInternalWorkloadBindings,
  loadPlatformCredentialBindings,
  ModuleCredentialUnavailableError,
  modulePrincipalDisplayName,
  PLATFORM_TENANT,
  recordModuleCredentialPass,
  revokePlatformCredential,
} from '@app/core-runtime/auth/module-credentials';
import type {
  AuditedModuleCredential,
  InternalWorkloadBinding,
  ModuleCredentialPass,
  PlatformCredentialBinding,
} from '@app/core-runtime/auth/module-credentials';
import { and, eq } from 'drizzle-orm';
import { DateTime, Duration, Effect, Exit, Option, Result, Schema } from 'effect';
import type { Redacted } from 'effect';

import { ApiKeyService } from './api-key-service.ts';
import { AuthDatabase } from './db/client.ts';
import { apikey, user } from './db/schema.ts';
import { PLATFORM_KEY_OWNER } from './platform-key-owner.ts';
import {
  ModuleCredentialAttestationJson,
  ModuleCredentialAttestationSchema,
  platformAttestationOf,
  WorkloadCredentialAttestationJson,
  WorkloadCredentialAttestationSchema,
  workloadCredentialEntryId,
} from './module-credential-attestation.ts';
import type { ModuleCredentialRelease, PlatformCredentialAttestation } from './module-credential-attestation.ts';

/**
 * How long a module key lives. A host rotates its keys well before that, so a key nobody retired dies on its own.
 * Better Auth's API-key plugin refuses a lifetime under its `keyExpiration.minExpiresIn`, which the Shell leaves at
 * the default of one day: 24 hours sits exactly on that minimum, so this cannot be shortened without configuring the
 * plugin's minimum first (the provisioning integration test issues at this lifetime and is refused one second under).
 */
export const MODULE_CREDENTIAL_LIFETIME = Duration.hours(24);

/** One issued module key, by its provider id (not secret) and the moment it stops verifying. */
export interface IssuedModuleKey {
  readonly expiresAt: DateTime.Utc;
  readonly providerKeyId: string;
}

/**
 * One provisioning pass: each calling module's fresh key and each of its internal workloads' fresh keys (one per
 * tenant where the operator registered that workload), in memory only, and the modules that got none. `keys` names
 * every issued key by its entry: the app id for a module key, `workloadCredentialEntryId` for a workload key.
 */
export interface ProvisionedModuleCredentials {
  readonly credentials: ReadonlyMap<string, Redacted.Redacted>;
  readonly failedAppIds: readonly string[];
  readonly keys: ReadonlyMap<string, IssuedModuleKey>;
  readonly providerKeyIds: ReadonlySet<string>;
  readonly workloadCredentials: ReadonlyMap<string, Redacted.Redacted>;
}

/** Who runs a pass: the host (its name) and that host's boot (a fresh id each time the host process starts). */
export interface ModuleCredentialIssuer {
  readonly bootId: string;
  readonly hostId: string;
  readonly operationId: string;
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
  attestation: PlatformCredentialAttestation,
) {
  const { executor } = yield* AuthDatabase;
  const metadata =
    attestation.ontosModuleCredential === 'attested_v2'
      ? yield* Schema.encodeEffect(ModuleCredentialAttestationJson)(attestation)
      : yield* Schema.encodeEffect(WorkloadCredentialAttestationJson)(attestation);
  const updatedAt = yield* DateTime.nowAsDate;
  yield* executor.update(apikey).set({ metadata, updatedAt }).where(eq(apikey.id, providerKeyId));
});

/** Every key the platform issued that is still enabled, with what it attests and where it is bound, if anywhere. */
interface PlatformCredential {
  readonly attestation: Option.Option<PlatformCredentialAttestation>;
  readonly binding: PlatformCredentialBinding;
  /** The module the key serves: the attested app, else the module principal's (an unattested module key). */
  readonly entry: string;
}

const loadPlatformCredentials = Effect.gen(function* loadPlatformCredentialsEffect() {
  const database = yield* CoreDatabase;
  const { executor: auth } = yield* AuthDatabase;
  const owned = yield* auth
    .select({ id: apikey.id, metadata: apikey.metadata })
    .from(apikey)
    .where(and(eq(apikey.referenceId, PLATFORM_KEY_OWNER.id), eq(apikey.enabled, true)))
    .pipe(Effect.mapError(unavailable('The platform keys could not be read')));
  const bindings = yield* loadPlatformCredentialBindings(
    database.executor,
    owned.map(({ id }) => id),
  );
  const metadata = new Map(owned.map(({ id, metadata: value }) => [id, value] as const));
  return bindings.map((binding): PlatformCredential => {
    const attestation = platformAttestationOf(metadata.get(binding.providerKeyId) ?? null);
    return {
      attestation,
      binding,
      entry: Option.match(attestation, {
        onNone: () => binding.providerKeyId,
        onSome: (attested) =>
          attested.ontosModuleCredential === 'attested_v2' ? attested.appId : workloadCredentialEntryId(attested),
      }),
    };
  });
});

const auditedOf = ({ binding, entry }: PlatformCredential): AuditedModuleCredential => ({
  appId: entry,
  providerKeyId: binding.providerKeyId,
});

/**
 * Issues one fresh module credential for each calling module of the issuing host's release: the platform tenant and
 * each module's service principal are ensured, a key owned by the platform key owner is issued for
 * `MODULE_CREDENTIAL_LIFETIME`, bound to that principal through the same writers the identity Actions use, and
 * attested with the module's build marker, the release's composition revision (the Shell binds it for exactly those)
 * and the issuing host and boot. A key that cannot be bound or attested is disabled at once. Modules are independent:
 * one that fails is reported and gets no key, and every other module still gets its own. The pass is audited in the
 * platform tenant, with module ids and provider key ids only.
 */
export const provisionModuleCredentials = Effect.fn('ModuleCredentialProvisioning.provision')(function* provision(
  input: ModuleCredentialIssuer & {
    readonly appIds: readonly string[];
    readonly release: ModuleCredentialRelease;
    /** Each calling module's own internal workloads (O73), whose registered principals get a key too. */
    readonly workloads?: ReadonlyMap<string, readonly string[]>;
  },
) {
  const database = yield* CoreDatabase;
  const keys = yield* ApiKeyService;
  yield* ensurePlatformKeyOwner;
  yield* database.executor
    .transaction((transaction) => ensurePlatformTenant(transaction))
    .pipe(Effect.mapError(unavailable('The platform tenant could not be ensured')));
  const appIds = [...new Set(input.appIds)].toSorted();
  // Keys this pass issued, could not bind and then could not disable: reported in the audit, never silent.
  const undisabled: string[] = [];
  const disableOrReport = (appId: string, providerKeyId: string) =>
    keys.setEnabled(providerKeyId, false).pipe(
      Effect.exit,
      Effect.flatMap((disabled) => {
        if (Exit.isSuccess(disabled)) {
          return Effect.void;
        }
        undisabled.push(providerKeyId);
        return Effect.logError('A module credential that could not be bound could not be disabled either', {
          appId,
          providerKeyId,
        });
      }),
    );
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
      bootId: input.bootId,
      buildMarker,
      compositionRevision: input.release.compositionRevision,
      hostId: input.hostId,
      ontosModuleCredential: 'attested_v2',
    }).pipe(Effect.mapError(unavailable(`The release of ${appId} cannot be attested`)));
    const principalId = yield* database.executor
      .transaction((transaction) => ensureModulePrincipal(transaction, appId))
      .pipe(Effect.mapError(unavailable(`The module principal of ${appId} could not be ensured`)));
    const issued = yield* keys
      .issueServerOwned({
        expiresInSeconds: Duration.toSeconds(MODULE_CREDENTIAL_LIFETIME),
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
        bindPlatformCredential(transaction, {
          principalId,
          providerKeyId: issued.providerKeyId,
          tenantId: PLATFORM_TENANT.tenantId,
        }),
      )
      .pipe(
        Effect.andThen(attestKey(issued.providerKeyId, attestation)),
        Effect.mapError(unavailable(`The module credential of ${appId} could not be bound and attested`)),
        // The key must not stay usable: disable it, and if even that fails, report it rather than swallow it.
        Effect.tapError(() => disableOrReport(appId, issued.providerKeyId)),
      );
    const expiresAt = issued.expiresAt === null ? Option.none() : DateTime.make(issued.expiresAt);
    if (Option.isNone(expiresAt)) {
      yield* disableOrReport(appId, issued.providerKeyId);
      return yield* new ModuleCredentialUnavailableError({
        reason: `The module credential of ${appId} was issued without an end of life`,
      });
    }
    return {
      appId,
      expiresAt: DateTime.toUtc(expiresAt.value),
      providerKeyId: issued.providerKeyId,
      secret: issued.secret,
    };
  });
  const outcomes = yield* Effect.forEach(appIds, (appId) => provisionModule(appId).pipe(Effect.result), {
    concurrency: 1,
  });
  const credentials = new Map<string, Redacted.Redacted>();
  const keysByModule = new Map<string, IssuedModuleKey>();
  const issued: AuditedModuleCredential[] = [];
  const failedAppIds: string[] = [];
  for (const [index, outcome] of outcomes.entries()) {
    if (Result.isSuccess(outcome)) {
      const { appId, expiresAt, providerKeyId, secret } = outcome.success;
      credentials.set(appId, secret);
      keysByModule.set(appId, { expiresAt, providerKeyId });
      issued.push({ appId, providerKeyId });
    } else {
      failedAppIds.push(appIds[index] ?? '');
    }
  }

  // Each served module's internal workloads: a key for every principal the operator registered for one of them, in
  // the tenant it is registered in. The principal and its binding are the operator's; the platform only issues,
  // rotates and retires the principal's key, which is admitted exactly where that binding admits it.
  const workloadsOf = (appId: string) => input.workloads?.get(appId) ?? [];
  const workloadKeys = [...new Set(appIds.flatMap(workloadsOf))];
  const registered = yield* loadInternalWorkloadBindings(database.executor, workloadKeys).pipe(
    Effect.mapError(unavailable('The internal workload bindings could not be read')),
  );
  const provisionWorkload = Effect.fn('ModuleCredentialProvisioning.provisionWorkload')(function* provisionWorkload(
    appId: string,
    binding: InternalWorkloadBinding,
  ) {
    const entry = workloadCredentialEntryId({ appId, ...binding });
    const attestation = yield* Schema.decodeUnknownEffect(WorkloadCredentialAttestationSchema)({
      appId,
      bootId: input.bootId,
      buildMarker: input.release.buildMarkers[appId],
      compositionRevision: input.release.compositionRevision,
      hostId: input.hostId,
      ontosModuleCredential: 'workload_attested_v1',
      principalId: binding.principalId,
      tenantId: binding.tenantId,
      workloadKey: binding.workloadKey,
    }).pipe(Effect.mapError(unavailable(`The workload ${binding.workloadKey} of ${appId} cannot be attested`)));
    const workloadKey = yield* keys
      .issueServerOwned({
        expiresInSeconds: Duration.toSeconds(MODULE_CREDENTIAL_LIFETIME),
        issuerPrincipalId: binding.principalId,
        lifecycleOperationId: input.operationId,
        name: `workload:${binding.workloadKey}`,
        ownerUserId: PLATFORM_KEY_OWNER.id,
        tenantId: binding.tenantId,
      })
      .pipe(Effect.mapError(unavailable(`The workload credential ${entry} could not be issued`)));
    yield* database.executor
      .transaction((transaction) =>
        bindPlatformCredential(transaction, {
          principalId: binding.principalId,
          providerKeyId: workloadKey.providerKeyId,
          tenantId: binding.tenantId,
        }),
      )
      .pipe(
        Effect.andThen(attestKey(workloadKey.providerKeyId, attestation)),
        Effect.mapError(unavailable(`The workload credential ${entry} could not be bound and attested`)),
        Effect.tapError(() => disableOrReport(appId, workloadKey.providerKeyId)),
      );
    const expiresAt = workloadKey.expiresAt === null ? Option.none() : DateTime.make(workloadKey.expiresAt);
    if (Option.isNone(expiresAt)) {
      yield* disableOrReport(appId, workloadKey.providerKeyId);
      return yield* new ModuleCredentialUnavailableError({
        reason: `The workload credential ${entry} was issued without an end of life`,
      });
    }
    return {
      entry,
      expiresAt: DateTime.toUtc(expiresAt.value),
      providerKeyId: workloadKey.providerKeyId,
      secret: workloadKey.secret,
    };
  });
  const keyless = new Set(failedAppIds);
  const workloadRequests = appIds.flatMap((appId) => {
    if (keyless.has(appId)) {
      return [];
    }
    const own = new Set(workloadsOf(appId));
    return registered.flatMap((binding) => (own.has(binding.workloadKey) ? [{ appId, binding }] : []));
  });
  const workloadOutcomes = yield* Effect.forEach(
    workloadRequests,
    ({ appId, binding }) => provisionWorkload(appId, binding).pipe(Effect.result),
    { concurrency: 1 },
  );
  const workloadCredentials = new Map<string, Redacted.Redacted>();
  for (const [index, outcome] of workloadOutcomes.entries()) {
    if (Result.isSuccess(outcome)) {
      const { entry, expiresAt, providerKeyId, secret } = outcome.success;
      workloadCredentials.set(entry, secret);
      keysByModule.set(entry, { expiresAt, providerKeyId });
      issued.push({ appId: entry, providerKeyId });
    } else {
      keyless.add(workloadRequests[index]?.appId ?? '');
    }
  }
  const failedModules = appIds.filter((appId) => keyless.has(appId));
  yield* recordModuleCredentialPass(database.executor, {
    bootId: input.bootId,
    compositionRevision: input.release.compositionRevision,
    credentials: issued,
    failed: failedModules,
    hostId: input.hostId,
    kind: 'issued',
    operationId: input.operationId,
    outcome: failedModules.length === 0 ? 'succeeded' : 'failed',
    outcomeCode: failedModules.length === 0 ? 'module_credentials_issued' : 'module_credentials_partially_issued',
    undisabled,
  });
  return {
    credentials,
    failedAppIds: failedModules,
    keys: keysByModule,
    providerKeyIds: new Set(issued.map(({ providerKeyId }) => providerKeyId)),
    workloadCredentials,
  } satisfies ProvisionedModuleCredentials;
});

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
export const retireSupersededModuleCredentials = Effect.fn('ModuleCredentialProvisioning.retire')(function* retire(
  input: ModuleCredentialIssuer & {
    readonly compositionRevision: string;
    readonly current: ReadonlySet<string>;
  },
) {
  const database = yield* CoreDatabase;
  const keys = yield* ApiKeyService;
  const audit = (pass: Pick<ModuleCredentialPass, 'credentials' | 'cutoff' | 'failed' | 'outcome' | 'outcomeCode'>) =>
    recordModuleCredentialPass(database.executor, {
      ...pass,
      bootId: input.bootId,
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
  const platform = yield* loadPlatformCredentials;
  // Module keys and internal workload keys alike: every platform key bound before this revision took the authority.
  const superseded = platform.filter(
    ({ binding }) => !input.current.has(binding.providerKeyId) && binding.boundAt.getTime() < cutoff.getTime(),
  );
  const retireOne = Effect.fn('ModuleCredentialProvisioning.retireOne')(function* retireOne({
    binding: credential,
  }: PlatformCredential) {
    // The key is disabled first: once it fails verification nothing can use it, whatever happens to its binding.
    // Only then is the binding revoked, and only while this release still holds the authority.
    return yield* keys.setEnabled(credential.providerKeyId, false).pipe(
      Effect.andThen(
        database.executor.transaction(
          Effect.fn('ModuleCredentialProvisioning.revokeWhileHoldingAuthority')(
            function* revokeWhileHoldingAuthority(transaction) {
              // The authority is re-read with each revocation: a host that lost it in the meantime stops retiring.
              const still = yield* loadCompositionAuthorityActivation(transaction);
              if (Option.isNone(still) || still.value.revision !== input.compositionRevision) {
                return false;
              }
              yield* revokePlatformCredential(transaction, credential);
              return true;
            },
          ),
        ),
      ),
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
    credentials: retired.map(auditedOf),
    cutoff,
    failed: failed.map(({ binding }) => binding.providerKeyId),
    outcome: failed.length === 0 ? 'succeeded' : 'failed',
    outcomeCode: failed.length === 0 ? 'module_credentials_retired' : 'module_credentials_partially_retired',
  });
  return {
    failed: failed.length,
    holdsAuthority: true,
    retired: retired.length,
  } satisfies ModuleCredentialRetirement;
});

/** What one own-retire pass did: how many of the host's own other keys it retired, and how many it could not. */
export interface OwnModuleCredentialRetirement {
  readonly failed: number;
  readonly retired: number;
}

/**
 * Retires the issuing host's own module credentials it no longer holds, each named by what proves it is its own: the
 * `replaced` keys (provider key ids its current boot held and replaced, so attested for this host and this boot) and
 * every key of `earlierBoots`, the ended boots its container recorded. Nothing else is ever touched: not another key
 * of this boot it was not told about, and not a key of any other boot, even one attested with the same host name (a
 * new container may carry the name of the one it replaces, which still serves). Only the authority holder's release
 * retires another host's keys. Each key is disabled first, then its binding revoked. The pass is audited in the
 * platform tenant.
 */
export const retireOwnModuleCredentials = Effect.fn('ModuleCredentialProvisioning.retireOwn')(function* retireOwn(
  input: ModuleCredentialIssuer & {
    readonly compositionRevision: string;
    readonly earlierBoots: ReadonlySet<string>;
    readonly replaced: ReadonlySet<string>;
  },
) {
  const database = yield* CoreDatabase;
  const keys = yield* ApiKeyService;
  const platform = yield* loadPlatformCredentials;
  // Module keys and internal workload keys alike: each attests the host and boot that issued it.
  const own = platform.filter(
    ({ attestation, binding }) =>
      Option.isSome(attestation) &&
      attestation.value.hostId === input.hostId &&
      ((attestation.value.bootId === input.bootId && input.replaced.has(binding.providerKeyId)) ||
        (attestation.value.bootId !== input.bootId && input.earlierBoots.has(attestation.value.bootId))),
  );
  const outcomes = yield* Effect.forEach(
    own,
    ({ binding: credential }) =>
      keys
        .setEnabled(credential.providerKeyId, false)
        .pipe(
          Effect.andThen(
            database.executor.transaction((transaction) => revokePlatformCredential(transaction, credential)),
          ),
          Effect.mapError(unavailable('An own module credential could not be retired')),
          Effect.result,
        ),
    { concurrency: 1 },
  );
  const retired = own.filter((_, index) => outcomes[index] !== undefined && Result.isSuccess(outcomes[index]));
  const failed = own.filter((_, index) => outcomes[index] === undefined || Result.isFailure(outcomes[index]));
  yield* recordModuleCredentialPass(database.executor, {
    bootId: input.bootId,
    compositionRevision: input.compositionRevision,
    credentials: retired.map(auditedOf),
    failed: failed.map(({ binding }) => binding.providerKeyId),
    hostId: input.hostId,
    kind: 'retired_own',
    operationId: input.operationId,
    outcome: failed.length === 0 ? 'succeeded' : 'failed',
    outcomeCode: failed.length === 0 ? 'own_module_credentials_retired' : 'own_module_credentials_partially_retired',
  });
  return { failed: failed.length, retired: retired.length } satisfies OwnModuleCredentialRetirement;
});
