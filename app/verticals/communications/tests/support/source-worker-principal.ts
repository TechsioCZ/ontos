import {
  RegisteredGatewayWorkloadSchema,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { Schema } from 'effect';

/**
 * TEST-ONLY: the context Core hands the intake Action when a registered source worker calls it. Core seals the calling
 * module on the exact redeemed context; the shape is the Shell's signed registered-workload scope of a worker delivery,
 * with fictional identifiers. It is the real provenance carrier, so the tests exercise the same reader as production.
 */
export const SOURCE_WORKER_JOB = 'communications-intake-tests';

const baseWorkload = {
  admissionInvocationId: '60000000-0000-4000-8000-000000000002',
  bindingIncarnation: '60000000-0000-4000-8000-000000000003',
  declarationKey: 'communications.core.communication-request.submit',
  entrypointKey: 'communications.core.submit-communication-request',
  jobKey: SOURCE_WORKER_JOB,
  legalEntityScope: 'optional',
  originalOwnerBindingIncarnation: '60000000-0000-4000-8000-000000000006',
  originalPrincipalId: '40000000-0000-4000-8000-000000000002',
  originalWorkloadBindingIncarnation: '60000000-0000-4000-8000-000000000005',
  originalWorkloadKey: 'fixture.source-admit',
  runReference: '60000000-0000-4000-8000-000000000002',
  schemaVersion: '1',
  sourceAppId: 'fixture-source-app',
  sourceBuildMarker: 'fixture-build',
  workloadKey: 'communications.core.request-source',
} as const;

/** What a test may change about the sealed workload: the workload and declaration it names. Default: the Action's own. */
export interface SourceWorkerOverrides {
  readonly declarationKey?: string;
  readonly workloadKey?: string;
}

const decodeWorkload = Schema.decodeUnknownSync(RegisteredGatewayWorkloadSchema);
const workerWorkload = (callerModule: string, legalEntityId?: string, overrides: SourceWorkerOverrides = {}) => {
  const worker = {
    ...baseWorkload,
    ...overrides,
    claimId: 'fixture-claim',
    sourceMode: 'worker',
    workerKey: 'fixture.source-worker',
    workerModuleKey: callerModule,
  };
  return legalEntityId === undefined
    ? decodeWorkload(worker)
    : decodeWorkload({ ...worker, legalEntityId, legalEntityScope: 'required' });
};
/** An admission is an Action calling directly, not from a source's own delivery: no claim, no worker, no module. */
const admissionWorkload = () => decodeWorkload({ ...baseWorkload, sourceMode: 'admission' });

/** The principal, sealed as the registered worker of `callerModule` (the exact object is what Core's reader trusts). */
export const asSourceWorker = <Principal extends TrustedPrincipalContext>(
  principal: Principal,
  callerModule: string,
  compositionRevision: string,
  legalEntityId?: string,
  overrides?: SourceWorkerOverrides,
) =>
  trustVerifiedGatewayPrincipalContext(
    // a worker of one company fan-out: the tenant-local system principal plus the signed company of its workload
    legalEntityId === undefined ? principal : { ...principal, legalEntityId },
    compositionRevision,
    undefined,
    undefined,
    workerWorkload(callerModule, legalEntityId, overrides),
  );

/** A registered ADMISSION (an Action calling directly, not from a source's own Outbox delivery): it names no calling module. */
export const asSourceAdmission = <Principal extends TrustedPrincipalContext>(
  principal: Principal,
  compositionRevision: string,
): Principal =>
  trustVerifiedGatewayPrincipalContext(principal, compositionRevision, undefined, undefined, admissionWorkload());
