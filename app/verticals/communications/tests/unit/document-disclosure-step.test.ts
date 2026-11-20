import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CommunicationResourceRefSchema, RecipientRoleSchema } from '../../src/domain/catalog/vocabulary.ts';
import { DocumentPinSchema, pinStillHolds } from '../../src/domain/documents/document-pin.ts';
import type { DocumentPin } from '../../src/domain/documents/document-pin.ts';
import { DocumentPolicySchema } from '../../src/domain/documents/document-policy.ts';
import { DocumentReferenceSchema, orderedReferences } from '../../src/domain/documents/document-reference.ts';
import { decodeIntakeInput } from '../../src/domain/intake/intake-input.ts';
import { requestFingerprintOf } from '../../src/domain/intake/identity.ts';
import { discloseDocuments } from '../../src/handoff/document-disclosure-step.ts';
import type { DocumentStepInput } from '../../src/handoff/document-disclosure-step.ts';
import { assetRef, documentOwnerDouble, documentRef } from '../support/document-owner-double.ts';
import { communicationRequest, originalRecipient } from '../support/intake-fixtures.ts';
import { NodeCrypto } from '@effect/platform-node';
import { FIXTURE_TENANT_ID, fixtureType } from './support/catalog-fixtures.ts';
import { recipientRef } from './support/access-fixtures.ts';

/** [#1409] The document step and the request mapping as pure decisions, with the labelled double of the document owner. */
const decodePolicy = Schema.decodeUnknownSync(DocumentPolicySchema);
const policy = decodePolicy({
  attachment: { kind: 'NOT_ALLOWED' },
  classification: 'fixture.classification.customer',
  documentOwner: 'fixture.documents',
  link: 'ALLOWED',
  recipientScope: 'ORIGINAL_RECIPIENT',
});
const decodeReference = Schema.decodeUnknownSync(DocumentReferenceSchema);
const reference = (id: string) =>
  decodeReference({
    classification: 'fixture.classification.customer',
    document: { moduleId: 'fixture.documents', resourceId: id, resourceType: 'fixture.documents.document' },
    recipientScope: 'ORIGINAL_RECIPIENT',
  });
const stepInput = (overrides: Partial<DocumentStepInput> = {}): DocumentStepInput => ({
  documents: [reference('doc-1')],
  pinned: [],
  policy,
  recipient: { recipientRef, role: RecipientRoleSchema.make('original-recipient') },
  tenantId: FIXTURE_TENANT_ID,
  typeId: fixtureType().typeId,
  ...overrides,
});
const pinOf = (assetId: string, position = 0): DocumentPin =>
  Schema.decodeUnknownSync(DocumentPinSchema)({
    assetRef: assetRef(assetId),
    classification: 'fixture.classification.customer',
    document: documentRef('doc-1'),
    form: 'LINK',
    position,
    revision: 1,
  });

