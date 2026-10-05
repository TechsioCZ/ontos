import { expect, it } from 'effect-rstest';
import { Schema } from 'effect';
import {
  AssortmentMigrationEvidenceRecordSchema,
  normalizeAssortmentMigrationEvidenceRecord,
} from '../../shared/domain/migration-evidence.ts';
import { AssortmentOwnerResourceRefSchema } from '../../shared/domain/decision-contracts.ts';

const tenantId = '018f8b4e-35a2-7b51-8d56-91a4f37d6a11';
const sourceRecordDigest = 'a'.repeat(64);
const ref = (moduleId: string, resourceType: string, resourceId: string) =>
  Schema.decodeUnknownSync(AssortmentOwnerResourceRefSchema)({
    moduleId,
    resourceId,
    resourceType,
    tenantId,
  });

const productRef = ref('catalog.owner', 'catalog.product', 'product-1');
const channelRef = ref('commerce.channel', 'commerce.channel.channel', 'web');
const sellingLegalEntityRef = ref('commerce.legal-entity', 'commerce.legal-entity.selling-legal-entity', 'sle-1');
const profileRef = ref('commerce.customer-context', 'commerce.customer-context.retail-customer-profile', 'profile-1');
const groupRef = ref('commerce.customer-context', 'commerce.customer-context.customer-group', 'group-1');
const counterpartyRef = ref('party.registry', 'party.registry.counterparty', 'counterparty-1');
const evidence = {
  evidenceRef: ref('catalog.owner', 'catalog.owner.evidence', 'evidence-1'),
  ownerModuleId: 'catalog.owner',
  sourceRevision: {
    ownerModuleId: 'catalog.owner',
    revision: 'r1',
    sourceRef: ref('catalog.owner', 'catalog.owner.snapshot', 'snapshot-1'),
  },
};

const decodeRecord = Schema.decodeUnknownSync(AssortmentMigrationEvidenceRecordSchema);

const correlation = (canonicalRef: typeof productRef, target: string) => ({
  canonicalRef,
  evidenceRef: evidence,
  method: 'owner-qualified-reference',
  sourceRecordDigest,
  status: 'MATCHED',
  target,
});

const baseRecordInput = () => ({
  affectedJourneys: ['VISIBILITY'],
  canonicalMeaning: {
    audience: { kind: 'SHARED' },
    commercialScope: {
      channelRef,
      sellingLegalEntityRef,
    },
    completeness: {
      predicate: 'all current facts for migration record',
      proof: evidence,
      scope: 'migration-source-record',
      state: 'COMPLETE',
    },
    effect: 'ALLOW',
    lifecycle: { effectiveFrom: '2026-09-22T10:00:00.000Z' },
    purpose: 'VISIBILITY',
    selector: { kind: 'PRODUCT', productRef },
    targetKind: 'RULE_BINDING',
  },
  classification: {
    disposition: 'TRANSFORM',
    evidenceRefs: [evidence],
    reason: 'Owner-backed canonical meaning is complete',
  },
  correlations: [
    correlation(channelRef, 'CHANNEL'),
    correlation(sellingLegalEntityRef, 'SELLING_LEGAL_ENTITY'),
    {
      canonicalRef: productRef,
      evidenceRef: evidence,
      method: 'owner-qualified-catalog-reference',
      sourceRecordDigest,
      status: 'MATCHED',
      target: 'CATALOG',
    },
  ],
  factFamily: 'test.fact-family',
  gaps: [],
  ownerEvidenceRefs: [evidence],
  source: {
    datasetId: 'test-dataset',
    observedAt: '2026-09-22T10:00:00.000Z',
    sourceLocatorDigest: 'b'.repeat(64),
    sourceOwner: 'test-owner',
    sourceRecordDigest,
    sourceRevision: 'source-revision-1',
    sourceSystemId: 'test-system',
  },
});

const baseRecord = () => decodeRecord(baseRecordInput());

it('preserves a proven transform only when exact meaning, identity, completeness, and owner evidence exist', () => {
  const normalized = normalizeAssortmentMigrationEvidenceRecord(baseRecord());

  expect(normalized.classification.disposition).toBe('TRANSFORM');
  expect(normalized.gaps).toEqual([]);
});

it('forces missing meaning and owner proof to UNRESOLVED instead of inferring a wildcard', () => {
  const record = decodeRecord({
    ...baseRecordInput(),
    canonicalMeaning: { purpose: 'VISIBILITY' },
    classification: {
      disposition: 'RETIRE',
      evidenceRefs: [],
      proposedDisposition: 'RETIRE',
      reason: 'Historical publication candidate',
    },
    correlations: [],
    ownerEvidenceRefs: [],
  });
  const normalized = normalizeAssortmentMigrationEvidenceRecord(record);

  expect(normalized.classification.disposition).toBe('UNRESOLVED');
  expect(normalized.gaps).toEqual(['OWNER_EVIDENCE']);
});

