import { ScopedRoutineInvocationError } from '@app/core-runtime';
import { Effect, Match, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  RetailPriceGroupAssignmentOriginalCommandSchema,
  CounterpartyPriceGroupAssignmentOriginalCommandSchema,
  CustomerPriceGroupAssignmentReceiptRequestSchema,
} from '../../shared/apis/customer-price-group-assignment-receipt.ts';
import { AssignCustomerPriceGroupResultSchema } from '../../shared/actions/assign-customer-price-group.ts';
import {
  customerPriceGroupAssignmentReceiptCapture,
  customerPriceGroupAssignmentReceiptService,
  fingerprintAssignmentCommand,
} from '../../src/services/customer-price-group-assignment-receipt.service.ts';
import type { PriceGroupRoutineInvoker } from '../../src/persistence/price-group-persistence.ts';
import { readCustomerPriceGroupAssignmentReceipt } from '../../src/api/customer-price-group-assignment-receipt.read.ts';

const tenantId = 'c1131000-0000-4000-8000-000000000001';
const legalEntityId = 'c1131000-0000-4000-8000-000000000002';
const principalId = 'c1131000-0000-4000-8000-000000000003';
const invocationId = 'c1131000-0000-4000-8000-000000000004';
const profile = {
  kind: 'RETAIL',
  moduleId: 'commerce.customer-context',
  resourceId: 'retail-profile',
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
} as const;
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: 'group',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
};
const scope = {
  authContextRef: 'system:assignment-receipt-fixture',
  authMethod: 'system' as const,
  correlationId: 'assignment-receipt',
  legalEntityId,
  principalId,
  tenantId,
};
const command = Schema.decodeUnknownSync(RetailPriceGroupAssignmentOriginalCommandSchema)({
  _tag: 'RETAIL',
  payload: {
    effectiveFrom: '2027-01-01T00:00:00.000Z',
    expectedProfileRevision: 1,
    priceGroupRef,
    profile,
    reason: 'Explicit negotiated assignment',
  },
});
const result = Schema.decodeUnknownSync(AssignCustomerPriceGroupResultSchema)({
  assignment: {
    assignmentRef: {
      moduleId: 'commerce.customer-context',
      resourceId: 'assignment',
      resourceType: 'commerce.customer-context.customer-price-group-assignment',
      tenantId,
    },
    effectiveFrom: command.payload.effectiveFrom,
    effectiveTo: null,
    priceGroupRef,
    profile,
    reason: command.payload.reason,
    recordedAt: '2026-11-07T00:00:00.000Z',
    revision: 1,
    state: 'ACTIVE',
  },
  changed: true,
  replacedAssignmentRef: null,
});
const request = Schema.decodeUnknownSync(CustomerPriceGroupAssignmentReceiptRequestSchema)({
  actionInvocationId: invocationId,
  authorizationSubject: { kind: 'RETAIL' },
  originalCommand: command,
  profile,
});
const source = {
  effectId: 'explicit-price-group-assignment',
  issuer: 'internal-fixture',
  mappingRevision: 'mapping-1',
  namespace: 'customers',
  occurrenceId: 'occurrence-1',
  order: 1,
  recordId: 'customer-1',
  recordType: 'CUSTOMER',
  revision: 'source-1',
  route: { id: 'customers-import', revision: 'route-1' },
};
const sourcedCommand = Schema.decodeUnknownSync(RetailPriceGroupAssignmentOriginalCommandSchema)({
  ...command,
  payload: { ...command.payload, source },
});

const fixture = () => {
  let original: unknown;
  let conflict = false;
  const invoker: PriceGroupRoutineInvoker = {
    invoke: (routine, values) => {
      let rows: readonly object[];
      if (routine.name === 'record_customer_price_group_assignment_receipt') {
        original = [...values].at(3);
        rows = [{ outcome: conflict ? 'CONFLICT' : 'RECORDED' }];
      } else {
        rows = original === undefined ? [] : [{ receipt: original }];
      }
      return Schema.decodeUnknownEffect(Schema.Array(Schema.toType(routine.resultSchema)))(rows).pipe(
        Effect.mapError(
          () =>
            new ScopedRoutineInvocationError({
              code: 'scoped_routine_result_invalid',
              constraint: Option.none(),
              ownerModuleKey: routine.ownerModuleKey,
              postgresCode: Option.none(),
              reason: 'Invalid test receipt',
              routineKey: routine.routineKey,
            }),
        ),
      );
    },
  };
  return {
    conflict: () => {
      conflict = true;
    },
    invoker,
    original: () => original,
  };
};

