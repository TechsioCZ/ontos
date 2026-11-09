import { Effect, Match, Schema } from 'effect';
import { createActionCollector, getActionHandler } from '@app/core-runtime/testing/actions';
import { expect, it } from 'effect-rstest';
import { CreateCustomerGroupPayloadSchema } from '../../shared/actions/create-customer-group.ts';
import { UpdateCustomerGroupPayloadSchema } from '../../shared/actions/update-customer-group.ts';
import { CustomerGroupDefinitionSourceRejected } from '../../shared/domain/group-contract.ts';
import { CustomerGroupRefSchema } from '../../shared/resources/customer-group.ts';
import { makeCustomerGroup, reviseCustomerGroup } from '../../shared/domain/group-service.ts';
import type { CustomerGroupPersistence } from '../../shared/domain/group-service.ts';
import { CustomerGroupPersistenceUnavailable } from '../../shared/domain/group-errors.ts';
import { customerGroupServiceFactory } from '../../src/actions/customer-group-action-support.ts';
import type { CustomerGroupScopedRoutineInvoker } from '../../src/persistence/group-persistence.ts';
import { createCustomerGroupAction } from '../../src/actions/create-customer-group.action.ts';
import { updateCustomerGroupAction } from '../../src/actions/update-customer-group.action.ts';
import { mapCreateCustomerGroupActionProblem } from '../../api/create-customer-group-action-problems.ts';

const source = {
  definitionEvidence: { kind: 'NAMED_CONFIGURATION', reference: 'internal.explicit-assignment', revision: '1' },
  effectId: 'internal-effect-1',
  issuer: 'internal-ebs',
  mappingRevision: 'internal-mapping-1',
  namespace: 'customer-groups',
  order: 1,
  recordId: 'group-77',
  revision: '1',
  route: { id: 'internal-definition-route', revision: '1' },
  sourceCode: 'LOYAL',
};
const definition = {
  businessCode: 'INTERNAL_LOYAL',
  description: 'Group explicitly maintained by the internal fixture EBS',
  initialState: 'ACTIVE',
  meaningKey: 'internal.explicit-assignment',
  membershipCriteria: 'Explicit membership maintained by the internal fixture EBS',
  name: 'Loyal customers',
  purpose: 'Internal fixture EBS customer classification',
  reason: 'Import revision 1 of the internal fixture source Group',
  source,
};

it.effect('requires actual Group business fields and qualified source evidence without inventing defaults', () =>
  Effect.gen(function* groupDefinitionContracts() {
    const payload = yield* Schema.decodeUnknownEffect(CreateCustomerGroupPayloadSchema)(definition);
    expect(payload.source).toEqual(source);
    expect(Schema.is(CreateCustomerGroupPayloadSchema)({ name: definition.name, source })).toBe(false);
    expect(Schema.is(CreateCustomerGroupPayloadSchema)({ ...definition, purpose: '' })).toBe(false);
    expect(Schema.is(CreateCustomerGroupPayloadSchema)({ ...definition, source: { ...source, recordId: '' } })).toBe(
      false,
    );
    expect(Schema.is(CreateCustomerGroupPayloadSchema)({ ...definition, source: { ...source, order: -1 } })).toBe(
      false,
    );
    const group = makeCustomerGroup({
      ...payload,
      groupRef: yield* Schema.decodeUnknownEffect(CustomerGroupRefSchema)({
        moduleId: 'commerce.customer-context',
        resourceId: 'df000000-0000-4000-8000-000000000001',
        resourceType: 'commerce.customer-context.customer-group',
        tenantId: 'df000000-0000-4000-8000-000000000002',
      }),
      recordedAt: '2026-11-07T10:00:00.000Z',
    });
    const update = yield* Schema.decodeUnknownEffect(UpdateCustomerGroupPayloadSchema)({
      ...definition,
      expectedRevision: 1,
      groupRef: group.groupRef,
      name: 'Renamed loyal customers',
      source: { ...source, effectId: 'internal-effect-2', order: 2, revision: '2' },
    });
    const renamed = reviseCustomerGroup(group, { ...update, recordedAt: '2026-11-07T10:01:00.000Z' });
    expect(
      Match.value(renamed).pipe(
        Match.tag('updated', (value) => {
          expect(value).toMatchObject({
            changed: true,
            group: { groupRef: group.groupRef, meaningKey: group.meaningKey },
          });
          return true;
        }),
        Match.orElse(() => false),
      ),
    ).toBe(true);
    const materialChange = reviseCustomerGroup(group, {
      ...update,
      membershipCriteria: 'Different membership meaning',
      recordedAt: '2026-11-07T10:01:00.000Z',
    });
    expect(
      Match.value(materialChange).pipe(
        Match.tag('new_group_required', () => true),
        Match.orElse(() => false),
      ),
    ).toBe(true);
  }),
);