it('rejects canonical claims from ambiguous correlations', () => {
  const record = decodeRecord({
    ...baseRecordInput(),
    correlations: [
      {
        method: 'unverified-name-match',
        sourceRecordDigest,
        status: 'AMBIGUOUS',
        target: 'CATALOG',
      },
    ],
    ownerEvidenceRefs: [],
  });
  const normalized = normalizeAssortmentMigrationEvidenceRecord(record);

  expect(normalized.classification.disposition).toBe('UNRESOLVED');
  expect(normalized.gaps).toContain('CANONICAL_IDENTITY');
  expect(normalized.gaps).toContain('OWNER_EVIDENCE');
});

it('requires a complete Admission Set meaning for a Boundary transformation', () => {
  const record = decodeRecord({
    ...baseRecordInput(),
    canonicalMeaning: { ...baseRecordInput().canonicalMeaning, targetKind: 'BOUNDARY' },
  });
  const normalized = normalizeAssortmentMigrationEvidenceRecord(record);

  expect(normalized.classification.disposition).toBe('UNRESOLVED');
  expect(normalized.gaps).toContain('ADMISSION_SET');
});

it('rejects reversed lifecycle intervals and mismatched source correlation digests', () => {
  expect(() =>
    decodeRecord({
      ...baseRecordInput(),
      canonicalMeaning: {
        ...baseRecordInput().canonicalMeaning,
        lifecycle: {
          effectiveFrom: '2026-09-22T12:00:00.000Z',
          effectiveTo: '2026-09-22T10:00:00.000Z',
        },
      },
    }),
  ).toThrow();

  expect(() =>
    decodeRecord({
      ...baseRecordInput(),
      correlations: [
        {
          canonicalRef: productRef,
          evidenceRef: evidence,
          method: 'owner-qualified-catalog-reference',
          sourceRecordDigest: 'c'.repeat(64),
          status: 'MATCHED',
          target: 'CATALOG',
        },
      ],
    }),
  ).toThrow();
});

const boundaryInput = () => {
  const {
    audience: _audience,
    effect: _effect,
    selector: _selector,
    ...commonMeaning
  } = baseRecordInput().canonicalMeaning;
  return {
    ...baseRecordInput(),
    canonicalMeaning: {
      ...commonMeaning,
      admissionSet: {
        collectionRevisionRef: ref('commerce.assortment', 'commerce.assortment.collection-revision', 'admission-r1'),
        contentHash: 'd'.repeat(64),
        entries: [{ kind: 'PRODUCT', productRef }],
        memberCount: 1,
        setKind: 'ENTRIES',
      },
      subject: { kind: 'IDENTIFIED', subject: { kind: 'RETAIL_CUSTOMER_PROFILE', profileRef } },
      targetKind: 'BOUNDARY',
    },
    correlations: [...baseRecordInput().correlations, correlation(profileRef, 'PROFILE')],
  };
};

it('preserves an evidenced retirement without imported meaning or target correlations', () => {
  const { canonicalMeaning: _meaning, ...sourceRecord } = baseRecordInput();
  const normalized = normalizeAssortmentMigrationEvidenceRecord(
    decodeRecord({
      ...sourceRecord,
      classification: { ...sourceRecord.classification, disposition: 'RETIRE' },
      correlations: [],
      gaps: ['CANONICAL_IDENTITY', 'EFFECT', 'COMPLETENESS', 'SUBJECT'],
    }),
  );

  expect(normalized.classification.disposition).toBe('RETIRE');
  expect(normalized.canonicalMeaning).toBeUndefined();
  expect(normalized.correlations).toEqual([]);
  expect(normalized.gaps).toEqual([]);
});

it('requires both owner and disposition evidence and proven provenance for retirement', () => {
  for (const overrides of [
    { ownerEvidenceRefs: [] },
    { classification: { ...baseRecordInput().classification, disposition: 'RETIRE', evidenceRefs: [] } },
    { gaps: ['SOURCE_OWNER'] },
    { gaps: ['SOURCE_PROVENANCE'] },
  ]) {
    const record = decodeRecord({
      ...baseRecordInput(),
      classification: { ...baseRecordInput().classification, disposition: 'RETIRE' },
      ...overrides,
    });
    expect(normalizeAssortmentMigrationEvidenceRecord(record).classification.disposition).toBe('UNRESOLVED');
  }
  const { source: _source, ...missingSource } = baseRecordInput();
  expect(() => decodeRecord(missingSource)).toThrow();
});

