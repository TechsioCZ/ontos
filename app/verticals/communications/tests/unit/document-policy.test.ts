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
import { DocumentPolicySchema, formAllowedByPolicy } from '../../src/domain/documents/document-policy.ts';
import type { DocumentForm, DocumentPolicy } from '../../src/domain/documents/document-policy.ts';
import { assetRef, documentOwnerDouble, documentRef } from '../support/document-owner-double.ts';
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
): DocumentDisclosureQuery => ({
  classification: linkOnly.classification,
  document: documentRef('doc-1'),
  form,
  gates: { privacy: 'ALLOWED', recipient: 'CURRENT', ...gates },
  policy,
  recipient: { recipientRef, role: RecipientRoleSchema.make('original-recipient') },
  tenantId: TENANT,
  typeId: MessageTypeIdSchema.make('fixture.single-message'),
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
    '[S09 AC-05] the owner authorizes every open again: a revoked permission blocks the NEXT open of a delivered link only',
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
        // the pinned reference is untouched: a revoked open deletes, anonymizes and repoints nothing
        expect(link).toEqual({ assetRef: assetRef('asset-A'), revision: 1 });
        expect(owner.asked.filter(({ kind }) => kind === 'authorizeOpen')).toHaveLength(2);
      }),
  );

  it.effect(
    '[S10 ACC-08] new bytes are a NEW Asset B by explicit owner assignment: the earlier message never silently repoints',
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

  it('[S14 ACC-07] an already delivered attachment is not recallable by any permission change, a link only loses its next open', () => {
    expect(effectOfOwnerRevocation('ATTACHMENT')).toEqual({
      attachmentRecalled: false,
      nextOpen: 'NOT_APPLICABLE_BYTES_ALREADY_DELIVERED',
    });
    expect(effectOfOwnerRevocation('LINK')).toEqual({ attachmentRecalled: false, nextOpen: 'RE_AUTHORIZED_BY_OWNER' });
  });
});
