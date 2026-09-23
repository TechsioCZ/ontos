import type { ActionHandlerContext } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { ReviseAttributeDefinitionPayloadSchema } from '../../shared/actions/revise-attribute-definition.ts';
import {
  handleReviseAttributeDefinition,
  reviseAttributeDefinitionAction,
} from '../../src/actions/revise-attribute-definition.action.ts';
import type { AttributePersistence } from '../../src/persistence/attribute-persistence.ts';
import { CatalogPersistenceUnavailable } from '../../src/persistence/errors.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const definitionRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.attribute-definition',
  tenantId,
} as const;
const payload = Schema.decodeUnknownSync(ReviseAttributeDefinitionPayloadSchema)({
  attributeDefinitionRef: definitionRef,
  evidence: 'Same measured property; reviewed rule change',
  expectedRevision: 2,
  proposed: {
    levels: ['PRODUCT', 'VARIANT'],
    measurement: { canonicalUnit: 'mm', decimalPlaces: 1, quantity: 'length' },
    multiplicity: 'SINGLE',
    specialStates: ['UNKNOWN'],
  },
  reason: 'Change precision for future use',
  sameMeaning: true,
});
const unexpected = () => Effect.die('Unexpected persistence method');
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:revise-attribute-definition:run:1',
    authMethod: 'system',
    principalId: '33333333-3333-4333-8333-333333333333',
    tenantId,
  }),
  correlationId: 'revise-attribute-definition-test',
};

const contextWith = (reviseDefinitionRules: AttributePersistence['reviseDefinitionRules']) => {
  const services: AttributePersistence = {
    createControlledValue: unexpected,
    createDefinition: unexpected,
    reactivateControlledValue: unexpected,
    renameControlledValue: unexpected,
    renameDefinition: unexpected,
    retireControlledValue: unexpected,
    reviseDefinitionRules,
  };
  const context: ActionHandlerContext<Readonly<Record<string, never>>, AttributePersistence> = {
    actionInvocationId: '44444444-4444-4444-8444-444444444444',
    addDomainEvent: () => Effect.succeed(Object.create(null)),
    addOutboxMessage: () => Effect.void,
    recordAuditEvidence: () => Effect.void,
    recordDataAccess: () => Effect.void,
    scope,
    services,
  };
  return context;
};

describe('revise Attribute Definition Action', () => {
  it('accepts only a reviewed same-meaning rule proposal and exact revision', () => {
    expect(Schema.is(ReviseAttributeDefinitionPayloadSchema)(payload)).toBe(true);
    expect(Schema.is(ReviseAttributeDefinitionPayloadSchema)({ ...payload, sameMeaning: false })).toBe(false);
    expect(Schema.is(ReviseAttributeDefinitionPayloadSchema)({ ...payload, expectedRevision: 0 })).toBe(false);
    expect(Schema.is(ReviseAttributeDefinitionPayloadSchema)({ ...payload, evidence: '' })).toBe(false);
    expect(
      Schema.is(ReviseAttributeDefinitionPayloadSchema)({
        ...payload,
        proposed: { ...payload.proposed, measurement: { canonicalUnit: '', decimalPlaces: 1, quantity: 'length' } },
      }),
    ).toBe(false);
  });

  it.effect('hands only rule fields and same-meaning evidence to the owner', () =>
    Effect.gen(function* handoff() {
      const context = contextWith((input) =>
        Effect.sync(() => {
          expect(input.attributeDefinitionRef).toEqual(definitionRef);
          expect(input.expectedRevision).toBe(2);
          expect(input.proposed).toEqual(payload.proposed);
          expect(input.evidenceRefs).toEqual([payload.evidence]);
          expect(input.sameMeaning).toBe(true);
          return { attributeDefinitionRef: definitionRef, changed: false, revision: 2 };
        }),
      );
      expect(yield* handleReviseAttributeDefinition(payload, context)).toMatchObject({ changed: false, revision: 2 });
    }),
  );

  it('requires exact permission and idempotency and declares typed failure', () => {
    expect(reviseAttributeDefinitionAction.descriptor.entrypoint.authorization).toEqual({
      kind: 'action_execution',
      provisioning: 'explicit',
    });
    expect(reviseAttributeDefinitionAction.descriptor.idempotency).toBe('required');
    expect(reviseAttributeDefinitionAction.descriptor.legalEntityScope).toBe('forbidden');
    expect(
      Schema.is(reviseAttributeDefinitionAction.descriptor.domainErrorSchema)(
        new CatalogPersistenceUnavailable({ code: 'catalog_persistence_unavailable', reason: 'unavailable' }),
      ),
    ).toBe(true);
  });
});