it('preserves RETAIN and partial UNRESOLVED without upgrading source uncertainty', () => {
  const retained = decodeRecord({
    ...baseRecordInput(),
    classification: { ...baseRecordInput().classification, disposition: 'RETAIN' },
  });
  expect(normalizeAssortmentMigrationEvidenceRecord(retained).classification.disposition).toBe('RETAIN');

  const unresolved = decodeRecord({
    ...baseRecordInput(),
    canonicalMeaning: { purpose: 'VISIBILITY' },
    classification: { ...baseRecordInput().classification, disposition: 'UNRESOLVED' },
    correlations: [],
  });
  const normalized = normalizeAssortmentMigrationEvidenceRecord(unresolved);
  expect(normalized.classification.disposition).toBe('UNRESOLVED');
  expect(normalized.gaps).toContain('SUBJECT');
  expect(normalized.gaps).toContain('COMPLETENESS');
});

it('requires exact Group audience identity and its matched owner correlation', () => {
  const input = {
    ...baseRecordInput(),
    canonicalMeaning: {
      ...baseRecordInput().canonicalMeaning,
      audience: { groupRef, kind: 'COMMERCE_CUSTOMER_GROUP' },
    },
    correlations: [...baseRecordInput().correlations, correlation(groupRef, 'GROUP')],
  };
  expect(normalizeAssortmentMigrationEvidenceRecord(decodeRecord(input)).classification.disposition).toBe('TRANSFORM');

  for (const correlations of [
    baseRecordInput().correlations,
    [...baseRecordInput().correlations, correlation(groupRef, 'PROFILE')],
    [...baseRecordInput().correlations, correlation(ref(groupRef.moduleId, groupRef.resourceType, 'other'), 'GROUP')],
  ]) {
    const normalized = normalizeAssortmentMigrationEvidenceRecord(decodeRecord({ ...input, correlations }));
    expect(normalized.classification.disposition).toBe('UNRESOLVED');
    expect(normalized.gaps).toContain('CANONICAL_IDENTITY');
  }
});

it('represents ordinary individual targeting as SUBJECT audience and requires exact correlations', () => {
  const input = {
    ...baseRecordInput(),
    canonicalMeaning: {
      ...baseRecordInput().canonicalMeaning,
      audience: { kind: 'SUBJECT', subject: { counterpartyRef, kind: 'COUNTERPARTY' } },
    },
    correlations: [...baseRecordInput().correlations, correlation(counterpartyRef, 'COUNTERPARTY')],
  };
  expect(normalizeAssortmentMigrationEvidenceRecord(decodeRecord(input)).classification.disposition).toBe('TRANSFORM');
  const missingSubject = decodeRecord({ ...input, correlations: baseRecordInput().correlations });
  expect(normalizeAssortmentMigrationEvidenceRecord(missingSubject).gaps).toContain('CANONICAL_IDENTITY');
});

it('requires exact Channel and selling Legal Entity mappings for imported ordinary meaning', () => {
  for (const target of ['CHANNEL', 'SELLING_LEGAL_ENTITY']) {
    const record = decodeRecord({
      ...baseRecordInput(),
      correlations: baseRecordInput().correlations.filter((entry) => entry.target !== target),
    });
    expect(normalizeAssortmentMigrationEvidenceRecord(record).classification.disposition).toBe('UNRESOLVED');
  }
});

it('preserves true complete Boundary meaning without an ordinary Effect or selector', () => {
  const normalized = normalizeAssortmentMigrationEvidenceRecord(decodeRecord(boundaryInput()));
  expect(normalized.classification.disposition).toBe('TRANSFORM');
  expect(normalized.gaps).toEqual([]);
  expect(normalized.canonicalMeaning?.effect).toBeUndefined();
  expect(normalized.canonicalMeaning?.selector).toBeUndefined();
});

it('allows only explicitly complete empty Admission Sets', () => {
  const input = boundaryInput();
  const emptyAdmission = { ...input.canonicalMeaning.admissionSet, entries: [], memberCount: 0, setKind: 'EMPTY' };
  const record = decodeRecord({
    ...input,
    canonicalMeaning: { ...input.canonicalMeaning, admissionSet: emptyAdmission },
  });
  expect(normalizeAssortmentMigrationEvidenceRecord(record).classification.disposition).toBe('TRANSFORM');

  const { entries: _entries, ...missingEntries } = input.canonicalMeaning.admissionSet;
  for (const admissionSet of [
    { ...emptyAdmission, setKind: 'ENTRIES' },
    { ...emptyAdmission, memberCount: 1 },
    missingEntries,
  ]) {
    const incomplete = decodeRecord({ ...input, canonicalMeaning: { ...input.canonicalMeaning, admissionSet } });
    expect(normalizeAssortmentMigrationEvidenceRecord(incomplete).gaps).toContain('ADMISSION_SET');
  }
});

