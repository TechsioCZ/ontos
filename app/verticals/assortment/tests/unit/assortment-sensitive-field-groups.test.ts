import { Schema, SchemaAST } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { writtenFieldPaths } from '../../../../packages/core-runtime/src/actions/field-write-authorization.ts';
import {
  CreateClosedAssortmentBoundaryPayloadSchema,
  ReplaceClosedAssortmentBoundaryPayloadSchema,
} from '../../shared/actions/boundary-administration.ts';
import {
  CreateApplicabilityBindingPayloadSchema,
  ReplaceApplicabilityBindingPayloadSchema,
} from '../../shared/actions/policy-administration.ts';
import {
  AssortmentConfigurationResponseSchema,
  AssortmentDecisionExplanationResponseSchema,
} from '../../shared/domain/governed-read-contracts.ts';
import { AssortmentPurchaseEvaluationResultSchema } from '../../shared/domain/ports/decision-evaluation.ts';
import { createApplicabilityBindingAction } from '../../src/actions/create-applicability-binding.action.ts';
import { createClosedAssortmentBoundaryAction } from '../../src/actions/create-closed-assortment-boundary.action.ts';
import { replaceApplicabilityBindingAction } from '../../src/actions/replace-applicability-binding.action.ts';
import { replaceClosedAssortmentBoundaryAction } from '../../src/actions/replace-closed-assortment-boundary.action.ts';
import { configurationRead } from '../../src/api/configuration.read.ts';
import { decisionExplanationRead } from '../../src/api/decision-explanation.read.ts';
import { purchaseRead } from '../../src/api/purchase.read.ts';

/**
 * Whether one declared path really addresses the schema (O58). A path through a union resolves when
 * any branch carries it (an Assortment configuration response is a union of four shapes), and through
 * an array element or a suspended schema as its element/definition, so the answer is the schema's own
 * shape and never a copied path list.
 */
const schemaHasPath = (schema: Schema.Constraint, path: readonly string[]): boolean => {
  const walk = (ast: SchemaAST.AST, segments: readonly string[]): boolean => {
    const [head, ...tail] = segments;
    if (head === undefined) {
      return true;
    }
    if (SchemaAST.isUnion(ast)) {
      return ast.types.some((member) => walk(member, segments));
    }
    if (SchemaAST.isSuspend(ast)) {
      return walk(ast.thunk(), segments);
    }
    if (SchemaAST.isArrays(ast)) {
      return [...ast.elements, ...ast.rest].some((element) => walk(element, segments));
    }
    if (!SchemaAST.isObjects(ast)) {
      return false;
    }
    const property = ast.propertySignatures.find((signature) => signature.name === head);
    return property !== undefined && walk(property.type, tail);
  };
  return walk(schema.ast, path);
};

/**
 * Whether the terminal property a result path names is optional in its schema (O17, O74). A field
 * grant is expressible only over an optional path: the runtime redacts by removing the governed
 * property and the transport then encodes the answer with the read's result schema, so a required
 * governed property would fail the encode (500) instead of returning a redacted 200.
 */
const terminalOptionality = (schema: Schema.Constraint, path: readonly string[]): boolean | 'missing' => {
  const walk = (ast: SchemaAST.AST, segments: readonly string[]): boolean | 'missing' => {
    const [head, ...tail] = segments;
    if (head === undefined) {
      return true;
    }
    if (SchemaAST.isUnion(ast)) {
      const results = ast.types.map((member) => walk(member, segments));
      if (results.some((result) => result === true)) {
        return true;
      }
      return results.every((result) => result === 'missing') ? 'missing' : false;
    }
    if (SchemaAST.isSuspend(ast)) {
      return walk(ast.thunk(), segments);
    }
    if (SchemaAST.isArrays(ast)) {
      const results = [...ast.elements, ...ast.rest].map((element) => walk(element, segments));
      if (results.some((result) => result === true)) {
        return true;
      }
      return results.every((result) => result === 'missing') ? 'missing' : false;
    }
    if (!SchemaAST.isObjects(ast)) {
      return 'missing';
    }
    const property = ast.propertySignatures.find((signature) => signature.name === head);
    if (property === undefined) {
      return 'missing';
    }
    return tail.length === 0 ? property.type.context?.isOptional === true : walk(property.type, tail);
  };
  return walk(schema.ast, path);
};

/** Every read in this module, with its declared result schema. */
const assortmentReads = [
  { read: configurationRead, schema: AssortmentConfigurationResponseSchema },
  { read: decisionExplanationRead, schema: AssortmentDecisionExplanationResponseSchema },
  { read: purchaseRead, schema: AssortmentPurchaseEvaluationResultSchema },
] as const;

/** Every Action field_write group with the class its owner declares. */
const assortmentActionGroups = [
  {
    actions: [
      createApplicabilityBindingAction,
      createClosedAssortmentBoundaryAction,
      replaceApplicabilityBindingAction,
      replaceClosedAssortmentBoundaryAction,
    ],
    classes: {
      'commerce.assortment.applicability-binding-replacement.customer-subject': 'personal_data',
      'commerce.assortment.applicability-binding-replacement.policy-detail': 'assortment_policy',
      'commerce.assortment.applicability-binding.customer-subject': 'personal_data',
      'commerce.assortment.applicability-binding.policy-detail': 'assortment_policy',
      'commerce.assortment.closed-assortment-boundary-replacement.customer-subject': 'personal_data',
      'commerce.assortment.closed-assortment-boundary-replacement.policy-detail': 'assortment_policy',
      'commerce.assortment.closed-assortment-boundary.customer-subject': 'personal_data',
      'commerce.assortment.closed-assortment-boundary.policy-detail': 'assortment_policy',
    },
  },
] as const;

