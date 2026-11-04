import { Effect, Option, Schema } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RecordsResponseSchema } from '../../shared/apis/records.ts';
import { AgreementDocumentDetail, AgreementDocumentStatus } from '../../src/routes/[lang]/smlouvy/document-detail.tsx';

const tenantId = '20000000-0000-4000-8000-000000000001';
const contractId = '40000000-0000-4000-8000-000000000001';
const documentId = '40000000-0000-4000-8000-000000000002';
const contractRef = {
  moduleId: 'legal.agreements',
  resourceId: contractId,
  resourceType: 'legal.agreements.contract',
  tenantId,
};
const documentRef = {
  moduleId: 'legal.agreements',
  resourceId: documentId,
  resourceType: 'legal.agreements.document',
  tenantId,
};
const records = Schema.decodeUnknownSync(RecordsResponseSchema)({
  contracts: [
    {
      contractRef,
      counterpartyRef: {
        moduleId: 'party.registry',
        resourceId: '40000000-0000-4000-8000-000000000099',
        resourceType: 'party.registry.counterparty',
        tenantId,
      },
      endDate: null,
      expiringSoon: false,
      hasSuccessorDraft: false,
      isExpired: false,
      kind: 'OTHER',
      lifecycleState: 'ACTIVE',
      note: 'secret-note',
      occupancyRef: null,
      propertyRef: null,
      renewalNoticeDate: null,
      signatureState: 'SIGNED',
      startDate: '2026-01-01',
      subject: 'Rámcová smlouva',
      supersedesContractRef: null,
      unitRef: null,
    },
  ],
  documents: [
    {
      contractRef,
      createdAt: '2026-01-01T08:00:00.000Z',
      documentRef,
      fileName: 'priloha.pdf',
      kind: 'PŘÍLOHA',
      lifecycleState: 'FINAL',
      signedBy: 'secret-signer',
      signedDocumentReference: 'secret-reference',
      signedOn: '2026-01-02',
      title: 'Předávací protokol',
      updatedAt: '2026-01-03T09:00:00.000Z',
    },
  ],
  revision: 7,
});
const document = Option.getOrThrow(Option.fromUndefinedOr(records.documents[0]));
const parent = Option.getOrThrow(Option.fromUndefinedOr(records.contracts[0]));

beforeEach(() => {
  rstest.stubGlobal('React', React);
});

afterEach(() => {
  rstest.unstubAllGlobals();
});

it.effect('renders the current document metadata and approved parent context from the owner response', () =>
  Effect.sync(() => {
    const html = renderToStaticMarkup(
      createElement(AgreementDocumentDetail, {
        archived: false,
        document,
        language: 'cs',
        parent,
      }),
    );
    expect(html).toContain('Předávací protokol');
    expect(html).toContain('PŘÍLOHA');
    expect(html).toContain('priloha.pdf');
    expect(html).toContain('Aktuální verze');
    expect(html).toContain('Rámcová smlouva');
    expect(html).toContain('Otevřít smlouvu');
    expect(html).toContain(`href="/cs/smlouvy?resourceId=${contractId}"`);
    expect(html).toContain('href="/cs/smlouvy"');
    expect(html).toContain('legalagreements:grid-cols-1');
    expect(html).toContain('legalagreements:xl:grid-cols-[minmax(0,1fr)_24rem]');
    expect(html).not.toContain('secret-signer');
    expect(html).not.toContain('secret-reference');
    expect(html).not.toContain('secret-note');
    expect(html).not.toContain('40000000-0000-4000-8000-000000000099');
  }),
);

it.effect('shows an archived document and an ended parent as archived, without inventing a current state', () =>
  Effect.sync(() => {
    const html = renderToStaticMarkup(
      createElement(AgreementDocumentDetail, {
        archived: true,
        document: { ...document, lifecycleState: 'ARCHIVED' },
        language: 'cs',
        parent: { ...parent, lifecycleState: 'EXPIRED' },
      }),
    );
    expect(html).toContain('Archivováno');
    expect(html).toContain('Vypršelo');
  }),
);

it.effect('keeps an unlinked document honest and offers no parent link', () =>
  Effect.sync(() => {
    const html = renderToStaticMarkup(
      createElement(AgreementDocumentDetail, {
        archived: false,
        document: { ...document, contractRef: null },
        language: 'cs',
      }),
    );
    expect(html).toContain('Dokument není navázán na smlouvu.');
    expect(html).not.toContain('?resourceId=');
  }),
);

it.effect('renders the same safe metadata in English while keeping keyboard-reachable back and parent links', () =>
  Effect.sync(() => {
    const html = renderToStaticMarkup(
      createElement(AgreementDocumentDetail, {
        archived: false,
        document,
        language: 'en',
        parent,
      }),
    );
    expect(html).toContain('File name');
    expect(html).toContain('Parent contract');
    expect(html).toContain('Open contract');
    expect(html).toContain(`href="/en/smlouvy?resourceId=${contractId}"`);
    expect(html).toContain('href="/en/smlouvy"');
  }),
);

it.effect('distinguishes missing, forbidden, unavailable and malformed selection states without hidden detail', () =>
  Effect.sync(() => {
    const missing = renderToStaticMarkup(
      createElement(AgreementDocumentStatus, { language: 'cs', state: { _tag: 'NotFound', reason: 'orphan' } }),
    );
    const forbidden = renderToStaticMarkup(
      createElement(AgreementDocumentStatus, { language: 'cs', state: { _tag: 'Forbidden' } }),
    );
    const unavailable = renderToStaticMarkup(
      createElement(AgreementDocumentStatus, { language: 'cs', state: { _tag: 'Unavailable' } }),
    );
    const invalid = renderToStaticMarkup(
      createElement(AgreementDocumentStatus, {
        language: 'cs',
        state: { _tag: 'Invalid', reason: 'conflicting_selectors' },
      }),
    );
    expect(missing).toContain('Dokument nebyl nalezen nebo k němu nemáte přístup.');
    expect(missing).not.toContain('Předávací protokol');
    expect(forbidden).toContain('Pro tuto oblast nemáte oprávnění.');
    expect(unavailable).toContain('Služba je dočasně nedostupná.');
    expect(invalid).toContain('Odkaz obsahuje dva různé záznamy');
    for (const html of [missing, forbidden, unavailable, invalid]) {
      expect(html).toContain('href="/cs/smlouvy"');
    }
  }),
);