it.effect('does not inspect a target profile before proving the exact original receipt', () =>
  Effect.gen(function* noProfileProbe() {
    let inspections = 0;
    const storage = fixture();
    const store = yield* customerPriceGroupAssignmentReceiptService(storage.invoker, scope, false);
    const response = yield* readCustomerPriceGroupAssignmentReceipt(request, {
      readKey: 'commerce.customer-context.api.customer-price-group-assignment-receipt',
      scope,
      services: {
        ...store,
        now: Effect.succeed(command.payload.effectiveFrom),
        profileValidation: {
          inspect: () =>
            Effect.sync(() => {
              inspections += 1;
              return { _tag: 'NOT_FOUND' } as const;
            }),
        },
      },
    });
    expect(inspections).toBe(0);
    expect(response).toEqual({ evidence: { resultCount: 0 }, result: { _tag: 'INDETERMINATE', retryCommand: false } });
  }),
);

it.effect('recovers the immutable original result without retaining free-form business text', () =>
  Effect.gen(function* originalResult() {
    const storage = fixture();
    const capture = customerPriceGroupAssignmentReceiptCapture(
      storage.invoker,
      scope,
      'commerce.customer-context.assign-customer-price-group',
    );
    yield* capture.captureAssignmentReceipt(invocationId, result, command);
    const store = yield* customerPriceGroupAssignmentReceiptService(storage.invoker, scope, false);
    const recovered = yield* store.readAssignmentReceipt(request);
    expect(
      Match.value(recovered).pipe(
        Match.tag('COMMITTED', ({ receipt }) => receipt.assignmentRef),
        Match.tag('INDETERMINATE', () => null),
        Match.exhaustive,
      ),
    ).toEqual(result.assignment.assignmentRef);
    expect(storage.original()).not.toHaveProperty('reason');
    expect(storage.original()).not.toHaveProperty('payload');
    expect(
      Match.value(recovered).pipe(
        Match.tag('COMMITTED', ({ receipt }) => receipt),
        Match.tag('INDETERMINATE', () => null),
        Match.exhaustive,
      ),
    ).not.toHaveProperty('recordedPrincipalId');
    expect(
      Match.value(recovered).pipe(
        Match.tag('COMMITTED', ({ receipt }) => receipt),
        Match.tag('INDETERMINATE', () => null),
        Match.exhaustive,
      ),
    ).toMatchObject({ changed: true, revision: 1 });
  }),
);

it.effect('does not equate a missing or changed original intent with permission to issue a new assignment', () =>
  Effect.gen(function* noUnsafeRetry() {
    const storage = fixture();
    const store = yield* customerPriceGroupAssignmentReceiptService(storage.invoker, scope, false);
    expect(
      Match.value(yield* store.readAssignmentReceipt(request)).pipe(
        Match.tag('COMMITTED', () => false),
        Match.tag('INDETERMINATE', ({ retryCommand }) => !retryCommand),
        Match.exhaustive,
      ),
    ).toBe(true);
    yield* customerPriceGroupAssignmentReceiptCapture(
      storage.invoker,
      scope,
      'commerce.customer-context.assign-customer-price-group',
    ).captureAssignmentReceipt(invocationId, result, command);
    const changed = {
      ...request,
      originalCommand: { ...command, payload: { ...command.payload, reason: 'Different original meaning' } },
    };
    expect(
      Match.value(yield* store.readAssignmentReceipt(changed)).pipe(
        Match.tag('COMMITTED', () => false),
        Match.tag('INDETERMINATE', ({ retryCommand }) => !retryCommand),
        Match.exhaustive,
      ),
    ).toBe(true);
    const foreign = yield* customerPriceGroupAssignmentReceiptService(
      storage.invoker,
      {
        ...scope,
        tenantId: 'c1131000-0000-4000-8000-000000000099',
      },
      false,
    );
    expect(
      Match.value(yield* foreign.readAssignmentReceipt(request)).pipe(
        Match.tag('COMMITTED', () => false),
        Match.tag('INDETERMINATE', ({ retryCommand }) => !retryCommand),
        Match.exhaustive,
      ),
    ).toBe(true);
    const anotherActor = yield* customerPriceGroupAssignmentReceiptService(
      storage.invoker,
      {
        ...scope,
        principalId: 'c1131000-0000-4000-8000-000000000088',
      },
      false,
    );
    expect(
      Match.value(yield* anotherActor.readAssignmentReceipt(request)).pipe(
        Match.tag('COMMITTED', () => false),
        Match.tag('INDETERMINATE', ({ retryCommand }) => !retryCommand),
        Match.exhaustive,
      ),
    ).toBe(true);
  }),
);