describe('commerce.assortment sensitive field groups', () => {
  it('declares no field_read group over a required wire field (O17, O74)', () => {
    // The customer-subject and policy-detail paths the A1 review named are required by the shared wire
    // contracts, so the whole sensitive read is the gate. This guard fails the moment a declared group
    // governs a required path, or a path the schema does not carry.
    for (const { read, schema } of assortmentReads) {
      for (const group of read.descriptor.accessFieldGroups ?? []) {
        expect(group.kind).toBe('field_read');
        for (const field of group.fields) {
          expect(terminalOptionality(schema, field.split('.')), `${read.descriptor.readKey}: ${field}`).toBe(true);
        }
      }
    }
  });

  it('withdraws the reviewed read groups except the explanation policy detail, whose paths are optional', () => {
    // The decision explanation is the one read whose reviewed sensitive detail is optional in the
    // contract, so its policy-detail group survives; the configuration and purchase reads declare none.
    expect(configurationRead.descriptor.accessFieldGroups).toBeUndefined();
    expect(purchaseRead.descriptor.accessFieldGroups).toBeUndefined();

    const groups = decisionExplanationRead.descriptor.accessFieldGroups ?? [];
    expect(groups.map((group) => group.key)).toEqual(['commerce.assortment.decision-explanation.policy-detail']);
    const [group] = groups;
    expect(group).toMatchObject({
      fieldClass: 'assortment_policy',
      fields: ['evidence.boundaryPath', 'evidence.candidates'],
      kind: 'field_read',
      modes: ['run'],
      risk: 'sensitive',
      selectors: [],
    });
    expect(group?.key).not.toBe(decisionExplanationRead.descriptor.accessDeclaration?.key);
  });

  it('names result paths the read response schema really carries and can redact (O58)', () => {
    for (const { read, schema } of assortmentReads) {
      for (const group of read.descriptor.accessFieldGroups ?? []) {
        for (const field of group.fields) {
          expect(schemaHasPath(schema, field.split('.')), `${read.descriptor.readKey}: ${field}`).toBe(true);
          expect(terminalOptionality(schema, field.split('.')), `${read.descriptor.readKey}: ${field}`).toBe(true);
        }
      }
    }
  });

  it('declares exactly the reviewed Action field_write group keys with their own class (O19, O58)', () => {
    const declared = new Map<string, string>();
    for (const { actions } of assortmentActionGroups) {
      for (const action of actions) {
        for (const group of action.descriptor.accessFieldGroups ?? []) {
          expect(group.kind).toBe('field_write');
          expect(group.selectors).toEqual([]);
          expect(group.modes).toEqual(['run']);
          expect(group.risk).not.toBe('routine');
          expect(new Set(group.fields).size).toBe(group.fields.length);
          expect(group.key.startsWith('commerce.assortment.')).toBe(true);
          expect(group.key).not.toBe(action.descriptor.accessDeclaration?.key);
          declared.set(group.key, group.fieldClass);
        }
      }
    }
    expect(Object.fromEntries(declared)).toEqual(assortmentActionGroups[0].classes);
  });

  it('names payload paths the Action payload schema really carries (O58)', () => {
    const governedActions = [
      { action: createApplicabilityBindingAction, schema: CreateApplicabilityBindingPayloadSchema },
      { action: createClosedAssortmentBoundaryAction, schema: CreateClosedAssortmentBoundaryPayloadSchema },
      { action: replaceApplicabilityBindingAction, schema: ReplaceApplicabilityBindingPayloadSchema },
      { action: replaceClosedAssortmentBoundaryAction, schema: ReplaceClosedAssortmentBoundaryPayloadSchema },
    ] as const;
    for (const { action, schema } of governedActions) {
      for (const group of action.descriptor.accessFieldGroups ?? []) {
        for (const field of group.fields) {
          expect(schemaHasPath(schema, field.split('.')), `${action.descriptor.actionKey}: ${field}`).toBe(true);
        }
      }
    }
  });

  it('governs only the payload paths a request actually writes (O58)', () => {
    const group = (createApplicabilityBindingAction.descriptor.accessFieldGroups ?? []).find(
      (candidate) => candidate.key === 'commerce.assortment.applicability-binding.customer-subject',
    );
    if (group === undefined) {
      throw new Error('The Binding Action declares its customer-subject field group');
    }
    const payload = Schema.decodeUnknownSync(CreateApplicabilityBindingPayloadSchema)({
      audience: { kind: 'SHARED' },
      commercialScope: {
        channelRef: {
          moduleId: 'commerce.channel',
          resourceId: 'channel-1',
          resourceType: 'commerce.channel.channel',
          tenantId: '10000000-0000-4000-8000-000000000001',
        },
        sellingLegalEntityRef: {
          moduleId: 'party.registry',
          resourceId: '30000000-0000-4000-8000-000000000001',
          resourceType: 'party.registry.legal-entity',
          tenantId: '10000000-0000-4000-8000-000000000001',
        },
      },
      effectiveFrom: '2026-11-03T12:00:00.000Z',
      provenanceRef: 'assortment:binding:provenance',
      reason: 'Reviewed Binding creation',
      ruleRevisionRef: {
        ownerModuleId: 'commerce.assortment',
        revision: '1',
        sourceRef: {
          moduleId: 'commerce.assortment',
          resourceId: 'rule-revision-1',
          resourceType: 'commerce.assortment.rule-revision',
          tenantId: '10000000-0000-4000-8000-000000000001',
        },
      },
    });
    expect(writtenFieldPaths(group, payload)).toEqual([['audience']]);
    // Negative control: a payload that names no governed path asks for no field authority.
    expect(writtenFieldPaths(group, { reason: 'Reviewed' })).toEqual([]);
  });
});
