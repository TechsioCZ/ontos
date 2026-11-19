import { Effect, Option, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { MessageTypeIdSchema, RecipientRoleSchema } from '../../src/domain/catalog/vocabulary.ts';
import { buildMessageTypeRegistry } from '../../src/domain/catalog/registry.ts';
import {
  assessDocumentDisclosure,
  authorizeLinkOpen,
  DocumentDisclosure,
  effectOfOwnerRevocation,
} from '../../src/domain/documents/disclosure.ts';
import type { DocumentDisclosureCase, DocumentDisclosureQuery } from '../../src/domain/documents/disclosure.ts';
import { unavailableDocumentLinkOwnerLayer } from '../../src/domain/documents/document-owner.ts';
import {
  DocumentClassificationKeySchema,
  DocumentPolicySchema,
  formAllowedByPolicy,
} from '../../src/domain/documents/document-policy.ts';
import type { DocumentForm, DocumentPolicy } from '../../src/domain/documents/document-policy.ts';
import {
  assetRef,
  documentOwnerDouble,
  documentRef,
  foreignAssetRef,
  foreignDocumentRef,
  wrongTypeAssetRef,
} from '../support/document-owner-double.ts';
import { recipientRef } from './support/access-fixtures.ts';
import { fixtureType } from './support/catalog-fixtures.ts';

const decodePolicy = Schema.decodeUnknownSync(DocumentPolicySchema, { onExcessProperty: 'error' });
const base = {
  attachment: { kind: 'NOT_ALLOWED' },
  classification: 'fixture.classification.customer',
  documentOwner: 'fixture.documents',
  link: 'ALLOWED',
  recipientScope: 'ORIGINAL_RECIPIENT',
};
const linkOnly = decodePolicy(base);
const withAttachment = decodePolicy({
  ...base,
  attachment: { approvalKey: 'fixture.rule.attachment', kind: 'APPROVED' },
});
/** A type that approved no documents at all: the absence of a policy is the default. */
const noPolicy = Option.getOrUndefined(Option.none<DocumentPolicy>());
const TENANT = '11111111-1111-4111-8111-111111111111';
const OPENER = '99999999-9999-4999-8999-999999999999';

const query = (
  policy: DocumentPolicy | undefined,
  form: DocumentForm,
  gates: Partial<DocumentDisclosureQuery['gates']> = {},
  overrides: Partial<Pick<DocumentDisclosureQuery, 'classification' | 'document' | 'recipientScope'>> = {},
): DocumentDisclosureQuery => ({
  classification: linkOnly.classification,
  document: documentRef('doc-1'),
  form,
  gates: { privacy: 'ALLOWED', recipient: 'CURRENT', ...gates },
  policy,
  recipient: { recipientRef, role: RecipientRoleSchema.make('original-recipient') },
  recipientScope: 'ORIGINAL_RECIPIENT',
  tenantId: TENANT,
  typeId: MessageTypeIdSchema.make('fixture.single-message'),
  ...overrides,
});

/** The outcome as a plain summary, so a test states WHAT was decided without comparing a tag by hand. */
const summaryOf = (outcome: DocumentDisclosureCase) =>
  DocumentDisclosure.$match(outcome, {
    Disclose: ({ form, link }) => ({ form, link, outcome: 'DISCLOSE' as const }),
    Stop: ({ proven, reason }) => ({ outcome: 'STOP' as const, proven, reason }),
  });
/** The pinned link of a disclosure, or a defect of the test when the document was stopped. */
const linkOf = (outcome: DocumentDisclosureCase) =>
  DocumentDisclosure.$match(outcome, {
    Disclose: ({ link }) => Effect.succeed(link),
    Stop: ({ reason }) => Effect.die(`expected a disclosure, the document was stopped: ${reason}`),
  });

const assessWith = (
  policy: DocumentPolicy | undefined,
  gates: Partial<DocumentDisclosureQuery['gates']>,
  configure: (owner: ReturnType<typeof documentOwnerDouble>) => void = () => {},
) =>
  Effect.gen(function* run() {
    const owner = documentOwnerDouble();
    owner.assign('doc-1', assetRef('asset-A'));
    configure(owner);
    const outcome = yield* assessDocumentDisclosure(query(policy, 'ATTACHMENT', gates)).pipe(
      Effect.provide(owner.layer),
    );
    return { asked: owner.asked.length, outcome: summaryOf(outcome) };
  });

describe('The per-type document policy extends the catalog without changing a type (#1409, ACC-06, ACC-07, ACC-13)', () => {
  it('has no documents by default: a type without a policy builds unchanged and allows nothing', () => {
    const plain = fixtureType();
    expect(plain).not.toHaveProperty('documents');
    expect(Result.isSuccess(buildMessageTypeRegistry([plain]))).toBe(true);
    expect(formAllowedByPolicy(noPolicy, 'LINK')).toBe('NOT_ALLOWED');
    expect(formAllowedByPolicy(noPolicy, 'ATTACHMENT')).toBe('NOT_ALLOWED');
  });

  it('accepts an explicit link or an explicitly approved attachment, and refuses a policy that allows neither', () => {
    const typed = fixtureType({ documents: base });
    expect(Result.isSuccess(buildMessageTypeRegistry([typed]))).toBe(true);
    expect(formAllowedByPolicy(linkOnly, 'LINK')).toBe('ALLOWED');
    // a link approval says nothing about an attachment (ACC-13)
    expect(formAllowedByPolicy(linkOnly, 'ATTACHMENT')).toBe('NOT_ALLOWED');
    expect(formAllowedByPolicy(withAttachment, 'ATTACHMENT')).toBe('ALLOWED');
    expect(() => decodePolicy({ ...base, link: 'NOT_ALLOWED' })).toThrow();
    expect(() => decodePolicy({ ...base, attachment: { kind: 'APPROVED' } })).toThrow();
    // the recipient scope has one value: the ORIGINAL recipient (ACC-04)
    expect(() => decodePolicy({ ...base, recipientScope: 'ANY_RECIPIENT' })).toThrow();
    expect(() => decodePolicy({ ...base, universal: true })).toThrow();
  });
});

describe('A document link is typed, resolved by its owner to the exact Asset V1 and re-authorized at every open (#1409)', () => {
  it.effect(
    '[S08 AC-05] an approved type discloses the exact Asset reference with revision 1, never a URL or a permission',
    () =>
      Effect.gen(function* approvedLink() {
        const owner = documentOwnerDouble();
        owner.assign('doc-1', assetRef('asset-A'));
        const outcome = yield* assessDocumentDisclosure(query(linkOnly, 'LINK')).pipe(Effect.provide(owner.layer));
        expect(summaryOf(outcome)).toEqual({
          form: 'LINK',
          link: { assetRef: assetRef('asset-A'), revision: 1 },
          outcome: 'DISCLOSE',
        });
        expect(JSON.stringify(outcome)).not.toMatch(/https?:/u);
      }),
  );

  it.effect(
    '[S09 AC-05] against the labelled owner double: every open asks the owner again, and a revoked permission blocks the NEXT open only',
    () =>
      Effect.gen(function* revokedLink() {
        const owner = documentOwnerDouble();
        owner.assign('doc-1', assetRef('asset-A'));
        owner.grantOpen(assetRef('asset-A'), OPENER);
        const link = yield* linkOf(
          yield* assessDocumentDisclosure(query(linkOnly, 'LINK')).pipe(Effect.provide(owner.layer)),
        );
        const open = () =>
          authorizeLinkOpen(link, { principalId: OPENER, tenantId: TENANT }).pipe(Effect.provide(owner.layer));
        expect(yield* open()).toBe('OPENED');
        owner.revokeOpen(assetRef('asset-A'), OPENER);
        expect(yield* open()).toBe('DENIED');
        // this proves only that the DOUBLE was asked about the pinned Asset at each open; a real owner and Core Media V1
        // (#1443, #1446) are not exercised here
        // the pinned reference is untouched: a revoked open deletes, anonymizes and repoints nothing
        expect(link).toEqual({ assetRef: assetRef('asset-A'), revision: 1 });
        expect(owner.asked.filter(({ kind }) => kind === 'authorizeOpen')).toHaveLength(2);
      }),
  );

  it.effect(
    '[S10 ACC-08] against the labelled owner double: new bytes are a NEW Asset B by explicit assignment and the earlier link is asked about Asset A only',
    () =>
      Effect.gen(function* newAsset() {
        const owner = documentOwnerDouble();
        owner.assign('doc-1', assetRef('asset-A'));
        owner.grantOpen(assetRef('asset-A'), OPENER);
        owner.grantOpen(assetRef('asset-B'), OPENER);
        const first = yield* linkOf(
          yield* assessDocumentDisclosure(query(linkOnly, 'LINK')).pipe(Effect.provide(owner.layer)),
        );
        owner.assign('doc-1', assetRef('asset-B'));
        // the earlier link is opened as Asset A: only the pinned reference is asked, never the Current assignment
        owner.clearAsked();
        const stillA = yield* authorizeLinkOpen(first, { principalId: OPENER, tenantId: TENANT }).pipe(
          Effect.provide(owner.layer),
        );
        expect(stillA).toBe('OPENED');
        // only the DOUBLE was asked, and about the pinned Asset: it proves how Communications asks, not a real Core Media
        expect(owner.asked).toEqual([{ kind: 'authorizeOpen', subject: 'asset-A' }]);
        expect(first.assetRef).toEqual(assetRef('asset-A'));
        // a NEW message resolves the new assignment: Asset B, revision 1
        const second = yield* assessDocumentDisclosure(query(linkOnly, 'LINK')).pipe(Effect.provide(owner.layer));
        expect(summaryOf(second)).toMatchObject({ link: { assetRef: assetRef('asset-B'), revision: 1 } });
      }),
  );

  it.effect('[ACC-08] trusts no revision but 1 and never substitutes one', () =>
    Effect.gen(function* revision() {
      const owner = documentOwnerDouble();
      owner.assign('doc-1', assetRef('asset-A'), { claimedRevision: 2 });
      const outcome = yield* assessDocumentDisclosure(query(linkOnly, 'LINK')).pipe(Effect.provide(owner.layer));
      expect(summaryOf(outcome)).toEqual({ outcome: 'STOP', proven: true, reason: 'DOCUMENT_REVISION_NOT_CURRENT' });
    }),
  );

  it.effect(
    '[AC-07 ACC-09] an outage or an unavailable Asset discloses and opens nothing, with a truthful reason',
    () =>
      Effect.gen(function* outage() {
        const owner = documentOwnerDouble();
        owner.assign('doc-1', assetRef('asset-A'));
        owner.grantOpen(assetRef('asset-A'), OPENER);
        owner.setOutage(true);
        const held = yield* assessDocumentDisclosure(query(linkOnly, 'LINK')).pipe(Effect.provide(owner.layer));
        expect(summaryOf(held)).toEqual({ outcome: 'STOP', proven: false, reason: 'DOCUMENT_OWNER_UNAVAILABLE' });
        const opened = yield* authorizeLinkOpen(
          { assetRef: assetRef('asset-A'), revision: 1 },
          { principalId: OPENER, tenantId: TENANT },
        ).pipe(Effect.provide(owner.layer));
        expect(opened).toBe('OWNER_UNAVAILABLE');
        owner.setOutage(false);
        owner.assign('doc-1', assetRef('asset-A'), { media: 'UNAVAILABLE' });
        const media = yield* assessDocumentDisclosure(query(linkOnly, 'LINK')).pipe(Effect.provide(owner.layer));
        expect(summaryOf(media)).toEqual({ outcome: 'STOP', proven: false, reason: 'DOCUMENT_MEDIA_UNAVAILABLE' });
        // the production composition has no Core Media V1 yet: it is the explicit unavailable form, never a silent allow
        const production = yield* assessDocumentDisclosure(query(linkOnly, 'LINK')).pipe(
          Effect.provide(unavailableDocumentLinkOwnerLayer),
        );
        expect(summaryOf(production)).toMatchObject({ outcome: 'STOP', reason: 'DOCUMENT_OWNER_UNAVAILABLE' });
      }),
  );

  it.effect('[S08] a type with no policy discloses no document at all, and the owner is never asked', () =>
    Effect.gen(function* noDocumentPolicy() {
      const owner = documentOwnerDouble();
      owner.assign('doc-1', assetRef('asset-A'));
      const outcomes = yield* Effect.forEach(
        ['LINK', 'ATTACHMENT'] as const,
        (form) => assessDocumentDisclosure(query(noPolicy, form)).pipe(Effect.provide(owner.layer)),
        { concurrency: 1 },
      );
      expect(outcomes.map((outcome) => summaryOf(outcome).outcome)).toEqual(['STOP', 'STOP']);
      expect(owner.asked).toEqual([]);
    }),
  );
});

describe('An attachment is an irreversible disclosure and needs every approval (#1409, ACC-07, AC-06)', () => {
  it.effect(
    '[S11 S12 S13] discloses only with the type approval, the owner approval, the Current recipient and Current Privacy',
    () =>
      Effect.gen(function* approvalMatrix() {
        const approved = yield* assessWith(withAttachment, {});
        expect(approved).toMatchObject({
          asked: 1,
          outcome: { form: 'ATTACHMENT', link: { revision: 1 }, outcome: 'DISCLOSE' },
        });
        // [S12] the type approved only a link, or nothing: the attachment is stopped and nothing is asked of the owner
        expect(yield* assessWith(linkOnly, {})).toEqual({
          asked: 0,
          outcome: { outcome: 'STOP', proven: true, reason: 'ATTACHMENT_NOT_APPROVED_FOR_TYPE' },
        });
        expect(yield* assessWith(noPolicy, {})).toEqual({
          asked: 0,
          outcome: { outcome: 'STOP', proven: true, reason: 'ATTACHMENT_NOT_APPROVED_FOR_TYPE' },
        });
        // [S13] the owner forbade the disclosure before the handoff
        const forbidden = yield* assessWith(withAttachment, {}, (owner) => {
          owner.assign('doc-1', assetRef('asset-A'), { disclosure: 'FORBIDDEN' });
        });
        expect(forbidden).toEqual({
          asked: 1,
          outcome: { outcome: 'STOP', proven: true, reason: 'DOCUMENT_OWNER_FORBIDDEN' },
        });
      }),
  );

  it.effect('stops on every Current gate before the owner is asked: a proven fact is final, an unknown one holds', () =>
    Effect.gen(function* gates() {
      const cases = [
        [{ privacy: 'NOT_ALLOWED' }, 'DOCUMENT_PRIVACY_NOT_ALLOWED', true],
        [{ privacy: 'INDETERMINATE' }, 'DOCUMENT_PRIVACY_INDETERMINATE', false],
        [{ recipient: 'NOT_CURRENT' }, 'DOCUMENT_RECIPIENT_NOT_CURRENT', true],
        [{ recipient: 'UNKNOWN' }, 'DOCUMENT_RECIPIENT_UNKNOWN', false],
      ] as const;
      const results = yield* Effect.forEach(cases, ([gate]) => assessWith(withAttachment, gate), { concurrency: 1 });
      expect(results).toEqual(
        cases.map(([, reason, proven]) => ({ asked: 0, outcome: { outcome: 'STOP', proven, reason } })),
      );
    }),
  );

  it.effect('[ACC-09] a retry asks every Current gate again and can never ride on an earlier approval', () =>
    Effect.gen(function* retry() {
      const owner = documentOwnerDouble();
      owner.assign('doc-1', assetRef('asset-A'));
      const ask = () =>
        assessDocumentDisclosure(query(withAttachment, 'ATTACHMENT')).pipe(
          Effect.provide(owner.layer),
          Effect.map(summaryOf),
        );
      expect((yield* ask()).outcome).toBe('DISCLOSE');
      owner.assign('doc-1', assetRef('asset-A'), { disclosure: 'FORBIDDEN' });
      expect(yield* ask()).toMatchObject({ outcome: 'STOP', reason: 'DOCUMENT_OWNER_FORBIDDEN' });
      expect(owner.asked.filter(({ kind }) => kind === 'resolve')).toHaveLength(2);
    }),
  );

  it.effect(
    '[S14 ACC-07] a permission change after the disclosure leaves the pinned (delivered) record exactly as it was and recalls nothing',
    () =>
      Effect.gen(function* afterDelivery() {
        const owner = documentOwnerDouble();
        owner.assign('doc-1', assetRef('asset-A'));
        const delivered = yield* assessDocumentDisclosure(query(withAttachment, 'ATTACHMENT')).pipe(
          Effect.provide(owner.layer),
        );
        const record = yield* linkOf(delivered);
        const pinned = JSON.stringify(record);
        // the owner forbids the disclosure afterwards: a NEW evaluation stops, the delivered record is not touched
        owner.assign('doc-1', assetRef('asset-A'), { disclosure: 'FORBIDDEN' });
        const later = yield* assessDocumentDisclosure(query(withAttachment, 'ATTACHMENT')).pipe(
          Effect.provide(owner.layer),
        );
        expect(summaryOf(later)).toMatchObject({ outcome: 'STOP', reason: 'DOCUMENT_OWNER_FORBIDDEN' });
        expect(JSON.stringify(record)).toBe(pinned);
        expect(JSON.stringify(delivered)).toBe(
          JSON.stringify(DocumentDisclosure.Disclose({ form: 'ATTACHMENT', link: record })),
        );
        // nothing was asked of the owner but the two disclosure evaluations: no recall, no delete, no rewrite exists to ask for
        expect(new Set(owner.asked.map(({ kind }) => kind))).toEqual(new Set(['resolve']));
        // the contract statement the evaluation relies on: bytes already delivered are not recallable by any permission
        expect(effectOfOwnerRevocation('ATTACHMENT')).toEqual({
          attachmentRecalled: false,
          nextOpen: 'NOT_APPLICABLE_BYTES_ALREADY_DELIVERED',
        });
        expect(effectOfOwnerRevocation('LINK')).toEqual({
          attachmentRecalled: false,
          nextOpen: 'RE_AUTHORIZED_BY_OWNER',
        });
      }),
  );
});

const stopOf = (
  overrides: Partial<Pick<DocumentDisclosureQuery, 'classification' | 'document' | 'recipientScope'>>,
  form: DocumentForm = 'LINK',
  configure: (owner: ReturnType<typeof documentOwnerDouble>) => void = () => {},
) =>
  Effect.gen(function* run() {
    const owner = documentOwnerDouble();
    owner.assign('doc-1', assetRef('asset-A'));
    configure(owner);
    const outcome = yield* assessDocumentDisclosure(query(withAttachment, form, {}, overrides)).pipe(
      Effect.provide(owner.layer),
    );
    return { asked: owner.asked.length, outcome: summaryOf(outcome) };
  });
const provenStop = (reason: string) => ({ asked: 0, outcome: { outcome: 'STOP', proven: true, reason } });

describe('The per-type policy is enforced end to end against what is disclosed (#1409, ACC-04, ACC-13, ACC-08)', () => {
  it.effect(
    '[ACC-13] a document of another module than the approved document owner is stopped and the owner is never asked',
    () =>
      Effect.gen(function* foreignOwner() {
        const other = foreignDocumentRef('doc-1');
        for (const form of ['LINK', 'ATTACHMENT'] as const) {
          expect(yield* stopOf({ document: other }, form)).toEqual(provenStop('DOCUMENT_OWNER_MISMATCH'));
        }
        // the approved owner's own document is not stopped: the check is the owner, not the document type
        expect(yield* stopOf({})).toMatchObject({ asked: 1, outcome: { outcome: 'DISCLOSE' } });
      }),
  );

  it.effect('[ACC-13] a classification other than the approved one is stopped before the owner is asked', () =>
    Effect.gen(function* otherClassification() {
      const other = DocumentClassificationKeySchema.make('fixture.classification.internal');
      expect(yield* stopOf({ classification: other })).toEqual(provenStop('DOCUMENT_CLASSIFICATION_MISMATCH'));
      expect(yield* stopOf({ classification: other }, 'ATTACHMENT')).toEqual(
        provenStop('DOCUMENT_CLASSIFICATION_MISMATCH'),
      );
    }),
  );

  it.effect('[ACC-04] a recipient scope other than the original recipient is stopped before the owner is asked', () =>
    Effect.gen(function* otherRecipient() {
      for (const form of ['LINK', 'ATTACHMENT'] as const) {
        expect(yield* stopOf({ recipientScope: 'ANOTHER_RECIPIENT' }, form)).toEqual(
          provenStop('DOCUMENT_RECIPIENT_SCOPE_MISMATCH'),
        );
      }
    }),
  );

  it.effect('[ACC-08] an owner that answers with a resource that is not a Core Media Asset is never disclosed', () =>
    Effect.gen(function* notMedia() {
      const wrongType = wrongTypeAssetRef('asset-A');
      const outcomes = yield* Effect.forEach(
        [foreignAssetRef('asset-A'), wrongType],
        (ref) =>
          Effect.gen(function* one() {
            const owner = documentOwnerDouble();
            owner.assign('doc-1', ref);
            const outcome = yield* assessDocumentDisclosure(query(linkOnly, 'LINK')).pipe(Effect.provide(owner.layer));
            return summaryOf(outcome);
          }),
        { concurrency: 1 },
      );
      expect(outcomes).toEqual([
        { outcome: 'STOP', proven: true, reason: 'DOCUMENT_ASSET_NOT_CORE_MEDIA' },
        { outcome: 'STOP', proven: true, reason: 'DOCUMENT_ASSET_NOT_CORE_MEDIA' },
      ]);
    }),
  );

  it('makes the document owner a live field of the policy, not a decoration', () => {
    const policy = decodePolicy({ ...base, documentOwner: 'fixture.other-module' });
    expect(policy.documentOwner).toBe('fixture.other-module');
    expect(() => decodePolicy({ ...base, documentOwner: 'Not A Module' })).toThrow();
  });
});
