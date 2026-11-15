import { describe, expect, it } from 'effect-rstest';
import { Result, Schema } from 'effect';

import { SymmyJobStatusRequestSchema } from '../../shared/apis/symmy-job-status.ts';
import { AdmitSymmySyncPayloadSchema } from '../../shared/actions/admit-symmy-sync.ts';
import { AdmitSymmyJobPayloadSchema, AdmitSymmyJobResultSchema } from '../../shared/domain/symmy-job-admission.ts';
import { admitSymmyJobAction } from '../../src/actions/admit-symmy-job.action.ts';
import { symmyJobStatusRead } from '../../src/api/symmy-job-status.read.ts';

const parseAdmission = Schema.decodeUnknownResult(AdmitSymmyJobPayloadSchema, { onExcessProperty: 'error' });
const parseSyncAdmission = Schema.decodeUnknownResult(AdmitSymmySyncPayloadSchema, { onExcessProperty: 'error' });
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

  it('admits stock rows only on the stock route and never beside a plan or a fixture', () => {
    const stockRow = {
      businessObservedAt: '2026-01-01T10:00:00.000Z',
      itemKey: 'item-1',
      locationKey: 'warehouse-1',
      quantity: {
        amount: '12.5',
        unitRef: {
          moduleId: 'commerce.catalog',
          resourceId: '33333333-3333-4333-8333-333333333333',
          resourceType: 'commerce.catalog.product-unit',
          tenantId: '11111111-1111-4111-8111-111111111111',
        },
      },
      revision: 'r1',
      sourceReference: 'erp-1',
    };
    const stock = { idempotencyKey: 'stock-key', routeKey: 'inventoryStockBatch', stock: [stockRow] };
    expect(Result.isSuccess(parseSyncAdmission(stock))).toBe(true);
    expect(Result.isFailure(parseSyncAdmission({ ...stock, stock: [] }))).toBe(true);
    expect(Result.isFailure(parseSyncAdmission({ ...stock, stock: Array.from({ length: 17 }, () => stockRow) }))).toBe(
      true,
    );
    expect(Result.isFailure(parseSyncAdmission({ ...stock, stock: [{ ...stockRow, reservedQuantity: '1' }] }))).toBe(
      true,
    );
    expect(Result.isFailure(parseSyncAdmission({ idempotencyKey: 'stock-key', routeKey: 'inventoryStockBatch' }))).toBe(
      true,
    );
    expect(Result.isFailure(parseSyncAdmission({ ...stock, fixtureId: 'fixture-safe' }))).toBe(true);
    expect(Result.isFailure(parseSyncAdmission({ ...stock, contractVersion: 'INTERNAL_C14' }))).toBe(true);
    expect(Result.isFailure(parseSyncAdmission({ ...stock, routeKey: 'customerGroupsBatch' }))).toBe(true);
    expect(
      Result.isFailure(
        parseSyncAdmission({ fixtureId: 'fixture-safe', idempotencyKey: 'stock-key', routeKey: 'inventoryStockBatch' }),
      ),
    ).toBe(true);
    expect(
      Result.isSuccess(
        parseSyncAdmission({ fixtureId: 'fixture-safe', idempotencyKey: 'group-key', routeKey: 'customerGroupsBatch' }),
      ),
    ).toBe(true);
  });
});
