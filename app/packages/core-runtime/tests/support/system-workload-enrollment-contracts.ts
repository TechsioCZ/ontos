import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';

import { buildInstalledModuleCatalog } from '../../src/modules/catalog.ts';
import { decodeOntosModuleDeploymentContract } from '../../src/modules/manifest.ts';
import type { OntosRegisteredWorkloadCallInput } from '../../src/modules/registered-workload-calls.ts';
import { fixtureActionAccess } from './access-declaration-fixtures.ts';

/*
 * The installed contracts the enrollment tests run against, decoded by Core's own contract decoder and catalog: a
 * worker module whose job calls a receiver (which makes a follow-up call for the same job to a reader), a module kept
 * inactive in the Tenant and a receiver that is not installed. The unit test proves these decode and derive the
 * identity the database test then expects.
 */
export const enrollmentWorkerModule = 'enrollment.worker';
export const enrollmentDormantModule = 'enrollment.dormant';
export const enrollmentJob = 'enrollment.worker.execute-job';
export const enrollmentDormantJob = 'enrollment.dormant.execute-job';
export const receiverWrite = 'enrollment.receiver.source-write';
export const readerRead = 'enrollment.reader.source-read';
export const readerAudit = 'enrollment.reader.source-audit';
export const dormantWrite = 'enrollment.dormant.source-write';
export const absentWrite = 'enrollment.absent.source-write';
const otherJob = 'enrollment.other.execute-job';
const receiverModule = 'enrollment.receiver';
const readerModule = 'enrollment.reader';
const absentModule = 'enrollment.absent';
const writeRecord = 'write-record';

const appIdOf = (moduleId: string) => `system-${moduleId.replaceAll('.', '-')}`;

/** An Action a registered workload call reaches: its declaration and the one workload it admits the call under. */
const receivingAction = (moduleId: string, slug: string, workloadKey: string) => ({
  accessDeclaration: { ...fixtureActionAccess(moduleId), key: `${moduleId}.${slug}.run` },
  accessWorkload: { reason: 'The enrolled worker of the fixture job', workloads: [workloadKey] },
  actionKey: `${moduleId}.${slug}`,
  auditProfile: 'standard' as const,
  entrypoint: {
    access: 'write' as const,
    authorization: { kind: 'action_execution' as const, provisioning: 'tenant_membership_default' as const },
    entrypointKey: `${moduleId}.${slug}`,
    moduleKey: moduleId,
    role: 'action' as const,
    scope: 'tenant' as const,
  },
  idempotency: 'required' as const,
  legalEntityScope: 'optional' as const,
  owningModuleId: moduleId,
  schemaVersion: '1',
});

/** A call to `receivingAction(moduleId, slug, workloadKey)` for a job, from its worker or as a follow-up. */
const callTo = (
  moduleId: string,
  slug: string,
  workloadKey: string,
  mode: { readonly jobKey: string } & ({ readonly workerKey: string } | { readonly sourceWorkloadKey: string }),
): OntosRegisteredWorkloadCallInput => ({
  audience: appIdOf(moduleId),
  declarationKey: `${moduleId}.${slug}.run`,
  entrypointKey: `${moduleId}.${slug}`,
  legalEntityScope: 'optional',
  schemaVersion: '1',
  workloadKey,
  ...mode,
});

const fromWorker = { jobKey: enrollmentJob, workerKey: enrollmentJob } as const;
const workerCalls = [
  callTo(receiverModule, writeRecord, receiverWrite, fromWorker),
  callTo(enrollmentDormantModule, writeRecord, dormantWrite, fromWorker),
  callTo(absentModule, writeRecord, absentWrite, fromWorker),
];
/** The receiver's follow-ups while it serves a call under its workload: one for this job, one for another job. */
const receiverCalls = [
  callTo(readerModule, 'read-record', readerRead, { jobKey: enrollmentJob, sourceWorkloadKey: receiverWrite }),
  callTo(readerModule, 'audit-record', readerAudit, { jobKey: otherJob, sourceWorkloadKey: receiverWrite }),
];

const contractOf = (input: {
  readonly actions?: readonly ReturnType<typeof receivingAction>[];
  readonly calls?: readonly OntosRegisteredWorkloadCallInput[];
  readonly moduleId: string;
  readonly systemWorkloads?: readonly string[];
}) => {
  const fixture = makeModuleContractFixture({
    appId: appIdOf(input.moduleId),
    buildMarker: 'system-workload-enrollment',
    moduleId: input.moduleId,
  });
  const contract = decodeOntosModuleDeploymentContract({
    ...fixture,
    manifest: {
      ...fixture.manifest,
      publicSurface: { ...fixture.manifest.publicSurface, actions: input.actions ?? [] },
      registeredWorkloadCalls: input.calls ?? [],
      systemWorkloads: input.systemWorkloads ?? [],
    },
  });
  return { contract, expectedAppId: contract.deployment.appId };
};

/** The installed catalog: `enrollment.absent` is not part of it. */
export const enrollmentCatalog = () =>
  buildInstalledModuleCatalog([
    contractOf({ calls: workerCalls, moduleId: enrollmentWorkerModule, systemWorkloads: [enrollmentJob] }),
    contractOf({
      actions: [receivingAction(receiverModule, writeRecord, receiverWrite)],
      calls: receiverCalls,
      moduleId: receiverModule,
    }),
    contractOf({
      actions: [
        receivingAction(readerModule, 'read-record', readerRead),
        receivingAction(readerModule, 'audit-record', readerAudit),
      ],
      moduleId: readerModule,
    }),
    contractOf({
      actions: [receivingAction(enrollmentDormantModule, writeRecord, dormantWrite)],
      moduleId: enrollmentDormantModule,
      systemWorkloads: [enrollmentDormantJob],
    }),
  ]);

/** The modules the Tenant of the tests has active at first: the dormant one is not. */
export const enrollmentActiveModules = [readerModule, receiverModule, enrollmentWorkerModule] as const;
