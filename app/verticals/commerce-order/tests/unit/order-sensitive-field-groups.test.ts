import { Option, Schema, SchemaAST } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { writtenFieldPaths } from '../../../../packages/core-runtime/src/actions/field-write-authorization.ts';
import { projectReadResultFields } from '../../../../packages/core-runtime/src/reads/definition.ts';
import { CommittedOrderApprovalEvidenceResponseSchema } from '../../../../packages/commerce-order-contracts/src/apis/committed-order-approval-evidence.ts';
import { PrepareOrderCommitmentPayloadSchema } from '../../shared/actions/prepare-order-commitment.ts';
import { OrderCommitmentStateResponseSchema } from '../../shared/apis/order-commitment-state.ts';
import { OrderFinalizationWorkResponseSchema } from '../../shared/apis/order-finalization-work.ts';
import { commitOrderAction } from '../../src/actions/commit-order.action.ts';
import { prepareOrderCommitmentAction } from '../../src/actions/prepare-order-commitment.action.ts';
import { committedOrderApprovalEvidenceRead } from '../../src/api/committed-order-approval-evidence.read.ts';
import { orderCommitmentStateRead } from '../../src/api/order-commitment-state.read.ts';
import { orderFinalizationWorkRead } from '../../src/api/order-finalization-work.read.ts';
import { preparedOrderApprovalBindingRead } from '../../src/api/prepared-order-approval-binding.read.ts';
import { preparedOrderPricingBindingRead } from '../../src/api/prepared-order-pricing-binding.read.ts';
import { verifyOrderCommitmentBindingRead } from '../../src/api/verify-order-commitment-binding.read.ts';
import { orderPreparationInput } from '../support/order-preparation-input.ts';

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
const orderReads = [
  { read: committedOrderApprovalEvidenceRead, schema: CommittedOrderApprovalEvidenceResponseSchema },
  { read: orderCommitmentStateRead, schema: OrderCommitmentStateResponseSchema },
  { read: orderFinalizationWorkRead, schema: OrderFinalizationWorkResponseSchema },
  { read: preparedOrderApprovalBindingRead, schema: CommittedOrderApprovalEvidenceResponseSchema },
  { read: preparedOrderPricingBindingRead, schema: CommittedOrderApprovalEvidenceResponseSchema },
  { read: verifyOrderCommitmentBindingRead, schema: CommittedOrderApprovalEvidenceResponseSchema },
] as const;