it('keeps SHARED, Guest and Group closure unresolved and rejects ordinary Boundary fields', () => {
  const input = boundaryInput();
  for (const fields of [
    { subject: { kind: 'SHARED' } },
    { subject: { guestEvidence: evidence, kind: 'GUEST_PURCHASE_CONTEXT' } },
    { audience: { groupRef, kind: 'COMMERCE_CUSTOMER_GROUP' } },
    { effect: 'DENY' },
    { selector: { kind: 'ALL' } },
  ]) {
    const record = decodeRecord({ ...input, canonicalMeaning: { ...input.canonicalMeaning, ...fields } });
    expect(normalizeAssortmentMigrationEvidenceRecord(record).classification.disposition).toBe('UNRESOLVED');
  }
});

it('rejects VISIBILITY purchase-only selectors for ordinary policies and Admission Sets', () => {
  for (const selector of [
    { kind: 'VARIANT', variantRef: ref('catalog.owner', 'catalog.variant', 'variant-1') },
    { kind: 'PACKAGE_OPTION', packageOptionRef: ref('catalog.owner', 'catalog.package-option', 'package-1') },
  ]) {
    const ordinary = decodeRecord({
      ...baseRecordInput(),
      canonicalMeaning: { ...baseRecordInput().canonicalMeaning, selector },
    });
    expect(normalizeAssortmentMigrationEvidenceRecord(ordinary).gaps).toContain('PURPOSE');

    const boundary = boundaryInput();
    const record = decodeRecord({
      ...boundary,
      canonicalMeaning: {
        ...boundary.canonicalMeaning,
        admissionSet: { ...boundary.canonicalMeaning.admissionSet, entries: [selector] },
      },
    });
    expect(normalizeAssortmentMigrationEvidenceRecord(record).gaps).toContain('PURPOSE');
  }
});

it('retains PURCHASE-only selector meanings with exact owner-qualified mappings', () => {
  const variantRef = ref('catalog.owner', 'catalog.variant', 'variant-1');
  const selector = { kind: 'VARIANT', variantRef };
  const ordinary = decodeRecord({
    ...baseRecordInput(),
    affectedJourneys: ['PURCHASE'],
    canonicalMeaning: { ...baseRecordInput().canonicalMeaning, purpose: 'PURCHASE', selector },
    correlations: [...baseRecordInput().correlations, correlation(variantRef, 'CATALOG')],
  });
  expect(normalizeAssortmentMigrationEvidenceRecord(ordinary).classification.disposition).toBe('TRANSFORM');

  const boundary = boundaryInput();
  const record = decodeRecord({
    ...boundary,
    affectedJourneys: ['PURCHASE'],
    canonicalMeaning: {
      ...boundary.canonicalMeaning,
      admissionSet: { ...boundary.canonicalMeaning.admissionSet, entries: [selector] },
      purpose: 'PURCHASE',
    },
    correlations: [...boundary.correlations, correlation(variantRef, 'CATALOG')],
  });
  expect(normalizeAssortmentMigrationEvidenceRecord(record).classification.disposition).toBe('TRANSFORM');
});

it('requires owner mappings for each optional commercial narrowing dimension', () => {
  const commerceMarketRef = ref('commerce.market', 'commerce.market.commerce-market', 'market-1');
  const storefrontRef = ref('commerce.storefront-registry', 'commerce.storefront-registry.storefront', 'storefront-1');
  const input = {
    ...baseRecordInput(),
    canonicalMeaning: {
      ...baseRecordInput().canonicalMeaning,
      commercialScope: { ...baseRecordInput().canonicalMeaning.commercialScope, commerceMarketRef, storefrontRef },
    },
    correlations: [
      ...baseRecordInput().correlations,
      correlation(commerceMarketRef, 'MARKET'),
      correlation(storefrontRef, 'STOREFRONT'),
    ],
  };
  expect(normalizeAssortmentMigrationEvidenceRecord(decodeRecord(input)).classification.disposition).toBe('TRANSFORM');
  for (const target of ['MARKET', 'STOREFRONT']) {
    const missing = decodeRecord({
      ...input,
      correlations: input.correlations.filter((entry) => entry.target !== target),
    });
    expect(normalizeAssortmentMigrationEvidenceRecord(missing).gaps).toContain('CANONICAL_IDENTITY');
  }
});

it('keeps incomplete or stale source sets unresolved for ordinary and Boundary targets', () => {
  for (const input of [baseRecordInput(), boundaryInput()]) {
    for (const state of ['UNVERIFIABLE', 'STALE']) {
      const record = decodeRecord({
        ...input,
        canonicalMeaning: {
          ...input.canonicalMeaning,
          completeness: { ...input.canonicalMeaning.completeness, state },
        },
      });
      const normalized = normalizeAssortmentMigrationEvidenceRecord(record);
      expect(normalized.classification.disposition).toBe('UNRESOLVED');
      expect(normalized.gaps).toContain('COMPLETENESS');
    }
  }
});
