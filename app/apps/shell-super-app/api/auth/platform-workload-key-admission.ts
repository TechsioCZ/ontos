import { recoverSqlTransactionError } from '@app/core-runtime';
import { CoreDatabase } from '@app/core-runtime/db/client';
import { eq, sql } from 'drizzle-orm';
import { Context, Effect, Layer, Option, Schema } from 'effect';

import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import { AuthDatabase } from './db/client.ts';
import { apikey } from './db/schema.ts';
import { delegationForbidden, delegationUnavailable } from './gateway-delegation-errors.ts';
import type { GatewayDelegationError } from './gateway-delegation-errors.ts';
import { WorkloadCredentialAttestationJson } from './module-credential-attestation.ts';

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

const readAttestation = (auth: AuthExecutor, providerKeyId: string) =>
  auth
    .select({ metadata: apikey.metadata })
    .from(apikey)
    .where(eq(apikey.id, providerKeyId))
    .limit(1)
    .pipe(
      recoverSqlTransactionError,
      Effect.mapError(unavailable),
      Effect.map(([record]) =>
        Option.flatMap(Option.fromNullishOr(record?.metadata), (metadata) =>
          Schema.decodeOption(WorkloadCredentialAttestationJson)(metadata),
        ),
      ),
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
        const attested = yield* readAttestation(auth.executor, input.providerKeyId);
        const installed = yield* catalog.load.pipe(Effect.mapError(unavailable));
        const admitted = Option.exists(attested, (attestation) => {
          const contract = installed.contracts.find(({ deployment }) => deployment.appId === attestation.appId);
          return (
            attestation.principalId === input.principalId &&
            attestation.tenantId === input.tenantId &&
            (input.legalEntityId === null || attestation.legalEntityId === input.legalEntityId) &&
            attestation.compositionRevision === installed.composition.revision &&
            contract !== undefined &&
            attestation.buildMarker === contract.deployment.buildMarker
          );
        });
        return admitted ? yield* Effect.void : yield* refused();
      }),
    };
  }),
);
