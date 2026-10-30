// Sales-demo owner seed for party.registry.
// Contract: app/scripts/demo/reset-demo.mts spawns this script with `--sales-demo`, DATABASE_ADMIN_URL
// and DEMO_RESET_PROFILE=sales in the environment. It writes only the party schema, with deterministic
// client-supplied IDs (see ./demo-customers.mts), and restores every seeded customer to its baseline:
// seeded rows return to ACTIVE, and other current facts on seeded Parties are superseded.
import { NodeServices } from '@effect/platform-node';
import { DatabaseConfig, parseDatabaseConfig } from '@app/core-runtime';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { Config, Console, DateTime, Effect, FileSystem, Layer, Path, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import { normalizeEmail, normalizePhone } from '../shared/domain/contact-point.ts';
import { partySubjectKeyFromString } from '../shared/domain/identity-contracts.ts';
import { PartyDatabase, PartyDatabaseLive } from '../src/db/client.ts';
import {
  counterparties,
  counterpartyAdminReadModels,
  counterpartyRoleAdminReadModels,
  counterpartyRolePeriods,
  parties,
  partyContactPointPurposes,
  partyContactPoints,
  partyFactAssertions,
  partyOfficialIdentifiers,
} from '../src/db/schema.ts';
import type { PartyTransaction } from '../src/db/types.ts';
import { evaluatePartySubjectEvidence } from '../src/policies/create-party-without-strong-identifier.policy.ts';
import {
  SALES_DEMO_NAMESPACE,
  demoId,
  salesDemoCustomerCounterpartyId,
  salesDemoCustomerPartyId,
  salesDemoCustomers,
  salesDemoLegalEntityId as demoLegalEntityId,
  salesDemoTenantId as demoTenantId,
} from './demo-customers.mts';
import type { SalesDemoCustomer } from './demo-customers.mts';

class SalesDemoSeedError extends Schema.TaggedError<SalesDemoSeedError>()('SalesDemoSeedError', {
  reason: Schema.String,
}) {}

const SEED_KEY = 'sales-demo';
const CONTACT_POINT_NAMESPACE = 'party.contact-point';
const acceptance = {
  acceptedByActionInvocationId: demoId('party.seed-invocation', SEED_KEY),
  acceptedByPrincipalId: demoId('party.seed-principal', SEED_KEY),
  policyVersion: 'sales-demo-v1',
} as const;
const SEED_SOURCE = 'SALES_DEMO_SYNTHETIC_FIXTURE';
const FIRST_CUSTOMER_AT = DateTime.makeUnsafe('2024-03-04T08:00:00.000Z');
const supersededFact = { isCurrent: false, state: 'SUPERSEDED' } as const;
const unverified = {
  externalEvidence: null,
  verificationState: 'UNVERIFIED',
  verifiedAt: null,
  verifiedByPrincipalId: null,
} as const;
const unverifiedWithMethod = { ...unverified, verificationMethod: null, verifierReference: null } as const;
const notEnded = {
  endedByActionInvocationId: null,
  endedByPrincipalId: null,
  endedRecordedAt: null,
  endEvidenceRefs: null,
  endProvenanceMethod: null,
  endProvenanceSource: null,
  endReason: null,
} as const;

const evidenceRef = (customer: SalesDemoCustomer) => `sales-demo:ico-${customer.ico}`;

/** Customers join roughly every three weeks, oldest first, so list ordering looks organic. */
const customerSince = (index: number): Date =>
  DateTime.toDateUtc(DateTime.add(FIRST_CUSTOMER_AT, { days: index * 21, hours: (index * 37) % 9 }));

const seedIds = (customer: SalesDemoCustomer) => {
  const key = `ico-${customer.ico}`;
  return {
    address: demoId(CONTACT_POINT_NAMESPACE, `${key}:ADDRESS`),
    addressPurpose: demoId('party.contact-point-purpose', `${key}:ADDRESS:CORRESPONDENCE`),
    counterparty: salesDemoCustomerCounterpartyId(customer.ico),
    displayName: demoId('party.fact-assertion', `${key}:DISPLAY_NAME`),
    email: demoId(CONTACT_POINT_NAMESPACE, `${key}:EMAIL`),
    ico: demoId('party.official-identifier', `${key}:ICO`),
    party: salesDemoCustomerPartyId(customer.ico),
    partyType: demoId('party.fact-assertion', `${key}:PARTY_TYPE`),
    phone: demoId(CONTACT_POINT_NAMESPACE, `${key}:PHONE`),
    role: demoId('party.customer-role', key),
    vatId: demoId('party.official-identifier', `${key}:CZ_DIC`),
  };
};

const contactProvenance = (customer: SalesDemoCustomer) => ({
  ...acceptance,
  ...notEnded,
  ...unverifiedWithMethod,
  evidenceReference: evidenceRef(customer),
  isCurrent: true,
  provenanceAuthoritative: false,
  provenanceMethod: 'MIGRATION',
  provenanceSource: 'MIGRATION_DATASET',
  state: 'ACTIVE',
  tenantId: demoTenantId,
  validTo: null,
});

const contactRows = (customer: SalesDemoCustomer, since: Date) => {
  const ids = seedIds(customer);
  const email = normalizeEmail(`${customer.mailbox}@${customer.domain}`);
  const phone = normalizePhone(customer.phone);
  const shared = {
    ...contactProvenance(customer),
    addressLine1: null,
    addressLine2: null,
    city: null,
    countryCode: null,
    partyId: ids.party,
    phoneCountryCode: null,
    phoneExtension: null,
    postalCode: null,
    privacyClassification: 'BUSINESS_SENSITIVE',
    region: null,
    validFrom: since,
  };
  return [
    {
      ...shared,
      contactPointId: ids.email,
      contactPointType: 'EMAIL',
      displayValue: email.displayValue,
      normalizationVersion: 'party-contact-v1',
      normalizedValue: email.lookupValue,
      preferred: true,
    },
    {
      ...shared,
      contactPointId: ids.phone,
      contactPointType: 'PHONE',
      displayValue: phone.displayValue,
      normalizationVersion: 'party-contact-v1',
      normalizedValue: phone.lookupValue,
      phoneCountryCode: phone.countryCode,
      phoneExtension: phone.extension,
      preferred: true,
    },
    {
      ...shared,
      addressLine1: customer.street,
      city: customer.city,
      contactPointId: ids.address,
      contactPointType: 'ADDRESS',
      countryCode: 'CZ',
      displayValue: null,
      normalizationVersion: null,
      normalizedValue: null,
      postalCode: customer.postalCode,
      preferred: false,
    },
  ];
};

const seedCustomer = Effect.fn('PartyRegistrySalesDemo.seedCustomer')(function* seedCustomer(
  transaction: PartyTransaction,
  customer: SalesDemoCustomer,
  index: number,
  now: Date,
) {
  const ids = seedIds(customer);
  const since = customerSince(index);
  const reference = evidenceRef(customer);
  const party = {
    archivedAt: null,
    createdAt: since,
    currentDisplayName: customer.name,
    currentType: 'ORGANIZATION',
    partyId: ids.party,
    tenantId: demoTenantId,
    updatedAt: now,
  };
  yield* transaction
    .insert(parties)
    .values(party)
    .onConflictDoUpdate({
      set: { archivedAt: null, currentDisplayName: customer.name, currentType: 'ORGANIZATION', updatedAt: now },
      target: parties.partyId,
    });
  const assertionBase = {
    ...acceptance,
    ...unverifiedWithMethod,
    isCurrent: true,
    partyId: ids.party,
    provenanceMethod: 'MIGRATION_REVIEW',
    provenanceSource: SEED_SOURCE,
    recordedAt: since,
    state: 'ACTIVE',
    tenantId: demoTenantId,
    validFrom: since,
    validTo: null,
  };
  const assertions = [
    {
      ...assertionBase,
      assertionId: ids.partyType,
      evidenceEvaluation: evaluatePartySubjectEvidence({
        partyType: 'ORGANIZATION',
        subjectEvidence: [
          {
            basis: 'REVIEWED_DOCUMENT',
            evidenceRef: reference,
            kind: 'ACTOR_ATTESTATION',
            observedSubject: 'ORGANIZATION',
            statement: 'Synthetic sales-demo customer organization from the public business register',
            subjectKey: partySubjectKeyFromString(`ico-${customer.ico}`),
          },
        ],
      }),
      factKind: 'PARTY_TYPE',
      normalizedValue: 'ORGANIZATION',
    },
    { ...assertionBase, assertionId: ids.displayName, factKind: 'DISPLAY_NAME', normalizedValue: customer.name },
  ];
  for (const assertion of assertions) {
    yield* transaction
      .insert(partyFactAssertions)
      .values(assertion)
      .onConflictDoUpdate({ set: assertion, target: partyFactAssertions.assertionId });
  }
  const identifierBase = {
    ...acceptance,
    ...unverified,
    isCurrent: true,
    jurisdiction: 'CZ',
    partyId: ids.party,
    provenanceMethod: 'MIGRATION_REVIEW',
    provenanceSource: SEED_SOURCE,
    recordedAt: since,
    state: 'ACTIVE',
    tenantId: demoTenantId,
    validFrom: since,
    validTo: null,
  };
  const identifiers = [
    {
      ...identifierBase,
      identifierTypeKey: 'ICO',
      namespace: 'CZ:ICO',
      normalizedValue: customer.ico,
      officialIdentifierId: ids.ico,
    },
    {
      ...identifierBase,
      identifierTypeKey: 'CZ_DIC',
      namespace: 'CZ:DIC',
      normalizedValue: `CZ${customer.ico}`,
      officialIdentifierId: ids.vatId,
    },
  ];
  for (const identifier of identifiers) {
    yield* transaction
      .insert(partyOfficialIdentifiers)
      .values(identifier)
      .onConflictDoUpdate({ set: identifier, target: partyOfficialIdentifiers.officialIdentifierId });
  }
  for (const contact of contactRows(customer, since)) {
    yield* transaction
      .insert(partyContactPoints)
      .values(contact)
      .onConflictDoUpdate({ set: contact, target: partyContactPoints.contactPointId });
  }
  const purpose = {
    ...contactProvenance(customer),
    contactPointId: ids.address,
    contactPointPurposeId: ids.addressPurpose,
    jurisdiction: 'ZZ',
    partyId: ids.party,
    preferred: true,
    purposeKey: 'CORRESPONDENCE',
    registryContext: 'GENERAL',
    validFrom: since,
  };
  yield* transaction
    .insert(partyContactPointPurposes)
    .values(purpose)
    .onConflictDoUpdate({ set: purpose, target: partyContactPointPurposes.contactPointPurposeId });
  const counterpartyEvidence = [reference];
  const provenance = { ...acceptance, provenanceMethod: 'MIGRATION_REVIEW', provenanceSource: SEED_SOURCE };
  yield* transaction
    .insert(counterparties)
    .values({
      ...provenance,
      counterpartyId: ids.counterparty,
      createdAt: since,
      creationReason: 'Synthetic sales-demo customer relationship',
      evidenceRefs: counterpartyEvidence,
      legalEntityId: demoLegalEntityId,
      partyId: ids.party,
      recordedAt: since,
      sourceRecordRefs: [],
      tenantId: demoTenantId,
    })
    .onConflictDoUpdate({ set: { archivedAt: null, updatedAt: now }, target: counterparties.counterpartyId });
  yield* transaction
    .insert(counterpartyAdminReadModels)
    .values({
      counterpartyId: ids.counterparty,
      createdAt: since,
      legalEntityId: demoLegalEntityId,
      storedPartyId: ids.party,
      tenantId: demoTenantId,
    })
    .onConflictDoUpdate({ set: { archivedAt: null }, target: counterpartyAdminReadModels.counterpartyId });
  const role = {
    ...provenance,
    ...notEnded,
    addEvidenceRefs: counterpartyEvidence,
    addReason: 'Synthetic sales-demo customer',
    counterpartyId: ids.counterparty,
    isCurrent: true,
    legalEntityId: demoLegalEntityId,
    recordedAt: since,
    rolePeriodId: ids.role,
    roleType: 'CUSTOMER',
    state: 'ACTIVE',
    tenantId: demoTenantId,
    validFrom: since,
    validTo: null,
  };
  yield* transaction
    .insert(counterpartyRolePeriods)
    .values(role)
    .onConflictDoUpdate({ set: role, target: counterpartyRolePeriods.rolePeriodId });
});

/** Ends competing current facts left on seeded Parties by earlier demo runs, so seeded rows stay unique. */
const supersedeNonSeededFacts = Effect.fn('PartyRegistrySalesDemo.supersedeNonSeededFacts')(function* supersede(
  transaction: PartyTransaction,
) {
  const ids = salesDemoCustomers.map(seedIds);
  const partyIds = ids.map(({ party }) => party);
  const counterpartyIds = ids.map(({ counterparty }) => counterparty);
  yield* transaction
    .update(partyFactAssertions)
    .set(supersededFact)
    .where(
      and(
        eq(partyFactAssertions.tenantId, demoTenantId),
        inArray(partyFactAssertions.partyId, partyIds),
        notInArray(
          partyFactAssertions.assertionId,
          ids.flatMap(({ displayName, partyType }) => [displayName, partyType]),
        ),
        eq(partyFactAssertions.state, 'ACTIVE'),
      ),
    );
  yield* transaction
    .update(partyOfficialIdentifiers)
    .set(supersededFact)
    .where(
      and(
        eq(partyOfficialIdentifiers.tenantId, demoTenantId),
        inArray(partyOfficialIdentifiers.partyId, partyIds),
        notInArray(
          partyOfficialIdentifiers.officialIdentifierId,
          ids.flatMap(({ ico, vatId }) => [ico, vatId]),
        ),
        eq(partyOfficialIdentifiers.state, 'ACTIVE'),
      ),
    );
  yield* transaction
    .update(partyContactPointPurposes)
    .set({ ...supersededFact, preferred: false })
    .where(
      and(
        eq(partyContactPointPurposes.tenantId, demoTenantId),
        inArray(partyContactPointPurposes.partyId, partyIds),
        notInArray(
          partyContactPointPurposes.contactPointPurposeId,
          ids.map(({ addressPurpose }) => addressPurpose),
        ),
        eq(partyContactPointPurposes.state, 'ACTIVE'),
      ),
    );
  yield* transaction
    .update(partyContactPoints)
    .set({ ...supersededFact, preferred: false })
    .where(
      and(
        eq(partyContactPoints.tenantId, demoTenantId),
        inArray(partyContactPoints.partyId, partyIds),
        notInArray(
          partyContactPoints.contactPointId,
          ids.flatMap(({ address, email, phone }) => [address, email, phone]),
        ),
        eq(partyContactPoints.state, 'ACTIVE'),
      ),
    );
  yield* transaction
    .update(counterpartyRolePeriods)
    .set(supersededFact)
    .where(
      and(
        eq(counterpartyRolePeriods.tenantId, demoTenantId),
        inArray(counterpartyRolePeriods.counterpartyId, counterpartyIds),
        notInArray(
          counterpartyRolePeriods.rolePeriodId,
          ids.map(({ role }) => role),
        ),
        eq(counterpartyRolePeriods.state, 'ACTIVE'),
      ),
    );
});

/** Mirrors every role period of the seeded Counterparties into the tenant-wide admin read model. */
const syncRoleReadModels = Effect.fn('PartyRegistrySalesDemo.syncRoleReadModels')(function* syncRoleReadModels(
  transaction: PartyTransaction,
) {
  const rows = yield* transaction
    .select()
    .from(counterpartyRolePeriods)
    .where(
      and(
        eq(counterpartyRolePeriods.tenantId, demoTenantId),
        inArray(
          counterpartyRolePeriods.counterpartyId,
          salesDemoCustomers.map(({ ico }) => salesDemoCustomerCounterpartyId(ico)),
        ),
      ),
    );
  for (const row of rows) {
    const values = {
      addEvidenceRefs: row.addEvidenceRefs,
      addReason: row.addReason,
      counterpartyId: row.counterpartyId,
      endEvidenceRefs: row.endEvidenceRefs,
      endProvenanceMethod: row.endProvenanceMethod,
      endProvenanceSource: row.endProvenanceSource,
      endReason: row.endReason,
      provenanceMethod: row.provenanceMethod,
      provenanceSource: row.provenanceSource,
      recordedAt: row.recordedAt,
      rolePeriodId: row.rolePeriodId,
      roleType: row.roleType,
      state: row.state,
      tenantId: row.tenantId,
      validFrom: row.validFrom,
      validTo: row.validTo,
    };
    yield* transaction
      .insert(counterpartyRoleAdminReadModels)
      .values(values)
      .onConflictDoUpdate({
        set: values,
        target: [counterpartyRoleAdminReadModels.tenantId, counterpartyRoleAdminReadModels.rolePeriodId],
      });
  }
});

/** Fails closed when the mirrored identity derivation drifts from app/scripts/demo/fixture-ids.mts. */
const verifySharedFixtureIds = Effect.fn('PartyRegistrySalesDemo.verifySharedFixtureIds')(function* verify() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fixtureIdsPath = yield* path.fromFileUrl(new URL('../../../scripts/demo/fixture-ids.mts', import.meta.url));
  const source = yield* fs.readFileString(fixtureIdsPath);
  const expected = [
    `SALES_DEMO_NAMESPACE = '${SALES_DEMO_NAMESPACE}'`,
    `demoTenantId = '${demoTenantId}'`,
    `demoLegalEntityId = '${demoLegalEntityId}'`,
  ];
  return expected.every((declaration) => source.includes(declaration))
    ? yield* Effect.void
    : yield* new SalesDemoSeedError({
        reason: 'Customer identities no longer match app/scripts/demo/fixture-ids.mts',
      });
});

