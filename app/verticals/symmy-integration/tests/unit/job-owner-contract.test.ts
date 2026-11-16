import { describe, expect, it } from 'effect-rstest';
import { Result, Schema } from 'effect';

import { SymmyJobStatusRequestSchema } from '../../shared/apis/symmy-job-status.ts';
import { AdmitSymmyJobPayloadSchema, AdmitSymmyJobResultSchema } from '../../shared/domain/symmy-job-admission.ts';
import { admitSymmyJobAction } from '../../src/actions/admit-symmy-job.action.ts';
import { symmyJobStatusRead } from '../../src/api/symmy-job-status.read.ts';

const parseAdmission = Schema.decodeUnknownResult(AdmitSymmyJobPayloadSchema, { onExcessProperty: 'error' });
const parsePoll = Schema.decodeUnknownResult(SymmyJobStatusRequestSchema, { onExcessProperty: 'error' });
const parseReceipt = Schema.decodeUnknownResult(AdmitSymmyJobResultSchema, { onExcessProperty: 'error' });

describe('Symmy internal job owner contracts', () => {
  it('keeps tenant, principal, source authority and pins outside submitted fixture data', () => {
    const admission = { fixtureId: 'fixture-safe', idempotencyKey: 'submitted-key', routeKey: 'productsBatch' };
    expect(Result.isSuccess(parseAdmission(admission))).toBe(true);
    expect(Result.isFailure(parseAdmission({ ...admission, routeRevision: '2' }))).toBe(true);
    expect(Result.isFailure(parseAdmission({ ...admission, tenantId: 'unverified' }))).toBe(true);
    expect(Result.isFailure(parseAdmission({ ...admission, idempotencyKey: '   ' }))).toBe(true);
    expect(Result.isFailure(parseAdmission({ ...admission, code: 'unneeded' }))).toBe(true);
    expect(Result.isFailure(parseAdmission({ ...admission, routeKey: 'inventoryStockBatch' }))).toBe(true);
    expect(Result.isFailure(parseAdmission({ ...admission, routeKey: 'priceListPricesBatch' }))).toBe(true);
    expect(
      Result.isSuccess(parseAdmission({ ...admission, code: 'price-list', routeKey: 'priceListPricesBatch' })),
    ).toBe(true);
  });

  it('uses separate exact workload markers and gives poll only an opaque job selector', () => {
    expect(admitSymmyJobAction.descriptor.accessWorkload?.workloads).toEqual(['integration.symmy-admit']);
    expect(symmyJobStatusRead.descriptor.accessWorkload?.workloads).toEqual(['integration.symmy-poll']);
    const jobId = '00000000-0000-4000-8000-000000000001';
    expect(Result.isSuccess(parsePoll({ jobId }))).toBe(true);
    expect(Result.isFailure(parsePoll({ jobId, principalId: 'unverified' }))).toBe(true);
    expect(Result.isSuccess(parseReceipt({ jobId, phase: 'admitted' }))).toBe(true);
    expect(Result.isFailure(parseReceipt({ jobId, phase: 'completed' }))).toBe(true);
  });
});
