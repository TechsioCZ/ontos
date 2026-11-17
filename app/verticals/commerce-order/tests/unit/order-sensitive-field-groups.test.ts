import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { writtenFieldPaths } from '../../../../packages/core-runtime/src/actions/field-write-authorization.ts';
import { PrepareOrderCommitmentPayloadSchema } from '../../shared/actions/prepare-order-commitment.ts';
import { commitOrderAction } from '../../src/actions/commit-order.action.ts';
import { prepareOrderCommitmentAction } from '../../src/actions/prepare-order-commitment.action.ts';
import { committedOrderApprovalEvidenceRead } from '../../src/api/committed-order-approval-evidence.read.ts';
import { orderCommitmentStateRead } from '../../src/api/order-commitment-state.read.ts';
import { orderFinalizationWorkRead } from '../../src/api/order-finalization-work.read.ts';
import { preparedOrderApprovalBindingRead } from '../../src/api/prepared-order-approval-binding.read.ts';
import { preparedOrderPricingBindingRead } from '../../src/api/prepared-order-pricing-binding.read.ts';
import { verifyOrderCommitmentBindingRead } from '../../src/api/verify-order-commitment-binding.read.ts';
import { orderPreparationInput } from '../support/order-preparation-input.ts';

/** Every read in this module. */
const orderReads = [
  committedOrderApprovalEvidenceRead,
  orderCommitmentStateRead,
  orderFinalizationWorkRead,
  preparedOrderApprovalBindingRead,
  preparedOrderPricingBindingRead,
  verifyOrderCommitmentBindingRead,
] as const;

describe('commerce.order field groups', () => {
  it('withdraws every field_read group A1 reviewed until its path becomes optional', () => {
    for (const read of orderReads) {
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
});
