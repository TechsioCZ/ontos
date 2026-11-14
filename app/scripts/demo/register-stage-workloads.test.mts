import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  planStageWorkloadRegistrations,
  StageWorkloadRegistrationsFileSchema,
  StageWorkloadStepSchema,
  stageWorkloadBindingIds,
  stageWorkloadCompanyIds,
  stageWorkloadPlanFingerprint,
} from './register-stage-workloads.mts';
import type { StageWorkloadStep } from './register-stage-workloads.mts';

const tenantId = 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9';
const ownerPrincipalId = '460651fe-38ad-5083-a6bc-f040dfdcd3b8';
const principalId = '183e774e-aa24-54e0-b524-f7ceac47c918';
const legalEntityId = 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7';
const inquiryKey = 'work.storefront-client';
const catalogKey = 'commerce.storefront-client';
const declared = new Set([catalogKey, inquiryKey]);
const file = {
  schemaVersion: 1 as const,
  tenants: [
    {
      ownerPrincipalId,
      tenantId,
      workloads: [{ legalEntityId, principalId, workloadKey: inquiryKey }],
    },
  ],
};
const decode = Schema.decodeUnknownResult(StageWorkloadRegistrationsFileSchema);
const plan = (value: typeof file) =>
  planStageWorkloadRegistrations(Schema.decodeUnknownSync(StageWorkloadRegistrationsFileSchema)(value), declared);

it('derives the identifiers the stage bootstrap and the live registrations already use', () => {
  // The rows a stage bootstrap wrote for this principal and key: a re-run must name the same ones.
  const binding = stageWorkloadBindingIds(tenantId, principalId, catalogKey);
  expect(binding.bindingId).toBe('0b9d1d52-80cc-8423-9517-d1e89d218b5f');
  expect(stageWorkloadCompanyIds(tenantId, binding.bindingId, legalEntityId).companyBindingId).toBe(
    '74fe8f2b-fd5c-8122-8a13-00b9e0995780',
  );
  expect(stageWorkloadBindingIds(tenantId, principalId, inquiryKey).bindingId).toBe(
    '2efb4948-8534-88e8-8347-d11a88841312',
  );
});

it('accepts only declared keys, once per principal, never for the owner itself', () => {
  const accepted = plan(file);
  expect(Result.isSuccess(accepted)).toBe(true);
  expect(Result.getOrThrow(accepted)).toHaveLength(1);
  const [tenant] = file.tenants;
  const [workload] = tenant?.workloads ?? [];
  if (workload === undefined || tenant === undefined) {
    throw new Error('fixture');
  }
  expect(
    Result.isFailure(
      plan({ ...file, tenants: [{ ...tenant, workloads: [{ ...workload, workloadKey: 'demo.unknown-client' }] }] }),
    ),
  ).toBe(true);
  expect(Result.isFailure(plan({ ...file, tenants: [{ ...tenant, workloads: [workload, { ...workload }] }] }))).toBe(
    true,
  );
  expect(
    Result.isFailure(
      plan({ ...file, tenants: [{ ...tenant, workloads: [{ ...workload, principalId: ownerPrincipalId }] }] }),
    ),
  ).toBe(true);
  expect(Result.isFailure(plan({ ...file, tenants: [tenant, tenant] }))).toBe(true);
});

it('refuses a file outside the documented shape', () => {
  expect(Result.isSuccess(decode(file))).toBe(true);
  expect(Result.isFailure(decode({ ...file, schemaVersion: 2 }))).toBe(true);
  expect(Result.isFailure(decode({ ...file, tenants: [] }))).toBe(true);
  const [tenant] = file.tenants;
  if (tenant === undefined) {
    throw new Error('fixture');
  }
  expect(Result.isFailure(decode({ ...file, tenants: [{ ...tenant, tenantId: 'not-a-tenant' }] }))).toBe(true);
  expect(
    Result.isFailure(
      decode({ ...file, tenants: [{ ...tenant, workloads: [{ legalEntityId, principalId, workloadKey: 'no key' }] }] }),
    ),
  ).toBe(true);
});

const print = (steps: readonly StageWorkloadStep[]) => Result.getOrThrow(stageWorkloadPlanFingerprint(steps));

it('fingerprints the plan independently of order, and changes with any write decision', () => {
  const step = Schema.decodeUnknownSync(StageWorkloadStepSchema)({
    bindingId: '2efb4948-8534-88e8-8347-d11a88841312',
    companyBindingId: '3a9b0dc8-ccb9-8c41-95e4-4d379c61bd70',
    legalEntityId,
    principalId,
    tenantId,
    workloadKey: inquiryKey,
    writeBinding: true,
    writeRegistration: true,
  });
  const other = Schema.decodeUnknownSync(StageWorkloadStepSchema)({
    ...step,
    principalId: '4e89699a-abaa-4a96-b769-b936028b9b0d',
  });
  expect(print([step, other])).toBe(print([other, step]));
  expect(print([step])).not.toBe(print([{ ...step, writeBinding: false }]));
});
