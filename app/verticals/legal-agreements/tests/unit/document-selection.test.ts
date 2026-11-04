import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsResponse } from '../../shared/apis/records.ts';
import {
  AgreementDocumentForbiddenSchema,
  AgreementDocumentFoundSchema,
  AgreementDocumentInvalidStateSchema,
  AgreementDocumentNotFoundSchema,
  AgreementDocumentPendingSchema,
  AgreementDocumentUnavailableSchema,
  AgreementSelectorContractSchema,
  AgreementSelectorDocumentSchema,
  AgreementSelectorInvalidSchema,
  AgreementSelectorNoneSchema,
  ResourceIdSchema,
  agreementDocumentState,
  parseAgreementSelector,
  selectAgreementDocument,
  selectorOfFields,
} from '../../src/routes/[lang]/smlouvy/document-selection.ts';

const resourceId = (value: string) => Schema.decodeSync(ResourceIdSchema)(value);
const tenantId = '20000000-0000-4000-8000-000000000001';
const otherTenantId = '20000000-0000-4000-8000-000000000002';
const contractId = resourceId('40000000-0000-4000-8000-000000000001');
const documentId = resourceId('40000000-0000-4000-8000-000000000002');
const otherDocumentId = resourceId('40000000-0000-4000-8000-000000000003');
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
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: '40000000-0000-4000-8000-000000000099',
  resourceType: 'party.registry.counterparty',
  tenantId,
};
const baseContract = {
  contractRef,
  counterpartyRef,
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
};
const baseDocument = {
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
};
const records = (overrides: { readonly contracts?: unknown; readonly documents?: unknown } = {}): RecordsResponse =>
  Schema.decodeUnknownSync(RecordsResponseSchema)({
    contracts: overrides.contracts ?? [baseContract],
    documents: overrides.documents ?? [baseDocument],
    revision: 7,
  });
const documentSelector = parseAgreementSelector(`?documentId=${documentId}`);

it.effect('parses one UUID selector and never turns a malformed or conflicting value into an empty selection', () =>
  Effect.sync(() => {
    const none = parseAgreementSelector('');
    const contract = parseAgreementSelector(`?resourceId=${contractId}`);
    const document = parseAgreementSelector(`?documentId=${documentId}`);
    const conflict = parseAgreementSelector(`?resourceId=${contractId}&documentId=${documentId}`);
    const empty = parseAgreementSelector('?documentId=');
    const malformedDocument = parseAgreementSelector('?documentId=not-a-uuid');
    const malformedContract = parseAgreementSelector('?resourceId=not-a-uuid');
    expect(Schema.is(AgreementSelectorNoneSchema)(none)).toBe(true);
    expect(Schema.is(AgreementSelectorContractSchema)(contract)).toBe(true);
    if (Schema.is(AgreementSelectorContractSchema)(contract)) {
      expect(contract.resourceId).toBe(contractId);
    }
    expect(Schema.is(AgreementSelectorDocumentSchema)(document)).toBe(true);
    if (Schema.is(AgreementSelectorDocumentSchema)(document)) {
      expect(document.documentId).toBe(documentId);
    }
    for (const invalid of [conflict, empty, malformedDocument, malformedContract]) {
      expect(Schema.is(AgreementSelectorInvalidSchema)(invalid)).toBe(true);
    }
    if (Schema.is(AgreementSelectorInvalidSchema)(conflict)) {
      expect(conflict.reason).toBe('conflicting_selectors');
    }
  }),
);

it.effect('maps the parsed selector back to the page input fields without inventing a fallback', () =>
  Effect.sync(() => {
    const document = selectorOfFields({ documentId });
    const contract = selectorOfFields({ resourceId: contractId });
    const invalid = selectorOfFields({ selectorIssue: 'conflicting_selectors' });
    const none = selectorOfFields({});
    expect(Schema.is(AgreementSelectorDocumentSchema)(document)).toBe(true);
    expect(Schema.is(AgreementSelectorContractSchema)(contract)).toBe(true);
    expect(Schema.is(AgreementSelectorInvalidSchema)(invalid)).toBe(true);
    expect(Schema.is(AgreementSelectorNoneSchema)(none)).toBe(true);
  }),
);

it.effect('resolves the current document and its exact current parent from the same owner snapshot', () =>
  Effect.sync(() => {
    const result = selectAgreementDocument({ documentId, records: records(), tenantId });
    expect(Schema.is(AgreementDocumentFoundSchema)(result)).toBe(true);
    if (Schema.is(AgreementDocumentFoundSchema)(result)) {
      expect(result.archived).toBe(false);
      expect(result.document.documentRef.resourceId).toBe(documentId);
      expect(result.document.title).toBe('Předávací protokol');
      expect(result.parent?.contractRef.resourceId).toBe(contractId);
    }
  }),
);

it.effect('uses the current owner title after a rename instead of any earlier search evidence', () =>
  Effect.sync(() => {
    const renamed = records({
      documents: [{ ...baseDocument, title: 'Aktuální protokol', updatedAt: '2026-02-03T09:00:00.000Z' }],
    });
    const before = selectAgreementDocument({ documentId, records: records(), tenantId });
    const after = selectAgreementDocument({ documentId, records: renamed, tenantId });
    expect(Schema.is(AgreementDocumentFoundSchema)(before)).toBe(true);
    expect(Schema.is(AgreementDocumentFoundSchema)(after)).toBe(true);
    if (Schema.is(AgreementDocumentFoundSchema)(before) && Schema.is(AgreementDocumentFoundSchema)(after)) {
      expect(before.document.title).toBe('Předávací protokol');
      expect(after.document.title).toBe('Aktuální protokol');
    }
  }),
);

