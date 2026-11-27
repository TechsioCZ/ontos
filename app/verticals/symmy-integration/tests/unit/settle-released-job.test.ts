import { Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  releasedJobOwnerCalls,
  releasedJobSettlement,
  SymmyReleasedJobEffectSchema,
  SymmyReleasedJobInvocationSchema,
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
    actionKey: `fixture.${effectKey}`,
    dependsOn,
    effectId: id(index),
    effectKey,
    executorPrincipalId: null,
    itemId,
    noReceipt: true,
    ownerInvocationId: null,
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

const executor = '6add58c3-e41d-4d5a-a231-f3b34d1bdd06';
const ownerRequest = '9'.repeat(64);
const invocationId = 'df5dd235-f3fd-4459-95f2-d266ba115da7';
/** An effect whose owner call was pinned (executor and request) and, after a lost reply, recorded by recovery. */
const pinnedConfirm = (ownerInvocationId: string | null = invocationId) =>
  Schema.decodeUnknownSync(SymmyReleasedJobEffectSchema)({
    actionKey: 'commerce.catalog.confirm-variant-combination',
    dependsOn: [],
    effectId: id(1),
    effectKey: 'readiness-confirm',
    executorPrincipalId: executor,
    itemId: customer,
    noReceipt: true,
    ownerInvocationId,
    requestHash: ownerRequest,
    state: 'indeterminate',
    status: null,
    unclaimed: true,
    version: 15,
  });
const ownerCall = (overrides: Partial<typeof SymmyReleasedJobInvocationSchema.Encoded> = {}) =>
  Schema.decodeUnknownSync(SymmyReleasedJobInvocationSchema)({
    actionInvocationId: invocationId,
    actionKey: 'commerce.catalog.confirm-variant-combination',
    changed: false,
    idempotencyKey: id(1),
    principalId: executor,
    requestHash: ownerRequest,
    status: 'succeeded',
    uncompleted: false,
    ...overrides,
  });

describe('a released Symmy job keeps what its owner committed', () => {
  it('settles an effect from the owner call that committed after its caller timed out', () => {
    const calls = Option.getOrUndefined(releasedJobOwnerCalls([pinnedConfirm()], [ownerCall()]));
    expect(calls === undefined ? undefined : Object.fromEntries(calls.reconciled)).toEqual({
      [id(1)]: { invocationId, status: 'accepted_no_change' },
    });
    expect(calls?.uncommitted).toEqual([]);
    const changed = releasedJobOwnerCalls([pinnedConfirm(null)], [ownerCall({ changed: true })]);
    expect(Option.getOrUndefined(changed)?.reconciled.get(id(1))).toEqual({ invocationId, status: 'accepted_change' });
    // Behind it, a never-run step is withdrawn, not left unsupported.
    const settlement = releasedJobSettlement(
      [
        { ...pinnedConfirm(), state: 'settled', status: Option.some('accepted_no_change') },
        effect(2, customer, 'readiness-activate', [on('readiness-confirm')]),
      ],
      items,
    );
    expect(Object.fromEntries(settlement)).toEqual({ [id(2)]: 'denied' });
  });

  it('refuses an owner call that failed, differs, states no change result or is not the one recorded', () => {
    const other = '0a885080-ca9c-4f74-8877-75e243ce9f15';
    const refusedCalls = [
      [pinnedConfirm(), [ownerCall({ status: 'failed' })]],
      [pinnedConfirm(), [ownerCall({ requestHash: '8'.repeat(64) })]],
      [pinnedConfirm(), [ownerCall({ principalId: '4a0b6ea9-cf88-4831-9c6a-10ac1b04b77d' })]],
      [pinnedConfirm(), [ownerCall({ actionKey: 'commerce.catalog.update-product' })]],
      [pinnedConfirm(), [ownerCall({ changed: null })]],
      [pinnedConfirm(other), [ownerCall()]],
      [pinnedConfirm(), []],
      [pinnedConfirm(), [ownerCall(), ownerCall({ actionInvocationId: other })]],
      [pinnedConfirm(), [ownerCall({ status: 'received', uncompleted: true })]],
    ] as const;
    for (const [pinned, invocations] of refusedCalls) {
      expect(Option.isNone(releasedJobOwnerCalls([pinned], invocations))).toBe(true);
    }
    // An uncommitted call under an effect with no recorded invocation stays fenced.
    const fenced = releasedJobOwnerCalls([pinnedConfirm(null)], [ownerCall({ status: 'received', uncompleted: true })]);
    expect(Option.getOrUndefined(fenced)?.uncommitted).toEqual([invocationId]);
  });
});
