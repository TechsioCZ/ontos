import { describe, expect, it } from 'effect-rstest';
import { Result, Schema } from 'effect';

import { SymmyJobStatusRequestSchema } from '../../shared/apis/symmy-job-status.ts';
import { AdmitSymmySyncPayloadSchema } from '../../shared/actions/admit-symmy-sync.ts';
import { AdmitSymmyJobPayloadSchema, AdmitSymmyJobResultSchema } from '../../shared/domain/symmy-job-admission.ts';
import { SymmyInternalExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import { admitSymmyJobAction } from '../../src/actions/admit-symmy-job.action.ts';
import { symmyJobStatusRead } from '../../src/api/symmy-job-status.read.ts';

const parseAdmission = Schema.decodeUnknownResult(AdmitSymmyJobPayloadSchema, { onExcessProperty: 'error' });
const parseSyncAdmission = Schema.decodeUnknownResult(AdmitSymmySyncPayloadSchema, { onExcessProperty: 'error' });
const parsePoll = Schema.decodeUnknownResult(SymmyJobStatusRequestSchema, { onExcessProperty: 'error' });
const parseReceipt = Schema.decodeUnknownResult(AdmitSymmyJobResultSchema, { onExcessProperty: 'error' });

/** A Commerce customer context owner operation of an internal plan effect. */
const commerceOperation = (entrypointKey: string) => ({
  entrypointKey,
  moduleId: 'commerce.customer-context',
  schemaVersion: '1',
});
/** An internal plan of one customer source record that states the given owner effects. */
const customerPlan = (...effects: readonly unknown[]) => ({
  items: [
    {
      effects,
      itemKey: 'customer-1',
      source: {
        entityKind: 'CUSTOMER',
        issuerId: 'internal-symmy',
        sourceNamespace: 'customers',
        sourceRecordId: 'customer-1',
      },
      sourceOccurrenceId: 'occurrence-1',
    },
  ],
});

describe('Symmy internal job owner contracts', () => {
  it('keeps tenant, principal, source authority and pins outside submitted fixture data', () => {
    const admission = { fixtureId: 'fixture-safe', idempotencyKey: 'submitted-key', routeKey: 'customersBatch' };
    expect(Result.isSuccess(parseAdmission(admission))).toBe(true);
    expect(Result.isFailure(parseAdmission({ ...admission, routeKey: 'productsBatch' }))).toBe(true);
    expect(Result.isFailure(parseAdmission({ ...admission, routeRevision: '2' }))).toBe(true);
    expect(Result.isFailure(parseAdmission({ ...admission, tenantId: 'unverified' }))).toBe(true);
    expect(Result.isFailure(parseAdmission({ ...admission, idempotencyKey: '   ' }))).toBe(true);
    expect(Result.isFailure(parseAdmission({ ...admission, code: 'unneeded' }))).toBe(true);
    expect(Result.isFailure(parseAdmission({ ...admission, routeKey: 'inventoryStockBatch' }))).toBe(true);
    expect(Result.isFailure(parseAdmission({ ...admission, routeKey: 'customerGroupCustomersBatch' }))).toBe(true);
    // The customer group route takes only its public customers, never a fixture.
    expect(
      Result.isFailure(
        parseAdmission({ ...admission, code: 'customer-group', routeKey: 'customerGroupCustomersBatch' }),
      ),
    ).toBe(true);
    // The prices route is no longer coded and takes only the public price batch.
    expect(Result.isFailure(parseAdmission({ ...admission, routeKey: 'priceListPricesBatch' }))).toBe(true);
    expect(
      Result.isFailure(parseAdmission({ ...admission, code: 'price-list', routeKey: 'priceListPricesBatch' })),
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

  it('admits the public customers only on the customers route and never beside a plan or a fixture', () => {
    const customers = [
      {
        addresses: [],
        contacts: [],
        customerId: 'customer-1',
        firstName: 'Jana',
        kind: 'PERSON',
        lastName: 'Nováková',
        officialIdentifiers: [],
      },
    ];
    const admission = { customers, idempotencyKey: 'customers-key', routeKey: 'customersBatch' };
    expect(Result.isSuccess(parseAdmission(admission))).toBe(true);
    expect(Result.isFailure(parseAdmission({ ...admission, customers: [] }))).toBe(true);
    expect(Result.isFailure(parseAdmission({ ...admission, fixtureId: 'fixture-safe' }))).toBe(true);
    expect(Result.isFailure(parseAdmission({ ...admission, contractVersion: 'INTERNAL_C14' }))).toBe(true);
    expect(Result.isFailure(parseAdmission({ ...admission, routeKey: 'productsBatch' }))).toBe(true);
    expect(Result.isFailure(parseAdmission({ ...admission, routeKey: 'priceListsBatchUpsert' }))).toBe(true);
    expect(
      Result.isFailure(
        parseAdmission({ ...admission, code: 'customer-group', routeKey: 'customerGroupCustomersBatch' }),
      ),
    ).toBe(true);
    // A request no plan can hold never reaches the owner: 17 customers, or customers and addresses beyond 16 items.
    expect(
      Result.isFailure(parseAdmission({ ...admission, customers: Array.from({ length: 17 }, () => customers[0]) })),
    ).toBe(true);
    const postalAddress = { addressLine1: 'Ulice 1', city: 'Praha', countryCode: 'CZ', postalCode: '11000' };
    const withAddresses = (count: number) => ({
      ...customers[0],
      addresses: Array.from({ length: count }, () => ({ postalAddress, purposes: ['BILLING'] })),
    });
    expect(Result.isSuccess(parseAdmission({ ...admission, customers: [withAddresses(10), withAddresses(4)] }))).toBe(
      true,
    );
    expect(Result.isFailure(parseAdmission({ ...admission, customers: [withAddresses(10), withAddresses(5)] }))).toBe(
      true,
    );
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
      Result.isFailure(
        parseSyncAdmission({ fixtureId: 'fixture-safe', idempotencyKey: 'group-key', routeKey: 'customerGroupsBatch' }),
      ),
    ).toBe(true);
  });

  it('admits the public customer groups only on the group route and only with their definition facts', () => {
    const group = {
      businessCode: 'WHOLESALE_BUYERS',
      code: 'symmy-wholesale',
      description: 'Customers the source classifies as wholesale buyers',
      meaningKey: 'symmy.wholesale-buyers',
      membershipCriteria: 'The source explicitly assigns each wholesale buyer',
      name: 'Wholesale buyers',
      purpose: 'Wholesale buyer classification',
    };
    const groups = {
      customerGroups: [group],
      groupFacts: [],
      idempotencyKey: 'group-key',
      routeKey: 'customerGroupsBatch',
    };
    expect(Result.isSuccess(parseSyncAdmission(groups))).toBe(true);
    expect(Result.isFailure(parseSyncAdmission({ ...groups, routeKey: 'inventoryStockBatch' }))).toBe(true);
    const { groupFacts: _facts, ...withoutFacts } = groups;
    expect(Result.isFailure(parseSyncAdmission(withoutFacts))).toBe(true);
    expect(Result.isFailure(parseSyncAdmission({ ...groups, customerGroups: [] }))).toBe(true);
    expect(Result.isFailure(parseSyncAdmission({ ...groups, customerGroups: [group, group] }))).toBe(true);
    expect(Result.isFailure(parseSyncAdmission({ ...groups, customerGroups: [{ ...group, code: ' padded' }] }))).toBe(
      true,
    );
    expect(
      Result.isFailure(parseSyncAdmission({ ...groups, customerGroups: [{ ...group, businessCode: 'lower' }] })),
    ).toBe(true);
    expect(Result.isFailure(parseSyncAdmission({ ...groups, contractVersion: 'INTERNAL_C14' }))).toBe(true);
    expect(Result.isFailure(parseSyncAdmission({ ...groups, fixtureId: 'fixture-safe' }))).toBe(true);
  });

  it('admits the customers of a selected group only on the coded route, by distinct profile UUID', () => {
    const profileRef = {
      moduleId: 'commerce.customer-context',
      resourceId: 'abcdef00-6666-4666-8666-666666666666',
      resourceType: 'commerce.customer-context.retail-customer-profile',
      tenantId: '11111111-1111-4111-8111-111111111111',
    };
    const customer = { profile: { profileKind: 'RETAIL', profileRef } };
    const members = {
      code: 'customer-group',
      groupCustomers: [customer],
      idempotencyKey: 'members-key',
      routeKey: 'customerGroupCustomersBatch',
    };
    expect(Result.isSuccess(parseAdmission(members))).toBe(true);
    const { code: _code, ...withoutCode } = members;
    expect(Result.isFailure(parseAdmission(withoutCode))).toBe(true);
    expect(Result.isFailure(parseAdmission({ ...members, routeKey: 'customersBatch' }))).toBe(true);
    expect(Result.isFailure(parseAdmission({ ...members, fixtureId: 'fixture-safe' }))).toBe(true);
    expect(Result.isFailure(parseAdmission({ ...members, groupCustomers: [] }))).toBe(true);
    const upper = {
      profile: { ...customer.profile, profileRef: { ...profileRef, resourceId: profileRef.resourceId.toUpperCase() } },
    };
    // Two spellings of one profile are one customer.
    expect(Result.isFailure(parseAdmission({ ...members, groupCustomers: [customer, upper] }))).toBe(true);
    const notUuid = { profile: { ...customer.profile, profileRef: { ...profileRef, resourceId: 'customer-1' } } };
    expect(Result.isFailure(parseAdmission({ ...members, groupCustomers: [notUuid] }))).toBe(true);
    const distinct = (index: number) => ({
      profile: {
        ...customer.profile,
        profileRef: {
          ...profileRef,
          resourceId: `abcdef${String(index).padStart(2, '0')}-6666-4666-8666-666666666666`,
        },
      },
    });
    expect(
      Result.isSuccess(
        parseAdmission({ ...members, groupCustomers: Array.from({ length: 16 }, (_, index) => distinct(index)) }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        parseAdmission({ ...members, groupCustomers: Array.from({ length: 17 }, (_, index) => distinct(index)) }),
      ),
    ).toBe(true);
  });

  it('admits an internal plan on the coded route only when it states no customer group definition or membership', () => {
    const tenantId = '11111111-1111-4111-8111-111111111111';
    const profileRef = {
      moduleId: 'commerce.customer-context',
      resourceId: 'abcdef00-6666-4666-8666-666666666666',
      resourceType: 'commerce.customer-context.retail-customer-profile',
      tenantId,
    };
    const groupRef = {
      moduleId: 'commerce.customer-context',
      resourceId: 'abcdef01-6666-4666-8666-666666666666',
      resourceType: 'commerce.customer-context.customer-group',
      tenantId,
    };
    const route = { id: 'source-route', revision: 'route-1' };
    const assignment = {
      effectKey: 'price-group-assignment',
      intent: {
        _tag: 'AssignCustomerPriceGroup',
        authorizationSubject: { kind: 'RETAIL' },
        payload: {
          effectiveFrom: '2026-11-20T00:00:00.000Z',
          expectedProfileRevision: 1,
          priceGroupRef: {
            moduleId: 'pricing.price-group-catalog',
            resourceId: 'abcdef02-6666-4666-8666-666666666666',
            resourceType: 'pricing.price-group-catalog.price-group',
            tenantId,
          },
          profile: { ...profileRef, kind: 'RETAIL' },
          reason: 'Explicit internal assignment',
          source: {
            effectId: 'ASSIGNED_BY_NATIVE_ADMISSION',
            issuer: 'internal-symmy',
            mappingRevision: 'mapping-1',
            namespace: 'customers',
            occurrenceId: 'occurrence-1',
            order: 1,
            recordId: 'customer-1',
            recordType: 'CUSTOMER',
            revision: 'source-1',
            route,
          },
        },
      },
      operation: commerceOperation('commerce.customer-context.assign-customer-price-group'),
    };
    const membership = {
      effectKey: 'customer-group-membership',
      intent: {
        _tag: 'CustomerGroupMembership',
        payload: {
          effectiveAt: '2026-11-20T00:00:00.000Z',
          groupRef,
          manager: {
            factFamily: 'CUSTOMER_GROUP_MEMBERSHIP',
            issuer: 'internal-symmy',
            sourceNamespace: 'memberships',
            tenantId,
          },
          operation: 'ASSIGN',
          profile: { profileKind: 'RETAIL', profileRef },
          reason: 'Explicit internal membership',
          route,
          source: {
            assertionId: 'occurrence-1',
            effectId: 'ASSIGNED_BY_NATIVE_ADMISSION',
            order: 1,
            sourceRecordId: 'm-1',
          },
        },
      },
      operation: commerceOperation('commerce.customer-context.apply-customer-group-membership-source'),
    };
    const definition = {
      businessCode: 'INTERNAL_GROUP',
      description: 'Internal source grouping',
      membershipCriteria: 'Explicit source group membership',
      name: 'Internal buyers',
      purpose: 'Buyer classification',
      reason: 'Internal conformance fixture',
    };
    const groupCreate = {
      effectKey: 'customer-group-create',
      intent: {
        _tag: 'CustomerGroupCreate',
        payload: { ...definition, initialState: 'ACTIVE', meaningKey: 'source-buyer-classification' },
      },
      operation: commerceOperation('commerce.customer-context.create-customer-group'),
    };
    const { businessCode: _businessCode, ...revision } = definition;
    const groupUpdate = {
      effectKey: 'customer-group-update',
      intent: { _tag: 'CustomerGroupUpdate', payload: { ...revision, expectedRevision: 1, groupRef } },
      operation: commerceOperation('commerce.customer-context.update-customer-group'),
    };
    const internal = {
      code: 'customer-group',
      contractVersion: 'INTERNAL_C14',
      idempotencyKey: 'plan-key',
      plan: customerPlan(assignment),
      routeKey: 'customerGroupCustomersBatch',
    };
    // A price group assignment has no public body, so the selected group route still carries it in an internal plan.
    expect(Result.isSuccess(parseAdmission(internal))).toBe(true);
    const { code: _code, ...withoutCode } = internal;
    expect(Result.isFailure(parseAdmission(withoutCode))).toBe(true);
    expect(Result.isFailure(parseAdmission({ ...internal, fixtureId: 'fixture-safe' }))).toBe(true);
    const { profile } = membership.intent.payload;
    expect(Result.isFailure(parseAdmission({ ...internal, groupCustomers: [{ profile }] }))).toBe(true);
    // Each effect is a valid owner intent on its own, so only the restriction refuses it.
    for (const effect of [membership, groupCreate, groupUpdate]) {
      expect(Result.isSuccess(Schema.decodeUnknownResult(SymmyInternalExecutionPlanSchema)(customerPlan(effect)))).toBe(
        true,
      );
      expect(Result.isFailure(parseAdmission({ ...internal, plan: customerPlan(effect) })), effect.effectKey).toBe(
        true,
      );
      expect(
        Result.isFailure(parseAdmission({ ...internal, plan: customerPlan(assignment, effect) })),
        effect.effectKey,
      ).toBe(true);
    }
  });
});
