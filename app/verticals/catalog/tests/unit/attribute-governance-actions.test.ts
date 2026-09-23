import type { ActionHandlerContext } from '@app/core-runtime';
import { ActionPermissionDenied, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import { makeActionTestHarness } from '@app/core-runtime/testing/actions';

import {
  CreateAttributeDefinitionPayloadSchema,
  CreateControlledAttributeValuePayloadSchema,
  ReactivateControlledAttributeValuePayloadSchema,
  RenameAttributeDefinitionPayloadSchema,
  RenameControlledAttributeValuePayloadSchema,
} from '../../shared/actions/attribute-governance.ts';
import { createAttributeDefinitionAction } from '../../src/actions/create-attribute-definition.action.ts';
import {
  createControlledAttributeValueAction,
  handleCreateControlledAttributeValue,
} from '../../src/actions/create-controlled-attribute-value.action.ts';
import { reactivateControlledAttributeValueAction } from '../../src/actions/reactivate-controlled-attribute-value.action.ts';
import { renameAttributeDefinitionAction } from '../../src/actions/rename-attribute-definition.action.ts';
import { renameControlledAttributeValueAction } from '../../src/actions/rename-controlled-attribute-value.action.ts';
import { retireControlledAttributeValueAction } from '../../src/actions/retire-controlled-attribute-value.action.ts';
import {
  AttributePersistenceConflict,
  AttributePersistenceNotFound,
} from '../../src/persistence/attribute-persistence.ts';
import type { AttributePersistence } from '../../src/persistence/attribute-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const definitionRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.attribute-definition',
  tenantId,
};
const controlledValueRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.controlled-attribute-value',
  tenantId,
} as const;
const unexpected = () => Effect.die('Unexpected persistence method');

