import { Option, Predicate, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  declaresSystemWorkload,
  enrolledWorkloadCalls,
  soleSystemWorkloadHolder,
  systemWorkloadIdentity,
} from '../../src/access/workloads/system-workload-enrollment.ts';
import { WorkloadKeySchema } from '../../src/authorization/access-declaration.ts';
import { changeSystemWorkloadEnrollmentAction } from '../../src/modules/actions/change-system-workload-enrollment.action.ts';
import { OntosRegisteredWorkloadCallSchema } from '../../src/modules/registered-workload-calls.ts';
import {
  absentWrite,
  dormantWrite,
  enrollmentActiveModules,
  enrollmentCatalog,
  enrollmentDormantModule,
  enrollmentJob,
  enrollmentWorkerModule,
  readerRead,
  receiverWrite,
} from '../support/system-workload-enrollment-contracts.ts';

const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const holder = (value: number, status: 'active' | 'disabled' = 'active') => ({
  bindingId: uid(value),
  bindingIncarnation: uid(value + 100),
  principalId: uid(value + 200),
  status,
});
const jobKey = 'integration.symmy.execute-symmy-job';
const call = (input: { readonly entrypointKey: string; readonly jobKey: string; readonly workloadKey: string }) =>
  Schema.decodeUnknownSync(OntosRegisteredWorkloadCallSchema)({
    audience: 'catalog',
    declarationKey: 'commerce.catalog.product.create',
    entrypointKey: input.entrypointKey,
    jobKey: input.jobKey,
    legalEntityScope: 'required',
    schemaVersion: '2',
    workerKey: input.jobKey,
    workloadKey: input.workloadKey,
  });
const declaring = (...keys: readonly string[]) => ({
  manifest: { systemWorkloads: keys.map((key) => WorkloadKeySchema.make(key)) },
});

it('keeps one holder per Tenant and workload, a disabled one included, and never chooses between two', () => {
  expect(soleSystemWorkloadHolder([])).toEqual(Result.succeed(Option.none()));
  expect(soleSystemWorkloadHolder([holder(1)])).toEqual(Result.succeed(Option.some(holder(1))));
  expect(soleSystemWorkloadHolder([holder(1, 'disabled')])).toEqual(Result.succeed(Option.some(holder(1, 'disabled'))));
  const two = soleSystemWorkloadHolder([holder(1), holder(2, 'disabled')]);
  expect(Result.isFailure(two)).toBe(true);
  expect(Result.match(two, { onFailure: (conflict) => conflict.code, onSuccess: () => 'chosen' })).toBe(
    'identity_lifecycle_conflict',
  );
});

it('enrolls only a system workload the installed module declares', () => {
  expect(declaresSystemWorkload(declaring(jobKey), jobKey)).toBe(true);
  // An owner workload the module calls under is not one of its system workloads.
  expect(declaresSystemWorkload(declaring(jobKey), 'commerce.catalog.symmy-product-import')).toBe(false);
  expect(declaresSystemWorkload(declaring(), jobKey)).toBe(false);
  expect(declaresSystemWorkload({ manifest: {} }, jobKey)).toBe(false);
});

it('lists the published calls an enrollment served: its job calls and the calls received under it, once each', () => {
  const contract = {
    manifest: {
      registeredWorkloadCalls: [
        call({
          entrypointKey: 'commerce.catalog.update-product',
          jobKey,
          workloadKey: 'commerce.catalog.symmy-product-import',
        }),
        call({
          entrypointKey: 'commerce.catalog.create-product',
          jobKey,
          workloadKey: 'commerce.catalog.symmy-product-import',
        }),
        call({
          entrypointKey: 'commerce.catalog.create-product',
          jobKey,
          workloadKey: 'commerce.catalog.symmy-product-read',
        }),
        call({
          entrypointKey: 'payment.core.accept-payment-observation',
          jobKey: 'payment.core.recover-gateway-operation',
          workloadKey: 'payment.source-ingress',
        }),
        call({
          entrypointKey: 'commerce.catalog.read-product',
          jobKey: 'other.job',
          workloadKey: 'commerce.catalog.read',
        }),
      ],
    },
  };
  expect(enrolledWorkloadCalls(contract, jobKey)).toEqual([
    { audience: 'catalog', entrypointKey: 'commerce.catalog.create-product', schemaVersion: '2' },
    { audience: 'catalog', entrypointKey: 'commerce.catalog.update-product', schemaVersion: '2' },
  ]);
  expect(enrolledWorkloadCalls(contract, 'payment.source-ingress')).toEqual([
    { audience: 'catalog', entrypointKey: 'payment.core.accept-payment-observation', schemaVersion: '2' },
  ]);
  expect(enrolledWorkloadCalls({ manifest: {} }, jobKey)).toEqual([]);
});

