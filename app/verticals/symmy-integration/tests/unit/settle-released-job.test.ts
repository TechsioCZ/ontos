import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  releasedJobSettlement,
  SymmyReleasedJobEffectSchema,
  SymmyReleasedJobItemSchema,
} from '../../src/administration/settle-released-job.ts';

const customer = '3d31746d-ce29-4a53-ba81-f7519bd34549';
const contact = '2cf27784-a6d7-49a5-897e-52c6344e5d30';
const address = '69c63450-5f86-4586-b5de-cbe6cb6c991c';
const items = Schema.decodeUnknownSync(Schema.Array(SymmyReleasedJobItemSchema))([
  { itemId: customer, itemKey: 'customer-0' },
  { itemId: contact, itemKey: 'contact-0-0' },
  { itemId: address, itemKey: 'address-0-0' },
]);
const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
/** A dependency the way the settlement reads it: a bare effect key of the same item has no item key. */
const on = (effectKey: string, itemKey: string | null = null) => ({ effectKey, itemKey });
const effect = (
  index: number,
  itemId: string,
  effectKey: string,
  dependsOn: readonly ReturnType<typeof on>[],
  state = 'planned',
  status: string | null = null,
) =>
  Schema.decodeUnknownSync(SymmyReleasedJobEffectSchema)({
    dependsOn,
    effectId: id(index),
    effectKey,
    executorPrincipalId: null,
    itemId,
    noReceipt: true,
    requestHash: null,
    state,
    status,
    unclaimed: true,
    version: 0,
  });

describe('a released Symmy job settles as its worker would have', () => {
  it('denies an uncertain Party create and leaves everything behind it unsupported', () => {
    const settlement = releasedJobSettlement(
      [
        effect(1, customer, 'party-create', [], 'indeterminate'),
        effect(2, customer, 'counterparty-onboard', [on('party-create')]),
        effect(3, customer, 'counterparty-profile', [on('counterparty-onboard')]),
        effect(4, contact, 'contact-add', [on('party-create', 'customer-0')]),
        effect(5, address, 'address-add', [
          on('counterparty-onboard', 'customer-0'),
          on('counterparty-profile', 'customer-0'),
        ]),
      ],
      items,
    );
    expect(Object.fromEntries(settlement)).toEqual({
      [id(1)]: 'denied',
      [id(2)]: 'unsupported',
      [id(3)]: 'unsupported',
      [id(4)]: 'unsupported',
      [id(5)]: 'unsupported',
    });
  });

  it('denies an unfinished effect whose dependencies were accepted and keeps settled work out of it', () => {
    const settlement = releasedJobSettlement(
      [
        effect(1, customer, 'party-create', [], 'settled', 'accepted_change'),
        effect(2, customer, 'counterparty-profile', [on('party-create')], 'settled', 'accepted_no_change'),
        effect(3, customer, 'ico-set', [on('counterparty-profile')], 'indeterminate'),
        effect(4, contact, 'contact-add', [on('party-create', 'customer-0')], 'indeterminate'),
        effect(5, address, 'address-add', [on('counterparty-onboard', 'customer-0')]),
      ],
      items,
    );
    // The address names a dependency the job does not hold: it can only be unsupported.
    expect(Object.fromEntries(settlement)).toEqual({
      [id(3)]: 'denied',
      [id(4)]: 'denied',
      [id(5)]: 'unsupported',
    });
  });
});
