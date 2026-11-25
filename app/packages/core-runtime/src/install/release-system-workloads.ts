import { Crypto, DateTime, Effect, Option, Schema } from 'effect';

import { AccessReleaseStore } from '../access/changes/persistence/release-store.ts';
import { PrincipalIdSchema, TenantIdSchema } from '../access/ids.ts';
import { intentUnavailable } from '../access/intent/errors.ts';
import { runScoped } from '../access/intent/persistence.ts';
import type { AccessIntentDatabase } from '../access/intent/persistence.ts';
import { RELEASE_ACTOR_DISPLAY_NAME, releaseActorId } from '../access/release/activation.ts';
import { registerWorkloadBindingsIn } from '../access/workloads/binding-store.ts';
import { AccessWorkloadBindingIdSchema } from '../access/workloads/store.ts';
import {
  declaresSystemWorkload,
  insertSystemWorkloadPrincipal,
  lockActiveTenantForEnrollment,
  readSystemWorkloadEnrollmentHolders,
  requireActiveTenantModule,
  soleSystemWorkloadHolder,
} from '../access/workloads/system-workload-enrollment.ts';
import { WorkloadKeySchema } from '../authorization/access-declaration.ts';
import { SystemPrincipalContextResolverFromCoreDatabase } from '../auth/system-principal-context.ts';
import { preserveSystemPrincipalContextTrust } from '../auth/system-principal-context-provenance.ts';
import {
  isRegisteredSystemWorkload,
  registerSystemWorkload,
  systemWorkloadPart,
} from '../auth/system-workload-registration.ts';
import type { SystemWorkloadRegistration } from '../auth/system-workload-registration.ts';
import { auditEvents } from '../db/schema.ts';
import { installOperationalScope } from '../db/scoped-transaction.ts';
import { OntosModuleDeploymentContractSchema } from '../modules/manifest.ts';
import type { OntosModuleDeploymentContract } from '../modules/manifest.ts';
import type { OperationalScope } from '../operations/context.ts';

const releaseJob = registerSystemWorkload({ jobKey: 'release-system-workload-enrollment' });
const noConstraints: ReadonlySet<string> = new Set();

export class ReleaseSystemWorkloadEnrollmentError extends Schema.TaggedError<ReleaseSystemWorkloadEnrollmentError>()(
  'ReleaseSystemWorkloadEnrollmentError',
  { reason: Schema.String },
) {}
const refused = (reason: string, cause?: unknown) => {
  const error = new ReleaseSystemWorkloadEnrollmentError({ reason });
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { enumerable: false, value: cause });
  }
  return error;
};

export interface ReleaseSystemWorkloadInput {
  /** Genuine candidate/reviewed module artifact, loaded by the trusted installer, not an installed-catalog override. */
  readonly contract: OntosModuleDeploymentContract;
  /** Workload vocabulary from the same reviewed release's authorization catalog artifact. */
  readonly declaredWorkloadKeys: readonly string[];
  /** The owner's actual opaque registration, not a caller-created workload-key object. */
  readonly registration: SystemWorkloadRegistration;
  /** Real installer run reference; never an Action invocation, receipt or Outbox identifier. */
  readonly runReference: string;
  readonly tenantId: string;
}

/** Validates the release's declaration before even ensuring an installer actor. */
export const validateReleaseSystemWorkloadDeclaration = Effect.fn('ReleaseSystemWorkloads.validateDeclaration')(
  function* validateDeclaration(input: ReleaseSystemWorkloadInput) {
    const contract = yield* Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema)(input.contract).pipe(
      Effect.catchTag('SchemaError', () => Effect.fail(refused('The reviewed module deployment contract is invalid'))),
    );
    const { registration } = input;
    const workloadKey = yield* Schema.decodeUnknownEffect(WorkloadKeySchema)(registration.jobKey).pipe(
      Effect.catchTag('SchemaError', () => Effect.fail(refused('The native system workload key is invalid'))),
    );
    const tenantId = yield* Schema.decodeUnknownEffect(TenantIdSchema)(input.tenantId).pipe(
      Effect.catchTag('SchemaError', () => Effect.fail(refused('The installer tenant is invalid'))),
    );
    if (
      !isRegisteredSystemWorkload(registration) ||
      registration.allowServicePrincipal ||
      !systemWorkloadPart.test(input.runReference) ||
      !workloadKey.startsWith(`${contract.manifest.module.id}.`) ||
      !declaresSystemWorkload(contract, workloadKey) ||
      !input.declaredWorkloadKeys.includes(workloadKey)
    ) {
      return yield* refused('The reviewed release does not declare this native SYSTEM workload for its owner');
    }
    return { contract, tenantId, workloadKey };
  },
);