describe('commerce.order field groups', () => {
  it('declares no field_read group over a required wire field (O17, O74)', () => {
    // A field grant is only expressible over an optional result path. Every sensitive path these
    // reads return — order values, addresses, authority metadata — is required by the shared wire
    // contracts, so the whole sensitive read is the gate and no group is declared. This guard fails
    // the moment a declared group governs a required path, or a path the schema does not carry.
    for (const { read, schema } of orderReads) {
      for (const group of read.descriptor.accessFieldGroups ?? []) {
        expect(group.kind).toBe('field_read');
        for (const field of group.fields) {
          expect(terminalOptionality(schema, field.split('.')), `${read.descriptor.readKey}: ${field}`).toBe(true);
        }
      }
    }
  });

  it('withdraws every field_read group A1 reviewed until its path becomes optional', () => {
    for (const { read } of orderReads) {
      expect(read.descriptor.accessFieldGroups).toBeUndefined();
    }
    // The routine commitment-binding read returns bounded references and timestamps only (L11).
    expect(verifyOrderCommitmentBindingRead.descriptor.accessDeclaration?.key).toBe(
      'commerce.order.commitment-binding.verify',
    );
  });

  it('declares one financial-amounts field_write group on the preparation Action (O58)', () => {
    const groups = prepareOrderCommitmentAction.descriptor.accessFieldGroups ?? [];
    expect(groups.map((group) => group.key)).toEqual(['commerce.order.commitment.prepare-commercial-amounts']);
    const [group] = groups;
    expect(group).toMatchObject({
      fieldClass: 'financial_amounts',
      kind: 'field_write',
      modes: ['run'],
      risk: 'sensitive',
      selectors: [],
    });
    expect(prepareOrderCommitmentAction.descriptor.accessDeclaration?.key).toBe('commerce.order.commitment.prepare');
  });

  it('governs only the payload paths a request actually writes, and demands nothing for an absent one (O58)', () => {
    const [group] = prepareOrderCommitmentAction.descriptor.accessFieldGroups ?? [];
    if (group === undefined) {
      throw new Error('The preparation Action declares its commercial-amounts field group');
    }
    // A field_write group refuses a write (403) rather than redacting a response, so a required
    // payload path is expressible here: the check is whether the payload names the path at all.
    const written = writtenFieldPaths(group, orderPreparationInput());
    expect(written).toEqual([
      ['taxCandidate', 'pricing', 'publishedLines'],
      ['taxCandidate', 'shipping'],
    ]);

    // Negative control: a payload that names no governed path asks for no field authority, so a
    // caller who does not write the sensitive money is never refused for it.
    expect(writtenFieldPaths(group, { commitmentCorrelationId: 'correlation' })).toEqual([]);
    expect(Schema.is(PrepareOrderCommitmentPayloadSchema)(orderPreparationInput())).toBe(true);
  });

  it('keeps the ephemeral commit Action free of any field group', () => {
    // Commit consumes an already-prepared order and writes no human-owned field.
    expect(commitOrderAction.descriptor.accessFieldGroups).toBeUndefined();
  });

  it('projects a governed field out of a payload that carries typed values (O17, O74)', () => {
    // The runtime channel itself still redacts exactly the governed path and keeps every other value
    // the owner produced, including a DateTimeUtcFromString that is not JSON data.
    const result = Schema.decodeSync(CommittedOrderApprovalEvidenceResponseSchema)({
      buyerPrincipalId: '20000000-0000-4000-8000-000000000001',
      commitmentCorrelationId: 'commitment-correlation',
      committedAt: '2026-11-03T12:00:00.000Z',
      consumptionIntent: 'consumption-intent',
      counterpartyRef: {
        moduleId: 'commerce.customer-context',
        resourceId: 'counterparty',
        resourceType: 'commerce.customer-context.counterparty',
        tenantId: '40000000-0000-4000-8000-000000000001',
      },
      decisionBundleHash: 'a'.repeat(64),
      decisionBundleVersion: 'approval-decision-bundle.v1',
      finalBinding: {
        attemptRef: {
          moduleId: 'commerce.order',
          resourceId: 'attempt',
          resourceType: 'commerce.order.commitment-attempt',
          tenantId: '40000000-0000-4000-8000-000000000001',
        },
        bundleHash: 'a'.repeat(64),
        bundleRef: {
          moduleId: 'commerce.order',
          resourceId: 'bundle',
          resourceType: 'commerce.order.acceptance-bundle',
          tenantId: '40000000-0000-4000-8000-000000000001',
        },
        bundleVersion: 'order-acceptance-bundle.v1',
      },
      legalEntityId: '30000000-0000-4000-8000-000000000001',
      observedAt: '2026-11-03T12:00:01.000Z',
      orderRef: {
        moduleId: 'commerce.order',
        resourceId: 'order',
        resourceType: 'commerce.order.order',
        tenantId: '40000000-0000-4000-8000-000000000001',
      },
      proposalHash: 'a'.repeat(64),
      proposalRevisionRef: {
        moduleId: 'commerce.customer-context',
        resourceId: 'revision',
        resourceType: 'commerce.customer-context.purchase-proposal-revision',
        tenantId: '40000000-0000-4000-8000-000000000001',
      },
      provenance: 'commerce.order.committed-approval-evidence.v1',
      requestRef: {
        moduleId: 'commerce.customer-context',
        resourceId: 'request',
        resourceType: 'commerce.customer-context.purchase-approval-request',
        tenantId: '40000000-0000-4000-8000-000000000001',
      },
      revalidationRef: {
        moduleId: 'commerce.customer-context',
        resourceId: 'revalidation',
        resourceType: 'commerce.customer-context.approval-revalidation',
        tenantId: '40000000-0000-4000-8000-000000000001',
      },
      storefrontId: 'storefront-1',
      tenantId: '40000000-0000-4000-8000-000000000001',
      validUntil: '2026-11-03T12:00:06.000Z',
    });
    const deniedPaths = [['buyerPrincipalId']];

    const permitted = Option.getOrThrow(
      projectReadResultFields(result, [], CommittedOrderApprovalEvidenceResponseSchema),
    );
    expect(permitted).toEqual(result);

    const projected = Option.getOrThrow(
      projectReadResultFields(result, deniedPaths, CommittedOrderApprovalEvidenceResponseSchema),
    );
    expect(projected).not.toHaveProperty('buyerPrincipalId');
    expect(projected.orderRef).toEqual(result.orderRef);
    expect(projected.committedAt).toBe(result.committedAt);
  });
});