it.effect('classifies a document archive and a terminated or expired parent like search does', () =>
  Effect.sync(() => {
    const archived = selectAgreementDocument({
      documentId,
      records: records({ documents: [{ ...baseDocument, lifecycleState: 'ARCHIVED' }] }),
      tenantId,
    });
    const terminated = selectAgreementDocument({
      documentId,
      records: records({ contracts: [{ ...baseContract, lifecycleState: 'TERMINATED' }] }),
      tenantId,
    });
    const expired = selectAgreementDocument({
      documentId,
      records: records({ contracts: [{ ...baseContract, isExpired: true }] }),
      tenantId,
    });
    for (const result of [archived, terminated, expired]) {
      expect(Schema.is(AgreementDocumentFoundSchema)(result)).toBe(true);
      if (Schema.is(AgreementDocumentFoundSchema)(result)) {
        expect(result.archived).toBe(true);
      }
    }
  }),
);

it.effect('keeps an unlinked current document readable without inventing a parent', () =>
  Effect.sync(() => {
    const result = selectAgreementDocument({
      documentId,
      records: records({ documents: [{ ...baseDocument, contractRef: null }] }),
      tenantId,
    });
    expect(Schema.is(AgreementDocumentFoundSchema)(result)).toBe(true);
    if (Schema.is(AgreementDocumentFoundSchema)(result)) {
      expect(result.archived).toBe(false);
      expect(result.parent).toBeUndefined();
    }
  }),
);

it.effect(
  'rejects a missing, orphaned, duplicated or foreign-scope document with indistinguishable not-found states',
  () =>
    Effect.sync(() => {
      const missing = selectAgreementDocument({ documentId: otherDocumentId, records: records(), tenantId });
      const orphan = selectAgreementDocument({ documentId, records: records({ contracts: [] }), tenantId });
      const duplicate = selectAgreementDocument({
        documentId,
        records: records({ documents: [baseDocument, { ...baseDocument }] }),
        tenantId,
      });
      const foreignDocument = selectAgreementDocument({
        documentId,
        records: records({
          documents: [{ ...baseDocument, documentRef: { ...documentRef, tenantId: otherTenantId } }],
        }),
        tenantId,
      });
      const foreignParent = selectAgreementDocument({
        documentId,
        records: records({
          contracts: [{ ...baseContract, contractRef: { ...contractRef, tenantId: otherTenantId } }],
        }),
        tenantId,
      });
      for (const result of [missing, orphan, duplicate, foreignDocument, foreignParent]) {
        expect(Schema.is(AgreementDocumentNotFoundSchema)(result)).toBe(true);
      }
      const reasons = [missing, orphan, duplicate, foreignDocument, foreignParent].flatMap((result) =>
        Schema.is(AgreementDocumentNotFoundSchema)(result) ? [result.reason] : [],
      );
      expect(reasons).toEqual(['missing', 'orphan', 'ambiguous', 'foreign_scope', 'orphan']);
    }),
);

it.effect('does not fall back to a same-ID contract or to another company when the document is absent', () =>
  Effect.sync(() => {
    const result = selectAgreementDocument({ documentId: contractId, records: records(), tenantId });
    expect(Schema.is(AgreementDocumentNotFoundSchema)(result)).toBe(true);
    if (Schema.is(AgreementDocumentNotFoundSchema)(result)) {
      expect(result.reason).toBe('missing');
    }
  }),
);

it.effect('keeps loading, forbidden and unavailable separate from a missing document', () =>
  Effect.sync(() => {
    const loading = agreementDocumentState({ feedback: 'loading', selector: documentSelector, tenantId });
    const forbidden = agreementDocumentState({ feedback: 'forbidden', selector: documentSelector });
    const unavailable = agreementDocumentState({ feedback: 'unavailable', selector: documentSelector });
    const missing = agreementDocumentState({
      feedback: 'ready',
      records: records({ documents: [] }),
      selector: documentSelector,
      tenantId,
    });
    const invalid = agreementDocumentState({
      feedback: 'ready',
      records: records(),
      selector: parseAgreementSelector(`?resourceId=${contractId}&documentId=${documentId}`),
      tenantId,
    });
    expect(Schema.is(AgreementDocumentPendingSchema)(loading)).toBe(true);
    expect(Schema.is(AgreementDocumentForbiddenSchema)(forbidden)).toBe(true);
    expect(Schema.is(AgreementDocumentUnavailableSchema)(unavailable)).toBe(true);
    expect(Schema.is(AgreementDocumentNotFoundSchema)(missing)).toBe(true);
    expect(Schema.is(AgreementDocumentInvalidStateSchema)(invalid)).toBe(true);
  }),
);

it.effect('does not resolve a document while the page load is still pending or the selector is not a document', () =>
  Effect.sync(() => {
    const pending = agreementDocumentState({
      feedback: 'loading',
      records: records(),
      selector: documentSelector,
      tenantId,
    });
    const contract = agreementDocumentState({
      feedback: 'ready',
      records: records(),
      selector: parseAgreementSelector(`?resourceId=${contractId}`),
    });
    const none = agreementDocumentState({
      feedback: 'ready',
      records: records(),
      selector: parseAgreementSelector(''),
    });
    expect(Schema.is(AgreementDocumentPendingSchema)(pending)).toBe(true);
    for (const result of [contract, none]) {
      expect(Schema.is(AgreementDocumentNotFoundSchema)(result)).toBe(true);
    }
  }),
);