/**
 * Installation-time counterpart of Core's system-enrollment Action. The trusted installer supplies the genuine
 * reviewed candidate artifact directly: it need not be the public composition yet. Uses the same tenant lock,
 * holder reader, principal writer and binding writer, in one scoped transaction. Never writes roles, grants,
 * companies, aliases, invocation records or Outbox work. An existing unique enrollment is never rotated or healed.
 */
export const enrollReleaseSystemWorkload = Effect.fn('ReleaseSystemWorkloads.enroll')(function* enroll(
  database: AccessIntentDatabase,
  input: ReleaseSystemWorkloadInput,
) {
  const { contract, tenantId, workloadKey } = yield* validateReleaseSystemWorkloadDeclaration(input);
  const moduleKey = contract.manifest.module.id;
  const actorId = releaseActorId(tenantId);
  const releases = yield* AccessReleaseStore;
  yield* releases
    .ensureReleaseActor({
      displayName: RELEASE_ACTOR_DISPLAY_NAME,
      principalId: actorId,
      tenantId,
    })
    .pipe(Effect.mapError((cause) => refused('The platform release actor could not be ensured', cause)));
  const resolver = yield* SystemPrincipalContextResolverFromCoreDatabase;
  const resolved = yield* resolver
    .resolve({
      principalId: actorId,
      registration: releaseJob,
      runReference: input.runReference,
      tenantId,
    })
    .pipe(Effect.mapError((cause) => refused('The platform release actor could not act', cause)));
  const scope: OperationalScope = preserveSystemPrincipalContextTrust(resolved, {
    ...resolved,
    correlationId: `release-system-workloads:${input.runReference}`,
  });
  const crypto = yield* Crypto.Crypto;
  return yield* runScoped(
    database,
    scope,
    noConstraints,
    Effect.fn('ReleaseSystemWorkloads.enrollUnderTenantLock')(
      function* enrollUnderTenantLock(transaction: Parameters<Parameters<typeof runScoped>[3]>[0]) {
        // Native enrollment helpers take Core's real scoped executor, never a cast of the raw transaction.
        const scoped = yield* installOperationalScope(transaction, scope, database.enrollment);
        yield* lockActiveTenantForEnrollment(scoped);
        yield* requireActiveTenantModule(scoped, moduleKey);
        const holder = yield* Effect.fromResult(
          soleSystemWorkloadHolder(yield* readSystemWorkloadEnrollmentHolders(scoped, workloadKey)),
        );
        const at = DateTime.toDateUtc(yield* DateTime.now);
        const enrollment = yield* Option.match(holder, {
          onNone: Effect.fn('ReleaseSystemWorkloads.createNativeEnrollment')(function* createNativeEnrollment() {
            const principalId = PrincipalIdSchema.make(yield* insertSystemWorkloadPrincipal(scoped, workloadKey));
            const bindingId = AccessWorkloadBindingIdSchema.make(yield* crypto.randomUUIDv4());
            const bindingIncarnation = AccessWorkloadBindingIdSchema.make(yield* crypto.randomUUIDv4());
            yield* registerWorkloadBindingsIn(scoped, scope, {
              bindings: [
                {
                  bindingId,
                  createdAt: at,
                  incarnation: bindingIncarnation,
                  principalId,
                  tenantId,
                  workloadKey,
                },
              ],
            });
            return { bindingId, bindingIncarnation, outcome: 'ENROLLED' as const, principalId };
          }),
          onSome: (existing) => Effect.succeed({ ...existing, outcome: 'ALREADY_ENROLLED' as const }),
        });
        yield* scoped.insert(auditEvents).values({
          auditProfile: 'sensitive',
          authContextRef: resolved.authContextRef,
          authMethod: 'system',
          eventType: 'core.identity.system-workload-enrolled-by-release',
          evidenceJson: {
            ...enrollment,
            moduleBuildMarker: contract.deployment.buildMarker,
            moduleKey,
            runReference: input.runReference,
            workloadKey,
          },
          outcome: 'succeeded',
          outcomeCode:
            enrollment.outcome === 'ENROLLED' ? 'system_workload_enrolled' : 'system_workload_already_enrolled',
          outcomeStage: 'execution',
          principalId: actorId,
          targetResourceId: workloadKey,
          targetResourceType: 'system-workload-enrollment',
          tenantId,
        });
        return {
          ...enrollment,
          moduleKey,
          releaseActorPrincipalId: actorId,
          runReference: input.runReference,
          tenantId,
          workloadKey,
        };
      },
      Effect.mapError((cause) =>
        intentUnavailable(
          'reason' in cause ? String(cause.reason) : 'Native SYSTEM enrollment could not be persisted',
          cause,
        ),
      ),
    ),
  ).pipe(Effect.mapError((cause) => refused(cause.reason, cause)));
});