it.effect('fails the business transaction when immutable receipt capture conflicts', () =>
  Effect.gen(function* receiptConflict() {
    const storage = fixture();
    storage.conflict();
    const failure = yield* Effect.flip(
      customerPriceGroupAssignmentReceiptCapture(
        storage.invoker,
        scope,
        'commerce.customer-context.assign-customer-price-group',
      ).captureAssignmentReceipt(invocationId, result, command),
    );
    expect(failure.code).toBe('customer_price_group_persistence_unavailable');
  }),
);

it.effect('does not expose a legacy receipt without pinned qualified source through the source read carrier', () =>
  Effect.gen(function* unqualifiedLegacyReceipt() {
    const storage = fixture();
    yield* customerPriceGroupAssignmentReceiptCapture(
      storage.invoker,
      scope,
      'commerce.customer-context.assign-customer-price-group',
    ).captureAssignmentReceipt(invocationId, result, command);
    // The public Read obtains this factual branch from the actual Core transaction seal.
    const sourceRead = yield* customerPriceGroupAssignmentReceiptService(storage.invoker, scope, true);
    expect(
      Match.value(yield* sourceRead.readAssignmentReceipt(request)).pipe(
        Match.tag('COMMITTED', () => false),
        Match.tag('INDETERMINATE', ({ retryCommand }) => !retryCommand),
        Match.exhaustive,
      ),
    ).toBe(true);
  }),
);

it.effect('distinguishes every explicit native assignment field in original intent identity', () =>
  Effect.gen(function* exactIdentity() {
    const original = yield* fingerprintAssignmentCommand(command);
    for (const payload of [
      { ...command.payload, effectiveTo: '2027-02-01T00:00:00.000Z' },
      { ...command.payload, expectedProfileRevision: 2 },
      { ...command.payload, priceGroupRef: { ...priceGroupRef, resourceId: 'different-group' } },
      { ...command.payload, profile: { ...profile, resourceId: 'different-profile' } },
    ]) {
      expect(yield* fingerprintAssignmentCommand({ _tag: 'RETAIL', payload })).not.toBe(original);
    }
  }),
);

it.effect('does not accept a caller-shaped recovery object as signed original-actor authority', () =>
  Effect.gen(function* forgedRecovery() {
    const storage = fixture();
    yield* customerPriceGroupAssignmentReceiptCapture(
      storage.invoker,
      scope,
      'commerce.customer-context.assign-customer-price-group',
    ).captureAssignmentReceipt(invocationId, result, command);
    const untrustedScope = {
      ...scope,
      principalId: 'c1131000-0000-4000-8000-000000000088',
      recovery: { originalPrincipalId: scope.principalId },
    };
    const reader = yield* customerPriceGroupAssignmentReceiptService(storage.invoker, untrustedScope, false);
    expect(
      Match.value(yield* reader.readAssignmentReceipt(request)).pipe(
        Match.tag('COMMITTED', () => false),
        Match.tag('INDETERMINATE', ({ retryCommand }) => !retryCommand),
        Match.exhaustive,
      ),
    ).toBe(true);
  }),
);

