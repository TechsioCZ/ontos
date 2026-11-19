import { readFileSync } from 'node:fs';

import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { OriginalRecipientBindingSchema, RecipientScopeSchema } from '../../src/domain/recipient/original-binding.ts';

/**
 * Drift guard of the public Communication Request contract. The payload is the encoded `originalRecipients` that
 * `@app/communications-contracts` encodes and decodes in its own test; both packages read the same fixture file, so
 * the domain binding schema cannot silently diverge from the contract the sources send.
 */
const sharedFixture: unknown = JSON.parse(
  readFileSync(
    new URL(
      '../../../../packages/communications-contracts/tests/fixtures/original-recipients.fixture.json',
      import.meta.url,
    ),
    'utf-8',
  ),
);

const BindingsSchema = Schema.NonEmptyArray(OriginalRecipientBindingSchema);

describe('#1395 Rule: the domain binding schema mirrors the public contract (BR-01)', () => {
  it('decodes a contract-encoded originalRecipients payload without excess fields and encodes it back unchanged', () => {
    const decoded = Schema.decodeUnknownSync(BindingsSchema, { onExcessProperty: 'error' })(sharedFixture);

    expect(Schema.encodeSync(BindingsSchema)(decoded)).toEqual(sharedFixture);
  });

  it('keeps the field set the contract is pinned to', () => {
    expect(Object.keys(OriginalRecipientBindingSchema.fields).toSorted()).toEqual([
      'originalContact',
      'recipientRef',
      'role',
      'scope',
      'validAt',
    ]);
    expect(Object.keys(RecipientScopeSchema.fields).toSorted()).toEqual([
      'counterpartyRef',
      'legalEntityId',
      'profileRef',
      'storefrontRef',
      'tenantId',
    ]);
  });
});
