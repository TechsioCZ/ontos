import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { defineOntosModuleManifest } from '../../src/modules/manifest.ts';
import {
  OntosRegisteredWorkloadCallsSchema,
  registeredWorkloadCallReceiverIssue,
} from '../../src/modules/registered-workload-calls.ts';

const job = 'integration.symmy.execute-symmy-job';
// The shapes of origin/main 5608aae1d symmy-c14-customer-rules.mts.
const worker = {
  audience: 'party-registry',
  declarationKey: 'party.registry.party.create',
  entrypointKey: 'party.registry.create-party',
  jobKey: job,
  legalEntityScope: 'optional',
  schemaVersion: '1',
  workerKey: job,
  workloadKey: 'party.registry.source-write',
} as const;
const nested = {
  audience: 'privacy',
  declarationKey: 'privacy.core.source-processing-eligibility.read',
  entrypointKey: 'privacy.core.api.source-processing-eligibility',
  jobKey: job,
  legalEntityScope: 'required',
  schemaVersion: '1',
  sourceWorkloadKey: 'party.registry.source-write',
  workloadKey: 'privacy.core.source-processing-check',
} as const;
const recovery = {
  allowHistoricalDeliveryRecovery: true,
  audience: 'commerce-customer-context',
  declarationKey: 'commerce.customer-context.customer-profile-source.read',
  entrypointKey: 'commerce.customer-context.api.customer-profile-source',
  jobKey: job,
  legalEntityScope: 'required',
  recoveryOf: { actionKey: 'commerce.customer-context.ensure-retail-customer-profile', jobKey: job },
  schemaVersion: '1',
  workerKey: job,
  workloadKey: 'commerce.customer-context.source-read',
} as const;

const decodes = (calls: readonly unknown[]) =>
  Result.isSuccess(
    Schema.decodeUnknownResult(OntosRegisteredWorkloadCallsSchema, { onExcessProperty: 'error' })(calls),
  );

it('accepts exactly main fixture rule shapes, one call per caller mode', () => {
  expect(decodes([worker, nested, recovery])).toBe(true);
  // A paired nested mode (current and recovery source) is two calls, not a repetition.
  expect(decodes([nested, { ...nested, allowRecoverySource: true }])).toBe(true);
});

it('refuses repeated and ambiguous calls, fields main never had and malformed values', () => {
  expect(decodes([worker, worker])).toBe(false);
  expect(decodes([nested, { ...nested, allowRecoverySource: false }])).toBe(false);
  // A recovery that a worker and a historical delivery would both select twice.
  expect(decodes([recovery, { ...recovery, allowHistoricalDeliveryRecovery: false }])).toBe(false);
  expect(decodes([{ ...worker, principalId: 'chosen-by-the-caller' }])).toBe(false);
  expect(decodes([{ ...worker, legalEntityScope: 'any' }])).toBe(false);
  expect(decodes([{ ...worker, audience: 'Party Registry' }])).toBe(false);
  expect(decodes([{ ...worker, jobKey: '' }])).toBe(false);
  const { workerKey: _unused, ...modeless } = worker;
  expect(decodes([modeless])).toBe(false);
});

it('records validated calls in the defined manifest and rejects invalid ones at definition', () => {
  const base = {
    activation: {
      defaultState: 'inactive' as const,
      preservesHistoryWhenInactive: true,
      scope: 'tenant' as const,
      supportedStates: ['inactive', 'active'] as const,
    },
    module: {
      description: 'Fixture caller',
      displayName: 'Fixture caller',
      id: 'integration.symmy' as const,
      implementedAs: 'ultramodern_microvertical' as const,
      kind: 'business_module' as const,
    },
    publicSurface: {
      actions: [] as const,
      api: {},
      components: {},
      events: [] as const,
      reports: [] as const,
      resourceTypes: [] as const,
      search: [] as const,
      shellContributions: {
        mediaAttachments: [] as const,
        navigation: [] as const,
        pages: [] as const,
        publicComponents: [] as const,
        reports: [] as const,
        resourceDetails: [] as const,
        search: [] as const,
        timelines: [] as const,
      },
    },
  };
  const manifest = defineOntosModuleManifest({ ...base, registeredWorkloadCalls: [worker, nested] });
  expect(manifest.registeredWorkloadCalls).toEqual([worker, nested]);
  expect(Object.isFrozen(manifest.registeredWorkloadCalls)).toBe(true);
  expect(Object.hasOwn(defineOntosModuleManifest(base), 'registeredWorkloadCalls')).toBe(false);
  expect(() => defineOntosModuleManifest({ ...base, registeredWorkloadCalls: [worker, worker] })).toThrow();
});

const receiver = (
  carriers: {
    readonly accessActor?: { readonly subjectWorkloads?: readonly string[] };
    readonly accessDeclaration?: { readonly key: string };
    readonly accessWorkload?: { readonly workloads: readonly string[] };
  },
  appId = 'party-registry',
) => ({
  deployment: { appId },
  manifest: {
    publicSurface: {
      actions: [{ ...carriers, entrypoint: { entrypointKey: worker.entrypointKey }, schemaVersion: '1' }],
    },
  },
});
const declared = {
  accessDeclaration: { key: worker.declarationKey },
  accessWorkload: { workloads: [worker.workloadKey] },
};

it('takes a call only where the installed receiver declares its declaration and workload', () => {
  expect(registeredWorkloadCallReceiverIssue(worker, receiver(declared))).toBeUndefined();
  expect(
    registeredWorkloadCallReceiverIssue(
      worker,
      receiver({
        accessActor: { subjectWorkloads: [worker.workloadKey] },
        accessDeclaration: declared.accessDeclaration,
      }),
    ),
  ).toBeUndefined();
  expect(registeredWorkloadCallReceiverIssue(worker, receiver(declared, 'privacy'))).toMatch(/not installed/u);
  expect(registeredWorkloadCallReceiverIssue({ ...worker, schemaVersion: '2' }, receiver(declared))).toMatch(
    /no such operation version/u,
  );
  expect(
    registeredWorkloadCallReceiverIssue({ ...worker, workloadKey: 'party.registry.source-read' }, receiver(declared)),
  ).toMatch(/does not declare/u);
  expect(
    registeredWorkloadCallReceiverIssue(
      { ...worker, declarationKey: 'party.registry.party.update' },
      receiver(declared),
    ),
  ).toMatch(/does not declare/u);
  expect(registeredWorkloadCallReceiverIssue(worker, receiver({ accessWorkload: declared.accessWorkload }))).toMatch(
    /does not declare/u,
  );
});

it('reads a receiving read from its published workload carrier', () => {
  const read = (
    workloadCarrier: { readonly declarationKey: string; readonly workloads: readonly string[] } | null = null,
  ) => {
    const operation = { entrypoint: { entrypointKey: nested.entrypointKey }, schemaVersion: '1' };
    return {
      deployment: { appId: 'privacy' },
      manifest: {
        publicSurface: {
          actions: [],
          operationContracts: [workloadCarrier === null ? operation : { ...operation, workloadCarrier }],
        },
      },
    };
  };
  expect(
    registeredWorkloadCallReceiverIssue(
      nested,
      read({ declarationKey: nested.declarationKey, workloads: [nested.workloadKey] }),
    ),
  ).toBeUndefined();
  expect(registeredWorkloadCallReceiverIssue(nested, read())).toMatch(/does not declare/u);
  expect(
    registeredWorkloadCallReceiverIssue(
      nested,
      read({ declarationKey: nested.declarationKey, workloads: ['other.workload'] }),
    ),
  ).toMatch(/does not declare/u);
});