it.effect('pins every qualified source component and never rebinds an original receipt to a replacement source', () =>
  Effect.gen(function* immutableSource() {
    const storage = fixture();
    yield* customerPriceGroupAssignmentReceiptCapture(
      storage.invoker,
      scope,
      'commerce.customer-context.assign-customer-price-group',
    ).captureAssignmentReceipt(invocationId, result, sourcedCommand);
    expect(storage.original()).toHaveProperty('source', source);
    expect(storage.original()).not.toHaveProperty('payload');
    const originalFingerprint = yield* fingerprintAssignmentCommand(sourcedCommand);
    expect(originalFingerprint).not.toBe(yield* fingerprintAssignmentCommand(command));
    const reader = yield* customerPriceGroupAssignmentReceiptService(storage.invoker, scope, false);
    for (const replacement of [
      { ...source, issuer: 'other-issuer' },
      { ...source, namespace: 'other-namespace' },
      { ...source, recordType: 'other-type' },
      { ...source, recordId: 'other-record' },
      { ...source, occurrenceId: 'other-occurrence' },
      { ...source, effectId: 'other-effect' },
      { ...source, mappingRevision: 'other-mapping' },
      { ...source, revision: 'other-revision' },
      { ...source, order: 2 },
      { ...source, route: { ...source.route, id: 'other-route' } },
      { ...source, route: { ...source.route, revision: 'other-route-revision' } },
    ]) {
      const replacementCommand = { ...sourcedCommand, payload: { ...sourcedCommand.payload, source: replacement } };
      expect(yield* fingerprintAssignmentCommand(replacementCommand)).not.toBe(originalFingerprint);
      expect(
        Match.value(yield* reader.readAssignmentReceipt({ ...request, originalCommand: replacementCommand })).pipe(
          Match.tag('COMMITTED', () => false),
          Match.tag('INDETERMINATE', ({ retryCommand }) => !retryCommand),
          Match.exhaustive,
        ),
      ).toBe(true);
    }
  }),
);

it.effect('fails closed when a caller invents a transaction-shaped source-carrier witness', () =>
  Effect.gen(function* missingCarrierSeal() {
    const storage = fixture();
    const services = customerPriceGroupAssignmentReceiptCapture(
      storage.invoker,
      scope,
      'commerce.customer-context.assign-customer-price-group',
    );
    const denied = yield* Effect.flip(services.validateAssignmentSource(command));
    expect(denied.code).toBe('customer_price_group_profile_unavailable');
    expect(storage.original()).toBeUndefined();
  }),
);

it.effect('pins company processing intent and requires its current governed capability again for recovery', () =>
  Effect.gen(function* companyReceiptIntent() {
    const counterpartyProfile = {
      ...profile,
      kind: 'COUNTERPARTY',
      resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
    };
    const counterpartyRef = {
      moduleId: 'party.registry',
      resourceId: 'company-counterparty',
      resourceType: 'party.registry.counterparty',
      tenantId,
    };
    const original = Schema.decodeUnknownSync(CounterpartyPriceGroupAssignmentOriginalCommandSchema)({
      _tag: 'COUNTERPARTY',
      payload: {
        counterpartyRef,
        effectiveFrom: command.payload.effectiveFrom,
        expectedProfileRevision: 1,
        priceGroupRef,
        processingKind: 'ORGANIZATION_BUSINESS',
        profile: counterpartyProfile,
        source,
      },
    });
    const companyResult = Schema.decodeUnknownSync(AssignCustomerPriceGroupResultSchema)({
      ...result,
      assignment: { ...result.assignment, profile: counterpartyProfile, reason: null },
    });
    const storage = fixture();
    yield* customerPriceGroupAssignmentReceiptCapture(
      storage.invoker,
      scope,
      'commerce.customer-context.assign-counterparty-price-group',
    ).captureAssignmentReceipt(invocationId, companyResult, original);
    expect(storage.original()).toHaveProperty('organizationBusiness', true);
    expect(storage.original()).not.toHaveProperty('reason');
    const exactRequest = Schema.decodeUnknownSync(CustomerPriceGroupAssignmentReceiptRequestSchema)({
      actionInvocationId: invocationId,
      authorizationSubject: { counterpartyRef, kind: 'COUNTERPARTY' },
      originalCommand: original,
      profile: counterpartyProfile,
    });
    const reader = yield* customerPriceGroupAssignmentReceiptService(storage.invoker, scope, true);
    const personal = Schema.decodeUnknownSync(CounterpartyPriceGroupAssignmentOriginalCommandSchema)({
      ...original,
      payload: { ...original.payload, processingKind: 'PERSONAL_DATA', reason: 'New personal intent' },
    });
    expect(
      Match.value(yield* reader.readAssignmentReceipt({ ...exactRequest, originalCommand: personal })).pipe(
        Match.tag('COMMITTED', () => false),
        Match.tag('INDETERMINATE', ({ retryCommand }) => !retryCommand),
        Match.exhaustive,
      ),
    ).toBe(true);
    expect((yield* Effect.flip(reader.readAssignmentReceipt(exactRequest))).code).toBe(
      'customer_price_group_profile_unavailable',
    );
  }),
);