describe('Catalog attribute governance Actions', () => {
  it.effect('denies a Product Editor without the definition Action executor before the definition handler runs', () =>
    Effect.gen(function* deniedDefinitionWrite() {
      const harness = yield* makeActionTestHarness({ actionPermission: 'denied' });
      const failure = yield* harness.runtime
        .runAction({
          payload: {
            label: 'Material',
            levels: ['PRODUCT'],
            meaning: 'Constituent material of the product',
            multiplicity: 'SINGLE',
            reason: 'Define shared product fact',
            specialStates: [],
            valueKind: 'TEXT',
          },
          principal: {
            authBindingId: '77777777-7777-4777-8777-777777777777',
            authContextRef: 'better-auth-session:product-editor-definition-denial',
            authMethod: 'session' as const,
            principalId: '44444444-4444-4444-8444-444444444444',
            tenantId,
          },
          registration: createAttributeDefinitionAction,
          transport: { correlationId: 'definition-denial', idempotencyKey: 'definition-denial-once' },
        })
        .pipe(Effect.flip);
      const snapshot = harness.snapshot();
      expect(Schema.is(ActionPermissionDenied)(failure)).toBe(true);
      expect(snapshot.permissionDenials).toHaveLength(1);
      expect(snapshot.invocations[0]).toMatchObject({ status: 'rejected' });
      expect(snapshot.transactionCount).toBe(0);
      expect(snapshot.stages).not.toContain('handler_executed');
      expect(snapshot.committed).toHaveLength(0);
    }),
  );

  it('requires an explicit stable meaning and valid shape for a new definition', () => {
    const base = {
      controlledValueKind: 'GENERAL',
      label: 'Material',
      levels: ['PRODUCT'],
      meaning: 'Constituent material of the product',
      multiplicity: 'MULTIPLE',
      reason: 'New shared product fact',
      specialStates: [],
      valueKind: 'CONTROLLED',
    };
    expect(Schema.is(CreateAttributeDefinitionPayloadSchema)(base)).toBe(true);
    expect(Schema.is(CreateAttributeDefinitionPayloadSchema)({ ...base, meaning: '' })).toBe(false);
    expect(Schema.is(CreateAttributeDefinitionPayloadSchema)({ ...base, reason: '' })).toBe(false);
  });

  it('does not allow a rename to silently change meaning', () => {
    const definitionRename = {
      attributeDefinitionRef: definitionRef,
      evidence: 'Same constituent material question',
      expectedRevision: 1,
      label: 'Product material',
      reason: 'Clarify label',
      sameMeaning: true,
    };
    const valueRename = {
      controlledValueRef,
      evidence: 'Typo correction only',
      expectedRevision: 1,
      label: 'Stainless steel',
      reason: 'Correct label',
      sameMeaning: true,
    };
    expect(Schema.is(RenameAttributeDefinitionPayloadSchema)(definitionRename)).toBe(true);
    expect(Schema.is(RenameControlledAttributeValuePayloadSchema)(valueRename)).toBe(true);
    expect(Schema.is(RenameAttributeDefinitionPayloadSchema)({ ...definitionRename, sameMeaning: false })).toBe(false);
    expect(Schema.is(RenameControlledAttributeValuePayloadSchema)({ ...valueRename, evidence: '' })).toBe(false);
  });

  it('requires Color-specific evidence and explicit reactivation review', () => {
    const base = {
      attributeDefinitionRef: definitionRef,
      label: 'Anthracite',
      meaning: 'Supplier shade A',
      reason: 'Add documented color',
      specialization: 'COLOR',
    };
    expect(Schema.is(CreateControlledAttributeValuePayloadSchema)(base)).toBe(false);
    expect(
      Schema.is(CreateControlledAttributeValuePayloadSchema)({
        ...base,
        color: {
          distinctionEvidence: {
            description: 'Supplier sample A',
            kind: 'OTHER',
            source: 'Supplier',
            sourceScope: 'Shade A',
          },
          preview: { hex: '#444444', kind: 'HEX' },
        },
      }),
    ).toBe(true);
    expect(
      Schema.is(ReactivateControlledAttributeValuePayloadSchema)({
        controlledValueRef,
        currentMeaningConfirmed: false,
        evidence: 'Review',
        expectedRevision: 2,
        reason: 'Restore use',
      }),
    ).toBe(false);
  });

  it.effect('retains Color group, preview, and scoped swatch at the handler/service boundary', () =>
    Effect.gen(function* colorMetadataHandoff() {
      const payload = Schema.decodeUnknownSync(CreateControlledAttributeValuePayloadSchema)({
        attributeDefinitionRef: definitionRef,
        color: {
          distinctionEvidence: {
            designation: 'A-42',
            kind: 'SWATCH',
            source: 'Supplier sample A documents this physical shade',
            sourceScope: 'Supplier 2026 matte finish',
            system: 'Supplier sample collection',
          },
          groupName: 'Grey',
          localizedNames: [{ locale: 'cs', name: 'Antracit' }],
          preview: { hex: '#444444', kind: 'HEX' },
        },
        label: 'Anthracite',
        meaning: 'Supplier shade A',
        reason: 'Add documented Color',
        specialization: 'COLOR',
      });
      const scope = {
        ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
          authContextRef: 'job:attribute-actions:run:1',
          authMethod: 'system',
          principalId: '44444444-4444-4444-8444-444444444444',
          tenantId,
        }),
        correlationId: 'attribute-color-handoff-test',
      };
      const services: AttributePersistence = {
        createControlledValue: (input) =>
          Effect.sync(() => {
            expect(input.color?.groupName).toBe('Grey');
            expect(input.color?.preview).toEqual({ hex: '#444444', kind: 'HEX' });
            expect(input.color?.distinctionEvidence).toMatchObject({
              designation: 'A-42',
              sourceScope: 'Supplier 2026 matte finish',
            });
            expect(input.color?.localizedNames).toEqual([{ locale: 'cs', name: 'Antracit' }]);
            expect(input.evidenceRefs).toContain('Supplier sample A documents this physical shade');
            return { controlledValueRef, revision: 1 };
          }),
        createDefinition: unexpected,
        reactivateControlledValue: unexpected,
        renameControlledValue: unexpected,
        renameDefinition: unexpected,
        retireControlledValue: unexpected,
        reviseDefinitionRules: unexpected,
      };
      const context: ActionHandlerContext<Readonly<Record<string, never>>, AttributePersistence> = {
        actionInvocationId: '55555555-5555-4555-8555-555555555555',
        addDomainEvent: () => Effect.succeed(Object.create(null)),
        addOutboxMessage: () => Effect.void,
        recordAuditEvidence: () => Effect.void,
        recordDataAccess: () => Effect.void,
        scope,
        services,
      };
      const result = yield* handleCreateControlledAttributeValue(payload, context);
      expect(result.controlledValueRef.resourceId).toBe(controlledValueRef.resourceId);
    }),
  );

  it('accepts reviewed localized Color rename without changing the controlled-value reference', () => {
    const payload = {
      controlledValueRef,
      evidence: 'The physical finish is unchanged',
      expectedRevision: 1,
      label: 'Snow white',
      localizedNames: [
        { locale: 'en', name: 'Snow white' },
        { locale: 'cs', name: 'Sněhově bílá' },
      ],
      reason: 'Correct display names',
      sameMeaning: true,
    };
    expect(Schema.is(RenameControlledAttributeValuePayloadSchema)(payload)).toBe(true);
    expect(
      Schema.is(RenameControlledAttributeValuePayloadSchema)({
        ...payload,
        localizedNames: [...payload.localizedNames, { locale: 'cs', name: 'Bílá' }],
      }),
    ).toBe(false);
  });

  it('keeps every governed mutation tenant-scoped, explicit-permission and idempotent', () => {
    for (const action of [
      createAttributeDefinitionAction,
      renameAttributeDefinitionAction,
      createControlledAttributeValueAction,
      renameControlledAttributeValueAction,
      retireControlledAttributeValueAction,
      reactivateControlledAttributeValueAction,
    ]) {
      expect(action.descriptor.entrypoint.scope).toBe('tenant');
      expect(action.descriptor.entrypoint.authorization).toEqual({
        kind: 'action_execution',
        provisioning: 'explicit',
      });
      expect(action.descriptor.legalEntityScope).toBe('forbidden');
      expect(action.descriptor.idempotency).toBe('required');
    }
  });

  it('declares typed conflict and missing-resource outcomes for governed changes', () => {
    const conflict = new AttributePersistenceConflict({
      code: 'attribute_persistence_conflict',
      conflict: 'REVISION',
      reason: 'Revision changed',
    });
    const missing = new AttributePersistenceNotFound({
      code: 'attribute_persistence_not_found',
      reason: 'Not found in trusted Tenant',
      resource: 'CONTROLLED_VALUE',
    });
    expect(Schema.is(renameAttributeDefinitionAction.descriptor.domainErrorSchema)(conflict)).toBe(true);
    expect(Schema.is(reactivateControlledAttributeValueAction.descriptor.domainErrorSchema)(missing)).toBe(true);
  });
});
