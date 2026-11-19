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

const workloadOf = (callerModule: string | undefined) =>
  Schema.decodeUnknownSync(RegisteredGatewayWorkloadSchema)({
    admissionInvocationId: '60000000-0000-4000-8000-000000000002',
    bindingIncarnation: '60000000-0000-4000-8000-000000000003',
    ...(callerModule === undefined ? {} : { claimId: 'fixture-claim' }),
    declarationKey: 'communications.core.submit-communication-request',
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
    sourceMode: callerModule === undefined ? 'admission' : 'worker',
    ...(callerModule === undefined ? {} : { workerKey: 'fixture.source-worker', workerModuleKey: callerModule }),
    workloadKey: 'communications.core.request-source',
  });

/** The principal, sealed as the registered worker of `callerModule` (the exact object is what Core's reader trusts). */
export const asSourceWorker = <Principal extends TrustedPrincipalContext>(
  principal: Principal,
  callerModule: string,
  compositionRevision: string,
): Principal =>
  trustVerifiedGatewayPrincipalContext(principal, compositionRevision, undefined, undefined, workloadOf(callerModule));

/** A registered ADMISSION (an Action calling directly, not from a source's own Outbox delivery): it names no calling module. */
export const asSourceAdmission = <Principal extends TrustedPrincipalContext>(
  principal: Principal,
  compositionRevision: string,
): Principal =>
  trustVerifiedGatewayPrincipalContext(principal, compositionRevision, undefined, undefined, workloadOf(undefined));
