// @effect-diagnostics asyncFunction:off globalDate:off
/* eslint-disable unicorn/no-await-expression-member -- Live database assertions keep each typed query beside its expected result. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { and, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Effect } from 'effect';
import { Pool } from 'pg';
import {
  counterparties,
  counterpartyAdminReadModels,
  counterpartyRoleAdminReadModels,
  counterpartyRolePeriods,
  duplicateCandidateCaseParties,
  duplicateCandidateCases,
  parties,
  partyAliases,
  partyContactPointPurposes,
  partyContactPoints,
  partyCorrections,
  partyDatabaseSchema,
  partyFactAssertions,
  partyIdentifierClaims,
  partyMatchDecisions,
  partyMerges,
  partyOfficialIdentifiers,
  partyRelationships,
} from '../../src/db/schema.ts';
import type { PartyTransaction } from '../../src/db/types.ts';

const tenantA = 'a1000000-0000-4000-8000-000000000001';
const tenantB = 'a1000000-0000-4000-8000-000000000002';
const legalEntityA = 'a2000000-0000-4000-8000-000000000001';
const partyOrganizationA = 'a3000000-0000-4000-8000-000000000001';
const partyOrganizationA2 = 'a3000000-0000-4000-8000-000000000002';
const partyPersonA = 'a3000000-0000-4000-8000-000000000003';
const partyOrganizationB = 'a3000000-0000-4000-8000-000000000004';
const identifierA = 'a4000000-0000-4000-8000-000000000001';
const identifierA2 = 'a4000000-0000-4000-8000-000000000002';
const identifierB = 'a4000000-0000-4000-8000-000000000003';
const claimA = 'a5000000-0000-4000-8000-000000000001';
const claimB = 'a5000000-0000-4000-8000-000000000002';
const emailA = 'a6000000-0000-4000-8000-000000000001';
const emailA2 = 'a6000000-0000-4000-8000-000000000002';
const addressA = 'a6000000-0000-4000-8000-000000000003';
const addressA2 = 'a6000000-0000-4000-8000-000000000004';
const counterpartyA = 'a7000000-0000-4000-8000-000000000001';
const relationshipA = 'a8000000-0000-4000-8000-000000000001';
const caseA = 'a9000000-0000-4000-8000-000000000001';
const actionA = 'aa000000-0000-4000-8000-000000000001';
const principalA = 'ab000000-0000-4000-8000-000000000001';
const fixtureTenants = [tenantA, tenantB] as const;

const isRuntimeObject = <Value>(value: Value): value is Value & object =>
  value !== null && Object(value) === value;

const hasPostgreSqlCode = (expected: string) => {
  const matches = <ErrorValue>(error: ErrorValue): boolean => {
    if (!isRuntimeObject(error)) {
      return false;
    }
    if ('code' in error && error.code === expected) {
      return true;
    }
    return 'cause' in error && matches(error.cause);
  };
  return matches;
};

test('enforces Party owner invariants, tenant isolation, and independent fact lifecycles', async () => {
  const connections = await Effect.runPromise(loadDatabaseConnectionPair());
  const adminPool = new Pool({ connectionString: connections.admin.connectionString });
  const runtimePool = new Pool({ connectionString: connections.runtime.connectionString, max: 1 });
  const admin = drizzle({ client: adminPool, schema: partyDatabaseSchema });
  const runtime = drizzle({ client: runtimePool, schema: partyDatabaseSchema });

  const cleanup = async () => {
    await admin.delete(partyCorrections).where(inArray(partyCorrections.tenantId, fixtureTenants));
    await admin.delete(partyAliases).where(inArray(partyAliases.tenantId, fixtureTenants));
    await admin.delete(partyMerges).where(inArray(partyMerges.tenantId, fixtureTenants));
    await admin
      .delete(partyMatchDecisions)
      .where(inArray(partyMatchDecisions.tenantId, fixtureTenants));
    await admin
      .delete(duplicateCandidateCaseParties)
      .where(inArray(duplicateCandidateCaseParties.tenantId, fixtureTenants));
    await admin
      .delete(duplicateCandidateCases)
      .where(inArray(duplicateCandidateCases.tenantId, fixtureTenants));
    await admin
      .delete(counterpartyRoleAdminReadModels)
      .where(inArray(counterpartyRoleAdminReadModels.tenantId, fixtureTenants));
    await admin
      .delete(counterpartyAdminReadModels)
      .where(inArray(counterpartyAdminReadModels.tenantId, fixtureTenants));
    await admin
      .delete(counterpartyRolePeriods)
      .where(inArray(counterpartyRolePeriods.tenantId, fixtureTenants));
    await admin.delete(counterparties).where(inArray(counterparties.tenantId, fixtureTenants));
    await admin
      .delete(partyRelationships)
      .where(inArray(partyRelationships.tenantId, fixtureTenants));
    await admin
      .delete(partyContactPointPurposes)
      .where(inArray(partyContactPointPurposes.tenantId, fixtureTenants));
    await admin
      .delete(partyContactPoints)
      .where(inArray(partyContactPoints.tenantId, fixtureTenants));
    await admin
      .delete(partyIdentifierClaims)
      .where(inArray(partyIdentifierClaims.tenantId, fixtureTenants));
    await admin
      .delete(partyOfficialIdentifiers)
      .where(inArray(partyOfficialIdentifiers.tenantId, fixtureTenants));
    await admin
      .delete(partyFactAssertions)
      .where(inArray(partyFactAssertions.tenantId, fixtureTenants));
    await admin.delete(parties).where(inArray(parties.tenantId, fixtureTenants));
  };

  const withTenant = <Value>(
    tenantId: string,
    operation: (transaction: PartyTransaction) => Promise<Value>,
  ): Promise<Value> =>
    runtime.transaction(async (transaction) => {
      await transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true)`);
      return operation(transaction);
    });

  try {
    const runtimeRole = await runtime.execute<{ rolbypassrls: boolean; rolsuper: boolean }>(
      sql`select rolbypassrls, rolsuper from pg_roles where rolname = current_user`,
    );
    assert.deepEqual(runtimeRole.rows, [{ rolbypassrls: false, rolsuper: false }]);
    await cleanup();
    await admin.insert(parties).values([
      {
        currentDisplayName: 'Organization A',
        currentType: 'ORGANIZATION',
        partyId: partyOrganizationA,
        tenantId: tenantA,
      },
      {
        currentDisplayName: 'Organization A2',
        currentType: 'ORGANIZATION',
        partyId: partyOrganizationA2,
        tenantId: tenantA,
      },
      {
        currentDisplayName: 'Person A',
        currentType: 'PERSON',
        partyId: partyPersonA,
        tenantId: tenantA,
      },
      {
        currentType: 'ORGANIZATION',
        partyId: partyOrganizationB,
        tenantId: tenantB,
      },
    ]);

    const [unnamedParty] = await admin
      .select({ displayName: parties.currentDisplayName })
      .from(parties)
      .where(eq(parties.partyId, partyOrganizationB));
    assert.equal(unnamedParty?.displayName, null);

    assert.deepEqual(await runtime.select().from(parties), []);
    assert.deepEqual(
      await withTenant(tenantA, (transaction) =>
        transaction.select({ partyId: parties.partyId }).from(parties).orderBy(parties.partyId),
      ),
      [
        { partyId: partyOrganizationA },
        { partyId: partyOrganizationA2 },
        { partyId: partyPersonA },
      ],
    );

    const identifierValues = (tenantId: string, partyId: string, identifierId: string) => ({
      acceptedByActionInvocationId: actionA,
      acceptedByPrincipalId: principalA,
      identifierTypeKey: 'ICO',
      namespace: 'CZ:ICO',
      normalizedValue: '00123456',
      officialIdentifierId: identifierId,
      partyId,
      policyVersion: 'party.identifier.v1',
      provenanceMethod: 'AUTHORITATIVE_LOOKUP',
      provenanceSource: 'ARES',
      tenantId,
      validFrom: new Date('2026-01-01T00:00:00.000Z'),
      verificationState: 'VERIFIED',
      verifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const externalEvidence = {
      authorityPolicyKey: 'party_registry.ares_enrichment' as const,
      authorityPolicyVersion: '1' as const,
      cacheAgeSeconds: 0,
      decidedAt: '2026-01-02T00:00:00.000Z',
      evidenceRef: 'ares:evidence:fixture',
      fact: 'ICO' as const,
      observedAt: '2026-01-01T12:00:00.000Z',
      outcome: 'APPLY_ENRICHMENT' as const,
      provider: 'ares' as const,
      providerChangedOn: null,
      providerRecordRef: null,
      queryIco: '00123456',
      reasonCode: 'selected_missing_fact_confirmed',
      servedAt: '2026-01-01T12:00:00.000Z',
    };
    await admin
      .insert(partyOfficialIdentifiers)
      .values([
        { ...identifierValues(tenantA, partyOrganizationA, identifierA), externalEvidence },
        identifierValues(tenantA, partyOrganizationA2, identifierA2),
        identifierValues(tenantB, partyOrganizationB, identifierB),
      ]);
    const [persistedExternalEvidence] = await admin
      .select({
        externalEvidence: partyOfficialIdentifiers.externalEvidence,
        validFrom: partyOfficialIdentifiers.validFrom,
      })
      .from(partyOfficialIdentifiers)
      .where(eq(partyOfficialIdentifiers.officialIdentifierId, identifierA));
    assert.deepEqual(persistedExternalEvidence?.externalEvidence, externalEvidence);
    assert.notEqual(
      persistedExternalEvidence?.validFrom.toISOString(),
      externalEvidence.observedAt,
    );
    await assert.rejects(
      admin
        .update(partyOfficialIdentifiers)
        .set({
          externalEvidence: sql`${JSON.stringify({ ...externalEvidence, rawPayload: { forbidden: true } })}::jsonb`,
        })
        .where(eq(partyOfficialIdentifiers.officialIdentifierId, identifierA)),
      hasPostgreSqlCode('23514'),
    );
    await assert.rejects(
      admin
        .update(partyOfficialIdentifiers)
        .set({
          externalEvidence: sql`${JSON.stringify({ ...externalEvidence, provider: null })}::jsonb`,
        })
        .where(eq(partyOfficialIdentifiers.officialIdentifierId, identifierA)),
      hasPostgreSqlCode('23514'),
    );
    await admin.insert(partyIdentifierClaims).values([
      {
        identifierClaimId: claimA,
        identifierTypeKey: 'ICO',
        namespace: 'CZ:ICO',
        normalizedValue: '00123456',
        officialIdentifierId: identifierA,
        partyId: partyOrganizationA,
        tenantId: tenantA,
      },
      {
        identifierClaimId: claimB,
        identifierTypeKey: 'ICO',
        namespace: 'CZ:ICO',
        normalizedValue: '00123456',
        officialIdentifierId: identifierB,
        partyId: partyOrganizationB,
        tenantId: tenantB,
      },
    ]);
    await assert.rejects(
      admin.insert(partyIdentifierClaims).values({
        identifierTypeKey: 'ICO',
        namespace: 'CZ:ICO',
        normalizedValue: '00123456',
        officialIdentifierId: identifierA2,
        partyId: partyOrganizationA2,
        tenantId: tenantA,
      }),
      hasPostgreSqlCode('23505'),
    );

    const contactEvidence = {
      acceptedByActionInvocationId: actionA,
      acceptedByPrincipalId: principalA,
      evidenceReference: 'evidence:original-contact:1',
      policyVersion: 'party.contact.v1',
      privacyClassification: 'PERSONAL',
      provenanceMethod: 'DECLARED',
      provenanceSource: 'USER',
      validFrom: new Date('2026-01-01T00:00:00.000Z'),
    } as const;
    await admin.insert(partyContactPoints).values([
      {
        ...contactEvidence,
        contactPointId: emailA,
        contactPointType: 'EMAIL',
        displayValue: 'Shared@Example.test',
        normalizationVersion: 'email.v1',
        normalizedValue: 'shared@example.test',
        partyId: partyOrganizationA,
        tenantId: tenantA,
      },
      {
        ...contactEvidence,
        contactPointId: emailA2,
        contactPointType: 'EMAIL',
        displayValue: 'shared@example.test',
        normalizationVersion: 'email.v1',
        normalizedValue: 'shared@example.test',
        partyId: partyOrganizationA2,
        tenantId: tenantA,
      },
      {
        ...contactEvidence,
        addressLine1: 'Main 1',
        city: 'Prague',
        contactPointId: addressA,
        contactPointType: 'ADDRESS',
        countryCode: 'CZ',
        partyId: partyOrganizationA,
        postalCode: '11000',
        tenantId: tenantA,
      },
      {
        ...contactEvidence,
        addressLine1: 'Other 2',
        city: 'Prague',
        contactPointId: addressA2,
        contactPointType: 'ADDRESS',
        countryCode: 'CZ',
        partyId: partyOrganizationA,
        postalCode: '12000',
        tenantId: tenantA,
      },
    ]);
    const purposeEvidence = {
      acceptedByActionInvocationId: actionA,
      acceptedByPrincipalId: principalA,
      partyId: partyOrganizationA,
      policyVersion: 'party.contact-purpose.v1',
      preferred: true,
      provenanceMethod: 'DECLARED',
      provenanceSource: 'USER',
      tenantId: tenantA,
      validFrom: new Date('2026-01-01T00:00:00.000Z'),
    } as const;
    await admin.insert(partyContactPointPurposes).values([
      { ...purposeEvidence, contactPointId: addressA, purposeKey: 'BILLING' },
      { ...purposeEvidence, contactPointId: addressA, purposeKey: 'DELIVERY' },
    ]);
    await assert.rejects(
      admin.insert(partyContactPointPurposes).values({
        ...purposeEvidence,
        contactPointId: addressA2,
        purposeKey: 'BILLING',
      }),
      hasPostgreSqlCode('23505'),
    );
    const contactEndRecordedAt = new Date();
    const futureContactEnd = new Date('2099-01-01T00:00:00.000Z');
    await admin
      .update(partyContactPoints)
      .set({
        additionalEvidenceRefs: ['evidence:additional-contact:1'],
        endEvidenceRefs: [],
        endProvenanceMethod: 'MANUAL_CONFIRMATION',
        endProvenanceSource: 'USER_ASSERTION',
        endReason: 'Future email retirement scheduled',
        endedByActionInvocationId: 'aa000000-0000-4000-8000-000000000005',
        endedByPrincipalId: principalA,
        endedRecordedAt: contactEndRecordedAt,
        validTo: futureContactEnd,
      })
      .where(eq(partyContactPoints.contactPointId, emailA2));
    await admin
      .update(partyContactPointPurposes)
      .set({
        endEvidenceRefs: ['evidence:delivery-purpose-end:1'],
        endProvenanceMethod: 'DOCUMENT_REVIEW',
        endProvenanceSource: 'EXTERNAL_EVIDENCE',
        endReason: 'Future delivery purpose retirement scheduled',
        endedByActionInvocationId: 'aa000000-0000-4000-8000-000000000006',
        endedByPrincipalId: principalA,
        endedRecordedAt: contactEndRecordedAt,
        validTo: futureContactEnd,
      })
      .where(eq(partyContactPointPurposes.purposeKey, 'DELIVERY'));
    const [scheduledContactEnd] = await admin
      .select()
      .from(partyContactPoints)
      .where(eq(partyContactPoints.contactPointId, emailA2));
    assert.equal(scheduledContactEnd?.isCurrent, true);
    assert.equal(scheduledContactEnd?.endReason, 'Future email retirement scheduled');
    assert.equal(scheduledContactEnd?.evidenceReference, 'evidence:original-contact:1');
    assert.deepEqual(scheduledContactEnd?.additionalEvidenceRefs, [
      'evidence:additional-contact:1',
    ]);
    assert.deepEqual(scheduledContactEnd?.endEvidenceRefs, []);
    const [scheduledPurposeEnd] = await admin
      .select()
      .from(partyContactPointPurposes)
      .where(eq(partyContactPointPurposes.purposeKey, 'DELIVERY'));
    assert.equal(scheduledPurposeEnd?.isCurrent, true);
    assert.equal(scheduledPurposeEnd?.endProvenanceSource, 'EXTERNAL_EVIDENCE');
    assert.deepEqual(scheduledPurposeEnd?.endEvidenceRefs, ['evidence:delivery-purpose-end:1']);
    await assert.rejects(
      admin
        .update(partyContactPointPurposes)
        .set({ validTo: futureContactEnd })
        .where(eq(partyContactPointPurposes.purposeKey, 'BILLING')),
      hasPostgreSqlCode('23514'),
    );

    await admin.insert(partyRelationships).values({
      acceptedByActionInvocationId: actionA,
      acceptedByPrincipalId: principalA,
      fromPartyId: partyPersonA,
      policyVersion: 'party.relationship.v1',
      provenanceMethod: 'DECLARED',
      provenanceSource: 'USER',
      relationshipId: relationshipA,
      relationshipType: 'CONTACT_PERSON_OF',
      tenantId: tenantA,
      toPartyId: partyOrganizationA,
      validFrom: new Date('2026-01-01T00:00:00.000Z'),
      validTo: new Date('2026-12-31T00:00:00.000Z'),
    });
    await assert.rejects(
      admin.insert(partyRelationships).values({
        acceptedByActionInvocationId: actionA,
        acceptedByPrincipalId: principalA,
        fromPartyId: partyPersonA,
        policyVersion: 'party.relationship.v1',
        provenanceMethod: 'DECLARED',
        provenanceSource: 'USER',
        relationshipType: 'CONTACT_PERSON_OF',
        tenantId: tenantA,
        toPartyId: partyOrganizationA,
        validFrom: new Date('2026-06-01T00:00:00.000Z'),
      }),
      hasPostgreSqlCode('23P01'),
    );
    await admin.insert(partyRelationships).values({
      acceptedByActionInvocationId: actionA,
      acceptedByPrincipalId: principalA,
      fromPartyId: partyPersonA,
      policyVersion: 'party.relationship.v1',
      provenanceMethod: 'DECLARED',
      provenanceSource: 'USER',
      relationshipType: 'CONTACT_PERSON_OF',
      tenantId: tenantA,
      toPartyId: partyOrganizationA,
      validFrom: new Date('2026-12-31T00:00:00.000Z'),
    });
    const effectiveRelationshipCount = async (effectiveAt: Date) =>
      (
        await admin
          .select()
          .from(partyRelationships)
          .where(
            and(
              eq(partyRelationships.fromPartyId, partyPersonA),
              eq(partyRelationships.toPartyId, partyOrganizationA),
              eq(partyRelationships.assertionState, 'ACTIVE'),
              lte(partyRelationships.validFrom, effectiveAt),
              or(isNull(partyRelationships.validTo), gt(partyRelationships.validTo, effectiveAt)),
            ),
          )
      ).length;
    assert.equal(await effectiveRelationshipCount(new Date('2026-06-01T00:00:00.000Z')), 1);
    assert.equal(await effectiveRelationshipCount(new Date('2027-01-01T00:00:00.000Z')), 1);
    const [unknownStart] = await admin
      .insert(partyRelationships)
      .values({
        acceptedByActionInvocationId: actionA,
        acceptedByPrincipalId: principalA,
        fromPartyId: partyPersonA,
        policyVersion: 'party.relationship.v1',
        provenanceMethod: 'DOCUMENT_REVIEW',
        provenanceSource: 'USER',
        relationshipType: 'CONTACT_PERSON_OF',
        tenantId: tenantA,
        toPartyId: partyOrganizationA2,
        validTo: new Date('2030-01-01T00:00:00.000Z'),
      })
      .returning();
    assert.ok(unknownStart);
    await admin
      .update(partyRelationships)
      .set({ validFrom: new Date('2028-01-01T00:00:00.000Z') })
      .where(eq(partyRelationships.relationshipId, unknownStart.relationshipId));
    await assert.rejects(
      admin.insert(partyRelationships).values({
        acceptedByActionInvocationId: actionA,
        acceptedByPrincipalId: principalA,
        fromPartyId: partyOrganizationA2,
        policyVersion: 'party.relationship.v1',
        provenanceMethod: 'DECLARED',
        provenanceSource: 'USER',
        relationshipType: 'CONTACT_PERSON_OF',
        tenantId: tenantA,
        toPartyId: partyOrganizationA,
        validFrom: new Date('2030-01-01T00:00:00.000Z'),
        validTo: new Date('2030-01-01T00:00:00.000Z'),
      }),
      hasPostgreSqlCode('23514'),
    );

    await admin.insert(counterparties).values({
      acceptedByActionInvocationId: actionA,
      acceptedByPrincipalId: principalA,
      counterpartyId: counterpartyA,
      creationReason: 'Signed commercial agreement',
      evidenceRefs: ['evidence:agreement:1'],
      legalEntityId: legalEntityA,
      partyId: partyOrganizationA,
      policyVersion: 'party.counterparty.v1',
      provenanceMethod: 'CONTRACT',
      provenanceSource: 'COMMERCE',
      sourceRecordRefs: ['commerce:agreement:1'],
      tenantId: tenantA,
    });
    await assert.rejects(
      admin.insert(counterparties).values({
        acceptedByActionInvocationId: actionA,
        acceptedByPrincipalId: principalA,
        creationReason: 'Signed commercial agreement',
        evidenceRefs: ['evidence:agreement:1'],
        legalEntityId: legalEntityA,
        partyId: partyOrganizationA,
        policyVersion: 'party.counterparty.v1',
        provenanceMethod: 'CONTRACT',
        provenanceSource: 'COMMERCE',
        sourceRecordRefs: ['commerce:agreement:1'],
        tenantId: tenantA,
      }),
      hasPostgreSqlCode('23505'),
    );
    await admin.insert(counterpartyRolePeriods).values([
      {
        acceptedByActionInvocationId: actionA,
        acceptedByPrincipalId: principalA,
        addEvidenceRefs: ['evidence:customer-role:1'],
        addReason: 'Customer agreement began',
        counterpartyId: counterpartyA,
        legalEntityId: legalEntityA,
        policyVersion: 'party.counterparty-role.v1',
        provenanceMethod: 'CONTRACT',
        provenanceSource: 'COMMERCE',
        roleType: 'CUSTOMER',
        tenantId: tenantA,
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        acceptedByActionInvocationId: actionA,
        acceptedByPrincipalId: principalA,
        addEvidenceRefs: ['evidence:supplier-role:1'],
        addReason: 'Supplier agreement began',
        counterpartyId: counterpartyA,
        legalEntityId: legalEntityA,
        policyVersion: 'party.counterparty-role.v1',
        provenanceMethod: 'CONTRACT',
        provenanceSource: 'COMMERCE',
        roleType: 'SUPPLIER',
        tenantId: tenantA,
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
    await admin
      .update(counterpartyRolePeriods)
      .set({
        endEvidenceRefs: ['evidence:customer-role-end:1'],
        endProvenanceMethod: 'CONTRACT_TERMINATION',
        endProvenanceSource: 'COMMERCE',
        endReason: 'Customer agreement ended',
        endedByActionInvocationId: 'aa000000-0000-4000-8000-000000000003',
        endedByPrincipalId: principalA,
        endedRecordedAt: new Date('2026-06-30T00:00:00.000Z'),
        isCurrent: false,
        state: 'ENDED',
        validTo: new Date('2026-06-30T00:00:00.000Z'),
      })
      .where(eq(counterpartyRolePeriods.roleType, 'CUSTOMER'));
    const futureRoleEvidence = {
      acceptedByActionInvocationId: actionA,
      acceptedByPrincipalId: principalA,
      addEvidenceRefs: ['evidence:future-customer-role:1'],
      addReason: 'Future customer agreement scheduled',
      counterpartyId: counterpartyA,
      isCurrent: false,
      legalEntityId: legalEntityA,
      policyVersion: 'party.counterparty-role.v1',
      provenanceMethod: 'CONTRACT',
      provenanceSource: 'COMMERCE',
      roleType: 'CUSTOMER',
      state: 'ACTIVE',
      tenantId: tenantA,
    } as const;
    await admin.insert(counterpartyRolePeriods).values([
      {
        ...futureRoleEvidence,
        endEvidenceRefs: ['evidence:future-customer-role-end:1'],
        endProvenanceMethod: 'CONTRACT_SCHEDULE',
        endProvenanceSource: 'COMMERCE',
        endReason: 'First future agreement is time-bounded',
        endedByActionInvocationId: 'aa000000-0000-4000-8000-000000000004',
        endedByPrincipalId: principalA,
        endedRecordedAt: new Date('2026-07-01T00:00:00.000Z'),
        validFrom: new Date('2099-01-01T00:00:00.000Z'),
        validTo: new Date('2099-02-01T00:00:00.000Z'),
      },
      {
        ...futureRoleEvidence,
        addEvidenceRefs: ['evidence:future-customer-role:2'],
        validFrom: new Date('2099-02-01T00:00:00.000Z'),
      },
    ]);
    await assert.rejects(
      admin.insert(counterpartyRolePeriods).values({
        ...futureRoleEvidence,
        addEvidenceRefs: ['evidence:overlapping-future-customer-role:1'],
        validFrom: new Date('2099-01-15T00:00:00.000Z'),
      }),
      hasPostgreSqlCode('23P01'),
    );
    const effectiveAt = new Date('2026-09-01T00:00:00.000Z');
    assert.equal(
      (
        await admin
          .select()
          .from(counterpartyRolePeriods)
          .where(
            and(
              eq(counterpartyRolePeriods.counterpartyId, counterpartyA),
              eq(counterpartyRolePeriods.state, 'ACTIVE'),
              lte(counterpartyRolePeriods.validFrom, effectiveAt),
              or(
                isNull(counterpartyRolePeriods.validTo),
                gt(counterpartyRolePeriods.validTo, effectiveAt),
              ),
            ),
          )
      ).length,
      1,
    );
    assert.equal(
      (
        await admin
          .select()
          .from(counterparties)
          .where(eq(counterparties.counterpartyId, counterpartyA))
      ).length,
      1,
    );

    const [counterpartySource] = await admin
      .select()
      .from(counterparties)
      .where(eq(counterparties.counterpartyId, counterpartyA));
    assert.ok(counterpartySource);
    await admin.insert(counterpartyAdminReadModels).values({
      archivedAt: counterpartySource.archivedAt,
      counterpartyId: counterpartySource.counterpartyId,
      createdAt: counterpartySource.createdAt,
      legalEntityId: counterpartySource.legalEntityId,
      storedPartyId: counterpartySource.partyId,
      tenantId: counterpartySource.tenantId,
    });
    const roleSources = await admin
      .select()
      .from(counterpartyRolePeriods)
      .where(eq(counterpartyRolePeriods.counterpartyId, counterpartyA));
    await admin.insert(counterpartyRoleAdminReadModels).values(
      roleSources.map((role) => ({
        addEvidenceRefs: role.addEvidenceRefs,
        addReason: role.addReason,
        counterpartyId: role.counterpartyId,
        endEvidenceRefs: role.endEvidenceRefs,
        endProvenanceMethod: role.endProvenanceMethod,
        endProvenanceSource: role.endProvenanceSource,
        endReason: role.endReason,
        provenanceMethod: role.provenanceMethod,
        provenanceSource: role.provenanceSource,
        recordedAt: role.recordedAt,
        rolePeriodId: role.rolePeriodId,
        roleType: role.roleType,
        state: role.state,
        tenantId: role.tenantId,
        validFrom: role.validFrom,
        validTo: role.validTo,
      })),
    );

    assert.deepEqual(
      await withTenant(tenantA, (transaction) => transaction.select().from(counterparties)),
      [],
    );
    assert.deepEqual(await runtime.select().from(counterpartyAdminReadModels), []);
    assert.equal(
      (
        await withTenant(tenantA, (transaction) =>
          transaction.select().from(counterpartyAdminReadModels),
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await withTenant(tenantA, (transaction) =>
          transaction.select().from(counterpartyRoleAdminReadModels),
        )
      ).length,
      roleSources.length,
    );
    assert.deepEqual(
      await withTenant(tenantB, (transaction) =>
        transaction.select().from(counterpartyAdminReadModels),
      ),
      [],
    );
    assert.deepEqual(
      await withTenant(tenantA, (transaction) =>
        transaction.select().from(counterpartyRolePeriods),
      ),
      [],
    );
    assert.equal(
      (
        await runtime.transaction(async (transaction) => {
          await transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantA}, true)`);
          await transaction.execute(
            sql`select set_config('ontos.legal_entity_id', ${legalEntityA}, true)`,
          );
          return transaction.select().from(counterparties);
        })
      ).length,
      1,
    );

    await admin.insert(duplicateCandidateCases).values({
      candidateCaseId: caseA,
      candidateFingerprint: 'a'.repeat(64),
      candidateSnapshot: {
        names: ['Ambiguous'],
        provenance: { method: 'DOCUMENT_REVIEW', source: 'USER_ASSERTION' },
        validFrom: '2026-01-01T00:00:00.000Z',
      },
      evaluatedEvidence: [
        { reason: 'One identifier points to conflicting candidates', ruleKey: 'ico.v1' },
      ],
      evaluationFingerprint: 'c'.repeat(64),
      matchRuleVersion: 'party-match.v1',
      tenantId: tenantA,
    });
    await admin.insert(duplicateCandidateCaseParties).values({
      candidateCaseId: caseA,
      evidenceExplanation: { reason: 'Authoritative conflict', ruleKey: 'ico.v1' },
      partyId: partyOrganizationA,
      rank: 1,
      tenantId: tenantA,
    });
    await admin.insert(partyMatchDecisions).values({
      actionInvocationId: actionA,
      candidateCaseId: caseA,
      candidateFingerprint: 'a'.repeat(64),
      evidenceExplanation: [
        { reason: 'One identifier points to conflicting candidates', ruleKey: 'ico.v1' },
      ],
      matchRuleVersion: 'party-match.v1',
      outcome: 'AMBIGUOUS',
      tenantId: tenantA,
    });
    await assert.rejects(
      admin.insert(partyMatchDecisions).values({
        actionInvocationId: actionA,
        candidateFingerprint: 'b'.repeat(64),
        evidenceExplanation: [],
        matchRuleVersion: 'party-match.v1',
        outcome: 'NO_MATCH',
        tenantId: tenantA,
      }),
      hasPostgreSqlCode('23505'),
    );

    await assert.rejects(
      withTenant(tenantA, async (transaction) => {
        const [fact] = await transaction
          .insert(partyFactAssertions)
          .values({
            acceptedByActionInvocationId: actionA,
            acceptedByPrincipalId: principalA,
            factKind: 'DISPLAY_NAME',
            normalizedValue: 'Wrong name',
            partyId: partyOrganizationA,
            policyVersion: 'party.fact.v1',
            provenanceMethod: 'DECLARED',
            provenanceSource: 'USER',
            tenantId: tenantA,
            validFrom: new Date('2026-01-01T00:00:00.000Z'),
          })
          .returning({ assertionId: partyFactAssertions.assertionId });
        assert.ok(fact);
        const [correction] = await transaction
          .insert(partyCorrections)
          .values({
            actingPrincipalId: principalA,
            actionInvocationId: 'aa000000-0000-4000-8000-000000000002',
            evidenceRefs: ['evidence:1'],
            partyFactAssertionId: fact.assertionId,
            partyId: partyOrganizationA,
            policyVersion: 'party.correction.v1',
            reason: 'Original assertion was wrong',
            tenantId: tenantA,
          })
          .returning({ correctionId: partyCorrections.correctionId });
        assert.ok(correction);
        await transaction
          .update(partyCorrections)
          .set({ reason: 'Mutation must fail' })
          .where(eq(partyCorrections.correctionId, correction.correctionId));
      }),
      hasPostgreSqlCode('55000'),
    );

    const mergePartyRefs = [partyOrganizationA, partyOrganizationA2].map((resourceId) => ({
      moduleId: 'party.registry' as const,
      resourceId,
      resourceType: 'party.registry.party' as const,
      tenantId: tenantA,
    }));
    const [survivorPartyRef, absorbedPartyRef] = mergePartyRefs;
    assert.ok(survivorPartyRef);
    assert.ok(absorbedPartyRef);
    const candidateSnapshots = mergePartyRefs.map((partyRef) => ({
      candidate: {
        authoritativeEvidenceRank: 1,
        blockingAuthoritativeConflict: false,
        completenessRank: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        lifecycle: 'ACTIVE' as const,
        partyRef,
        referenceStabilityRank: 1,
      },
      criterionValue: true,
      eligibleBefore: true,
      retainedAfter: true,
    }));
    await admin.insert(partyMerges).values({
      policyVersion: 'party.merge-readiness.v1',
      readinessEvidence: {
        absorbedPartyRefs: [absorbedPartyRef],
        blockingReasons: ['Consumer dry-run is required'],
        confirmedDuplicateDecisionId: 'confirmed-duplicate:fixture',
        consumerStatuses: [{ consumerKey: 'contacts', status: 'BLOCKED' }],
        decisionActorPrincipalId: principalA,
        selectionEvidenceChain: (
          ['CONFIRMED_DUPLICATE_SET', 'IDENTITY_SAFETY', 'STABLE_RESOURCE_IDENTITY'] as const
        ).map((criterion) => ({
          candidatePartyRefs: mergePartyRefs,
          candidateSnapshots,
          criterion,
          evidenceRefs: ['evidence:fixture'],
          explanation: 'Prepared-only fixture for database alias constraints',
          winnerPartyRef: criterion === 'STABLE_RESOURCE_IDENTITY' ? survivorPartyRef : null,
        })),
        selectionPolicyVersion: 'party-merge-survivor-selection.v1',
        selectionReason: 'STABLE_RESOURCE_IDENTITY',
        version: 1,
      },
      status: 'BLOCKED',
      survivorPartyId: partyOrganizationA,
      tenantId: tenantA,
    });
    const [merge] = await admin.select({ mergeId: partyMerges.mergeId }).from(partyMerges).limit(1);
    assert.ok(merge);
    await assert.rejects(
      admin.insert(partyAliases).values({
        aliasPartyId: partyOrganizationA,
        canonicalPartyId: partyOrganizationA,
        mergeId: merge.mergeId,
        tenantId: tenantA,
      }),
      hasPostgreSqlCode('23514'),
    );
  } finally {
    await cleanup();
    await runtimePool.end();
    await adminPool.end();
  }
});