describe('the document step asks the owner only for named documents and never repoints a pin', () => {
  it.effect('a message that names no document never asks the owner', () =>
    Effect.gen(function* none() {
      const owner = documentOwnerDouble();
      const verdict = yield* discloseDocuments(stepInput({ documents: [] })).pipe(Effect.provide(owner.layer));
      expect(verdict).toEqual({ existing: [], kind: 'CLEARED', toPin: [] });
      expect(owner.asked).toEqual([]);
    }),
  );

  it.effect(
    'the first answer of the owner becomes a pin to store; a stored pin that still holds is kept as it is',
    () =>
      Effect.gen(function* pins() {
        const owner = documentOwnerDouble();
        owner.assign('doc-1', assetRef('asset-1'));
        const first = yield* discloseDocuments(stepInput()).pipe(Effect.provide(owner.layer));
        expect(first).toMatchObject({
          existing: [],
          kind: 'CLEARED',
          toPin: [{ assetRef: assetRef('asset-1'), position: 0 }],
        });
        const again = yield* discloseDocuments(stepInput({ pinned: [pinOf('asset-1')] })).pipe(
          Effect.provide(owner.layer),
        );
        expect(again).toMatchObject({ existing: [pinOf('asset-1')], kind: 'CLEARED', toPin: [] });
      }),
  );

  it.effect('an owner that now names another Asset is a proven stop, never a repoint', () =>
    Effect.gen(function* repoint() {
      const owner = documentOwnerDouble();
      owner.assign('doc-1', assetRef('asset-2'));
      const verdict = yield* discloseDocuments(stepInput({ pinned: [pinOf('asset-1')] })).pipe(
        Effect.provide(owner.layer),
      );
      expect(verdict).toEqual({
        kind: 'STOPPED',
        reasons: [{ category: 'DOCUMENT_PIN_NOT_CURRENT', cause: 'DOCUMENT_PIN_NOT_CURRENT', proven: true }],
      });
    }),
  );

  it.effect('every stop is reported, the proven ones first', () =>
    Effect.gen(function* many() {
      const owner = documentOwnerDouble();
      owner.assign('doc-1', assetRef('asset-1'), { media: 'UNAVAILABLE' });
      owner.assign('doc-2', assetRef('asset-2'), { disclosure: 'FORBIDDEN' });
      const verdict = yield* discloseDocuments(stepInput({ documents: [reference('doc-1'), reference('doc-2')] })).pipe(
        Effect.provide(owner.layer),
      );
      expect(verdict).toMatchObject({
        kind: 'STOPPED',
        reasons: [
          { category: 'DOCUMENT_OWNER_FORBIDDEN', proven: true },
          { category: 'DOCUMENT_MEDIA_UNAVAILABLE', proven: false },
        ],
      });
    }),
  );

  it('a pin names a Core Media Asset V1 and holds only for the same Asset and form', () => {
    expect(() =>
      Schema.decodeUnknownSync(DocumentPinSchema)({ ...pinOf('a'), assetRef: documentRef('doc-1') }),
    ).toThrow();
    expect(() => Schema.decodeUnknownSync(DocumentPinSchema)({ ...pinOf('a'), revision: 2 })).toThrow();
    const link = { assetRef: assetRef('asset-1'), revision: 1 } as const;
    expect(pinStillHolds(pinOf('asset-1'), { form: 'LINK', link })).toBe(true);
    expect(pinStillHolds(pinOf('asset-1'), { form: 'ATTACHMENT', link })).toBe(false);
    expect(pinStillHolds(pinOf('asset-2'), { form: 'LINK', link })).toBe(false);
  });
});

describe('the request carries documents as safe references and keeps its meaning without them', () => {
  const bindings = [originalRecipient('customer-1')];
  const named = (documents: NonNullable<Parameters<typeof communicationRequest>[0]['documents']>) =>
    communicationRequest({ bindings, documents, tenantId: FIXTURE_TENANT_ID });

  it.effect('maps the references into the intake in a canonical order and none for a request without documents', () =>
    Effect.gen(function* mapping() {
      const input = yield* decodeIntakeInput(
        named([{ documentId: 'doc-b' }, { documentId: 'doc-a', form: 'ATTACHMENT' }]),
      );
      expect(input.documents.map(({ document }) => document.resourceId)).toEqual(['doc-a', 'doc-b']);
      expect(input.documents[0]).toMatchObject({
        classification: 'fixture.classification.customer',
        form: 'ATTACHMENT',
      });
      expect((yield* decodeIntakeInput(named([]))).documents).toEqual([]);
      expect(orderedReferences([reference('b'), reference('a')]).map(({ document }) => document.resourceId)).toEqual([
        'a',
        'b',
      ]);
      expect(Schema.is(CommunicationResourceRefSchema)(input.documents[0]?.document)).toBe(true);
    }),
  );

  it.effect(
    'a request without documents keeps its fingerprint; named documents are part of its meaning, in any order',
    () =>
      Effect.gen(function* fingerprints() {
        const plain = yield* requestFingerprintOf(named([]));
        const one = yield* requestFingerprintOf(named([{ documentId: 'doc-a' }]));
        const two = yield* requestFingerprintOf(named([{ documentId: 'doc-a' }, { documentId: 'doc-b' }]));
        const swapped = yield* requestFingerprintOf(named([{ documentId: 'doc-b' }, { documentId: 'doc-a' }]));
        expect(new Set([plain, one, two]).size).toBe(3);
        expect(swapped).toBe(two);
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
