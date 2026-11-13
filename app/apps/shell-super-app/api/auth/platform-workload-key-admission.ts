import { recoverSqlTransactionError } from '@app/core-runtime';
import { CoreDatabase } from '@app/core-runtime/db/client';
import { eq, sql } from 'drizzle-orm';
import { Context, Effect, Layer, Option, Schema } from 'effect';

import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import { AuthDatabase } from './db/client.ts';
import { apikey } from './db/schema.ts';
import { delegationForbidden, delegationUnavailable } from './gateway-delegation-errors.ts';
import type { GatewayDelegationError } from './gateway-delegation-errors.ts';
import { moduleCredentialReleaseOf, WorkloadCredentialAttestationJson } from './module-credential-attestation.ts';
import type { ModuleCredentialRelease } from './module-credential-attestation.ts';
import { isPlatformKeyOwner } from './platform-key-owner.ts';

/** One verified API key and the principal it resolved to, about to act. */
export interface PlatformWorkloadKeyInput {
  /** The company the key's caller asks to act in, or null when it names none. */
  readonly legalEntityId: string | null;
  readonly principalId: string;
  readonly providerKeyId: string;
  readonly tenantId: string;
}

/**
 * Whether a verified key may act for its principal when that principal is a module's internal workload. A workload
 * principal acts only with the key the platform issued it: its metadata attests exactly that principal, tenant and
 * company, the release the Shell serves now and the module's build in it. Any other key of such a principal, issued
 * by a tenant administrator or left from before, is refused, whatever the principal's bindings admit. A principal
 * that is no internal workload passes unchanged.
 */
export class PlatformWorkloadKeyAdmission extends Context.Service<
  PlatformWorkloadKeyAdmission,
  { readonly admit: (input: PlatformWorkloadKeyInput) => Effect.Effect<void, GatewayDelegationError> }
>()('@app/shell-super-app/api/auth/platform-workload-key-admission/PlatformWorkloadKeyAdmission') {}

const unavailable = delegationUnavailable('workload_admission_unavailable');
const refused = delegationForbidden('workload_key_not_platform_issued', 'workload_admission_unavailable');

const WorkloadPrincipalRowSchema = Schema.Struct({
  internalBound: Schema.Boolean,
  platformRole: Schema.NullOr(Schema.String),
});

type CoreExecutor = (typeof CoreDatabase)['Service']['executor'];
type AuthExecutor = (typeof AuthDatabase)['Service']['executor'];

/**
 * Whether the principal is an internal workload principal: the platform's marker, or a binding to a workload the
 * platform registers in this tenant (a principal someone bound to that workload by hand counts as one too).
 */
const readWorkloadPrincipal = (core: CoreExecutor, input: PlatformWorkloadKeyInput) =>
  core
    .transaction(
      Effect.fn('PlatformWorkloadKeyAdmission.readPrincipal')(function* readPrincipal(transaction) {
        yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${input.tenantId}, true)`);
        return yield* transaction.execute(
          sql`
            select
              p.platform_role as "platformRole",
              exists (
                select 1
                from core.access_workload_bindings as b
                where b.tenant_id = p.tenant_id
                  and b.principal_id = p.principal_id
                  and b.workload_key in (
                    select registered.workload_key
                    from core.access_workload_bindings as registered
                    join core.principals as platform
                      on platform.tenant_id = registered.tenant_id and platform.principal_id = registered.principal_id
                    where registered.tenant_id = p.tenant_id and platform.platform_role = 'internal_workload'
                  )
              ) as "internalBound"
            from core.principals as p
            where p.tenant_id = ${input.tenantId} and p.principal_id = ${input.principalId}
            limit 1
          `,
          'objects',
        );
      }),
    )
    .pipe(
      recoverSqlTransactionError,
      Effect.mapError(unavailable),
      Effect.flatMap((rows) => Schema.decodeUnknownEffect(Schema.Array(WorkloadPrincipalRowSchema))(rows)),
      Effect.mapError(unavailable),
      Effect.map(([row]) => row !== undefined && (row.platformRole === 'internal_workload' || row.internalBound)),
    );

/** The provider record of one key: what its metadata says and which provider user owns it. */
export interface WorkloadKeyRecord {
  readonly metadata: null | string;
  readonly referenceId: string;
}

/**
 * Whether a key is the one the platform issued this workload principal for the release served now. The attestation
 * counts only on a key the platform key owner holds: metadata copied onto a key someone else owns attests nothing.
 */
export const admitsWorkloadKey = (
  record: WorkloadKeyRecord | undefined,
  input: PlatformWorkloadKeyInput,
  release: ModuleCredentialRelease,
): boolean =>
  record !== undefined &&
  isPlatformKeyOwner(record.referenceId) &&
  Option.exists(
    Option.flatMap(Option.fromNullishOr(record.metadata), (metadata) =>
      Schema.decodeOption(WorkloadCredentialAttestationJson)(metadata),
    ),
    (attestation) =>
      attestation.principalId === input.principalId &&
      attestation.tenantId === input.tenantId &&
      (input.legalEntityId === null || attestation.legalEntityId === input.legalEntityId) &&
      attestation.compositionRevision === release.compositionRevision &&
      release.buildMarkers[attestation.appId] !== undefined &&
      attestation.buildMarker === release.buildMarkers[attestation.appId],
  );

const readKeyRecord = (auth: AuthExecutor, providerKeyId: string) =>
  auth
    .select({ metadata: apikey.metadata, referenceId: apikey.referenceId })
    .from(apikey)
    .where(eq(apikey.id, providerKeyId))
    .limit(1)
    .pipe(
      recoverSqlTransactionError,
      Effect.mapError(unavailable),
      Effect.map(([record]): WorkloadKeyRecord | undefined => record),
    );

export const PlatformWorkloadKeyAdmissionLive = Layer.effect(
  PlatformWorkloadKeyAdmission,
  Effect.gen(function* preparePlatformWorkloadKeyAdmission() {
    const core = yield* CoreDatabase;
    const auth = yield* AuthDatabase;
    const catalog = yield* ShellInstalledModuleCatalog;
    return {
      admit: Effect.fn('PlatformWorkloadKeyAdmission.admit')(function* admit(input: PlatformWorkloadKeyInput) {
        if (!(yield* readWorkloadPrincipal(core.executor, input))) {
          return yield* Effect.void;
        }
        const record = yield* readKeyRecord(auth.executor, input.providerKeyId);
        const installed = yield* catalog.load.pipe(Effect.mapError(unavailable));
        return admitsWorkloadKey(record, input, moduleCredentialReleaseOf(installed))
          ? yield* Effect.void
          : yield* refused();
      }),
    };
  }),
);