it('publishes bounded typed source conflicts through the generated Action HTTP contract', () => {
  const result = mapCreateCustomerGroupActionProblem(
    new CustomerGroupDefinitionSourceRejected({
      code: 'customer_group_source_conflict',
      reason: 'Internal fixture conflict',
    }),
  );
  expect(result).toMatchObject({ code: 'customer_group_source_conflict', status: 409 });
  expect(JSON.stringify(result)).not.toContain('Internal fixture conflict');
});

it.effect('refuses the manual Group path for a source workload before any owner service runs', () =>
  Effect.gen(function* machineRequiresSourceContext() {
    const payload = yield* Schema.decodeUnknownEffect(CreateCustomerGroupPayloadSchema)(definition);
    const { source: declaredSource, ...manualPayload } = payload;
    expect(declaredSource).toEqual(source);
    let calls = 0;
    const unavailable = () => {
      calls += 1;
      return Effect.fail(
        new CustomerGroupPersistenceUnavailable({
          code: 'customer_group_persistence_unavailable',
          reason: 'Unexpected owner service call',
        }),
      );
    };
    const services: CustomerGroupPersistence = {
      archive: unavailable,
      assign: unavailable,
      create: unavailable,
      detail: unavailable,
      effectiveMemberships: unavailable,
      history: unavailable,
      members: unavailable,
      reactivate: unavailable,
      remove: unavailable,
      update: unavailable,
    };
    const collector = createActionCollector(
      { ...createCustomerGroupAction.descriptor.domainEvents, ...updateCustomerGroupAction.descriptor.domainEvents },
      'commerce.customer-context',
      createCustomerGroupAction.descriptor.accessEvidencePolicy,
      createCustomerGroupAction.descriptor.auditEvidenceSchema,
    );
    const context = {
      actionInvocationId: 'de000000-0000-4000-8000-000000000001',
      addDomainEvent: collector.addDomainEvent,
      addOutboxMessage: collector.addOutboxMessage,
      compositionRevision: 'd'.repeat(64),
      recordAuditEvidence: collector.recordAuditEvidence,
      recordDataAccess: collector.recordDataAccess,
      scope: {
        authMethod: 'system' as const,
        correlationId: 'internal-machine-no-source',
        legalEntityId: 'de000000-0000-4000-8000-000000000002',
        principalId: 'de000000-0000-4000-8000-000000000003',
        tenantId: 'de000000-0000-4000-8000-000000000004',
      },
      services,
    };
    const createFailure = yield* Effect.flip(getActionHandler(createCustomerGroupAction)(manualPayload, context));
    expect(createFailure).toBeInstanceOf(CustomerGroupDefinitionSourceRejected);
    expect(createFailure).toMatchObject({ code: 'customer_group_source_authority_denied' });
    const updatePayload = yield* Schema.decodeUnknownEffect(UpdateCustomerGroupPayloadSchema)({
      ...manualPayload,
      expectedRevision: 1,
      groupRef: {
        moduleId: 'commerce.customer-context',
        resourceId: 'de000000-0000-4000-8000-000000000005',
        resourceType: 'commerce.customer-context.customer-group',
        tenantId: context.scope.tenantId,
      },
    });
    const updateFailure = yield* Effect.flip(getActionHandler(updateCustomerGroupAction)(updatePayload, context));
    expect(updateFailure).toBeInstanceOf(CustomerGroupDefinitionSourceRejected);
    expect(updateFailure).toMatchObject({ code: 'customer_group_source_authority_denied' });
    expect(calls).toBe(0);
    expect(collector.snapshot().domainEvents).toHaveLength(0);
  }),
);

it.effect('refuses caller-shaped API-key source carriers before manual Group persistence', () =>
  Effect.gen(function* unsealedGroupSourceCarrierDenied() {
    let calls = 0;
    const invoker: CustomerGroupScopedRoutineInvoker = {
      invoke: (routine) => {
        calls += 1;
        return Effect.succeed(Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))([]));
      },
    };
    const scope = {
      authContextRef: 'api-key:internal-source',
      authMethod: 'api_key' as const,
      correlationId: 'unsealed-group-source',
      legalEntityId: 'de000000-0000-4000-8000-000000000002',
      principalId: 'de000000-0000-4000-8000-000000000003',
      tenantId: 'de000000-0000-4000-8000-000000000004',
      workloadKeys: ['commerce.customer-context.source-write'],
    };
    const services = yield* customerGroupServiceFactory(invoker, scope);
    const { source: assertion, ...manual } = definition;
    expect(assertion).toEqual(source);
    const payload = yield* Schema.decodeUnknownEffect(CreateCustomerGroupPayloadSchema)(manual);
    const command = {
      ...payload,
      actionInvocationId: 'de000000-0000-4000-8000-000000000001',
      legalEntityId: scope.legalEntityId,
      principalId: scope.principalId,
      recordedAt: '2026-11-07T10:00:00.000Z',
      tenantId: scope.tenantId,
    };
    expect(yield* Effect.flip(services.create(command))).toBeInstanceOf(CustomerGroupPersistenceUnavailable);
    expect(calls).toBe(0);
  }),
);