const seedCustomers = Effect.fn('PartyRegistrySalesDemo.seedCustomers')(function* seedCustomers() {
  yield* verifySharedFixtureIds();
  const { executor } = yield* PartyDatabase;
  const now = yield* DateTime.nowAsDate;
  yield* executor.transaction((transaction) =>
    Effect.gen(function* restoreSalesDemoCustomers() {
      yield* supersedeNonSeededFacts(transaction);
      yield* Effect.forEach(salesDemoCustomers, (customer, index) => seedCustomer(transaction, customer, index, now), {
        concurrency: 1,
        discard: true,
      });
      yield* syncRoleReadModels(transaction);
    }),
  );
  return yield* Console.log(`party-registry: ${salesDemoCustomers.length} sales-demo customers restored`);
});

const AdminDatabaseConfigLive = Layer.effect(
  DatabaseConfig,
  Effect.gen(function* adminDatabaseConfiguration() {
    yield* Config.schema(Schema.Literal('development'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT');
    const connection = yield* Config.Redacted('DATABASE_ADMIN_URL');
    const configuration = yield* parseDatabaseConfig({ DATABASE_URL: Redacted.value(connection) });
    if (!['localhost', '127.0.0.1', '[::1]'].includes(configuration.host)) {
      return yield* new SalesDemoSeedError({ reason: 'The sales-demo seed requires local PostgreSQL' });
    }
    return configuration;
  }),
);

const command = Command.make(
  'party-registry-sales-demo-reset',
  { salesDemo: Flag.Boolean('sales-demo').pipe(Flag.withDefault(false)) },
  ({ salesDemo }) =>
    salesDemo
      ? Layer.build(
          Layer.effectDiscard(seedCustomers()).pipe(
            Layer.provide(PartyDatabaseLive.pipe(Layer.provide(AdminDatabaseConfigLive))),
          ),
        ).pipe(
          Effect.scoped,
          Effect.asVoid,
          Effect.tapError((failure) => Console.error(`party-registry sales-demo seed failed: ${failure._tag}`)),
        )
      : Effect.fail(new SalesDemoSeedError({ reason: 'Run through `pnpm demo:reset:sales` (missing --sales-demo)' })),
);
const runtimeLive = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
  Layer.provide(NodeServices.layer),
);
await Effect.runPromise(Effect.scoped(Layer.build(runtimeLive)));