it('derives the whole declared worker identity from installed contracts and the Tenant active modules', () => {
  const { contracts } = enrollmentCatalog();
  const identity = (activeModuleKeys: readonly string[]) =>
    systemWorkloadIdentity({
      activeModuleKeys: new Set(activeModuleKeys),
      contracts,
      moduleKey: enrollmentWorkerModule,
      workloadKey: enrollmentJob,
    });
  // The receiver's workload, and the reader's that the receiver calls for this job from it; never the reader's
  // workload the receiver calls for another job.
  expect(identity(enrollmentActiveModules)).toEqual({
    bindable: [readerRead, receiverWrite],
    pending: [
      {
        calls: [
          {
            audience: 'system-enrollment-absent',
            entrypointKey: 'enrollment.absent.write-record',
            reason:
              'registered-workload call enrollment.absent.write-record@1 to system-enrollment-absent: the receiver is not installed',
            schemaVersion: '1',
          },
        ],
        workloadKey: absentWrite,
      },
      {
        calls: [
          {
            audience: 'system-enrollment-dormant',
            entrypointKey: 'enrollment.dormant.write-record',
            reason: 'enrollment.dormant is not active for this tenant',
            schemaVersion: '1',
          },
        ],
        workloadKey: dormantWrite,
      },
    ],
  });
  // Activated later, the dormant receiver's workload becomes bindable.
  expect(identity([...enrollmentActiveModules, enrollmentDormantModule]).bindable).toEqual([
    dormantWrite,
    readerRead,
    receiverWrite,
  ]);
  // A follow-up is reached only through a receiver that serves the job: with the receiver inactive, the reader's
  // workload is not part of the identity even though the reader is active.
  const withoutReceiver = identity(['enrollment.reader', enrollmentWorkerModule]);
  expect(withoutReceiver.bindable).toEqual([]);
  expect(withoutReceiver.pending.map(({ workloadKey }) => workloadKey)).toEqual([
    absentWrite,
    dormantWrite,
    receiverWrite,
  ]);
  // Another module's job, and a module that declares no calls, contribute nothing.
  expect(
    systemWorkloadIdentity({
      activeModuleKeys: new Set(enrollmentActiveModules),
      contracts,
      moduleKey: enrollmentDormantModule,
      workloadKey: 'enrollment.dormant.execute-job',
    }),
  ).toEqual({ bindable: [], pending: [] });
});

it('takes no Principal, kind or workload list from the caller, requires a reason and the module own key', () => {
  const decode = Schema.decodeUnknownSync(changeSystemWorkloadEnrollmentAction.descriptor.payloadSchema, {
    onExcessProperty: 'error',
  });
  const change = { moduleKey: 'integration.symmy', reason: 'Akros runs Symmy jobs', workloadKey: jobKey };
  const enroll = decode({ _tag: 'ENROLL', ...change });
  expect(Predicate.isTagged(enroll, 'ENROLL')).toBe(true);
  expect(enroll).toMatchObject(change);
  expect(Predicate.isTagged(decode({ _tag: 'END', ...change }), 'END')).toBe(true);
  expect(() => decode({ _tag: 'ENROLL', ...change, principalId: uid(1) })).toThrow();
  expect(() => decode({ _tag: 'ENROLL', ...change, kind: 'system' })).toThrow();
  expect(() =>
    decode({ _tag: 'ENROLL', ...change, workloadKeys: [jobKey, 'commerce.pricing.source-write'] }),
  ).toThrow();
  expect(() => decode({ _tag: 'ENROLL', moduleKey: change.moduleKey, workloadKey: jobKey })).toThrow();
  expect(() => decode({ _tag: 'REACTIVATE', ...change })).toThrow();
  // The key starts with the module key, for an end as for an enrollment.
  for (const _tag of ['ENROLL', 'END'] as const) {
    expect(() => decode({ _tag, ...change, workloadKey: 'commerce.pricing.source-write' })).toThrow(
      /must start with integration\.symmy\./u,
    );
    expect(() => decode({ _tag, ...change, moduleKey: 'integration.symmy.execute' })).toThrow();
  }
});
