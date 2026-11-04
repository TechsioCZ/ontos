import { expect, it } from 'effect-rstest';
import { Schema } from 'effect';
import type { Document } from '../../shared/apis/records.ts';
import { ContractRefSchema } from '../../shared/resources/contract.ts';
import type { ContractRef } from '../../shared/resources/contract.ts';
import { documentsForContract } from '../../src/routes/[lang]/smlouvy/use-agreements-records.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const otherTenantId = '20000000-0000-4000-8000-000000000002';
const contractRef: ContractRef = {
  moduleId: 'legal.agreements',
  resourceId: '40000000-0000-4000-8000-000000000001',
  resourceType: 'legal.agreements.contract',
  tenantId,
};
const documentId = '40000000-0000-4000-8000-000000000002';
const foreignDocumentId = '40000000-0000-4000-8000-000000000003';
const documentFor = (childContractRef: ContractRef | null, childDocumentId: string): Document => ({
  contractRef: childContractRef,
  createdAt: '2026-01-01T08:00:00.000Z',
  documentRef: {
    moduleId: 'legal.agreements',
    resourceId: childDocumentId,
    resourceType: 'legal.agreements.document',
    tenantId,
  },
  fileName: 'priloha.pdf',
  kind: 'PŘÍLOHA',
  lifecycleState: 'FINAL',
  signedDocumentReference: null,
  title: 'Předávací protokol',
  updatedAt: '2026-01-03T09:00:00.000Z',
});

it('associates documents only with the exact contract reference, not a shared resource id', () => {
  const exact = documentFor(contractRef, documentId);
  const foreignTenant = documentFor({ ...contractRef, tenantId: otherTenantId }, foreignDocumentId);
  // Wrong owner/type are rejected by the public contract before reaching the typed selector.
  expect(Schema.is(ContractRefSchema)({ ...contractRef, moduleId: 'party.registry' })).toBe(false);
  expect(Schema.is(ContractRefSchema)({ ...contractRef, resourceType: 'party.registry.counterparty' })).toBe(false);
  const unlinked = documentFor(null, foreignDocumentId);
  expect(foreignTenant.contractRef?.resourceId).toBe(contractRef.resourceId);

  const documents = documentsForContract([foreignTenant, unlinked, exact], {
    contractRef,
  });

  expect(documents.map((document) => document.documentRef.resourceId)).toEqual([documentId]);
  expect(documentsForContract([exact])).toEqual([]);
});
