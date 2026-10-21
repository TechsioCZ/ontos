import { isDeepStrictEqual } from 'node:util';

import { AgreementsCommandSchema } from '@app/legal-agreements/contracts/apply-command';
import { RecordsResponseSchema as AgreementsRecords } from '@app/legal-agreements/contracts/records';
import { FinanceCommandSchema } from '@app/finance-billing/contracts/apply-command';
import { RecordsResponseSchema as FinanceRecords } from '@app/finance-billing/contracts/records';
import { OccupancyCommandSchema } from '@app/property-leasing/contracts/apply-command';
import { RecordsResponseSchema as OccupancyRecords } from '@app/property-leasing/contracts/records';
import { PropertyCommandSchema } from '@app/property-portfolio/contracts/apply-command';
import { PropertyDateSchema, RecordsResponseSchema as PropertyRecords } from '@app/property-portfolio/contracts/records';
import { Console, DateTime, Effect, Schema } from 'effect';

import { demoId } from './fixture-ids.mts';
import { ensureSeedCustomer, existingSeedCustomer, seedCustomerList } from './rental-seed-customer.mts';
import { DemoSeedError } from './seed-client.mts';
import type { SeedClient, SeedTarget } from './seed-client.mts';

const propertyAudience = 'property-portfolio';
const occupancyAudience = 'property-leasing';
const agreementsAudience = 'legal-agreements';
const financeAudience = 'finance-billing';
const workAudience = 'work-tasks';
const partyAudience = 'party-registry';
const pipelineAudience = 'sales-pipeline';

/**
 * Siampark rental story (company 0021): two buildings, eight units, five tenant organizations, leases in every
 * state (active, ending, upcoming, ended, draft), contracts with recorded signature evidence, service tasks on the
 * units and invoice drafts anchored to building, unit, lease and contract. Every identity is a fixed UUIDv5, so a
 * rerun only fills in what is missing and never overwrites diverging data.
 */
export const rentalStory = {
  properties: [
    { address: 'Parková 12, 140 00 Praha 4', code: 'PARKOVA', key: 'parkova', name: 'Rezidence Parková' },
    {
      address: 'Nábřeží Kapitána Jaroše 7, 170 00 Praha 7',
      code: 'RIVERSIDE',
      key: 'riverside',
      name: 'Riverside Office Park',
    },
  ],
  units: [
    { capacity: 3, code: 'A101', key: 'a101', name: 'Byt A101 · 2+kk', property: 'parkova' },
    { capacity: 4, code: 'A102', key: 'a102', name: 'Byt A102 · 3+kk', property: 'parkova' },
    { capacity: 2, code: 'A201', key: 'a201', name: 'Byt A201 · 1+kk', property: 'parkova' },
    { capacity: 3, code: 'A202', key: 'a202', name: 'Byt A202 · 2+kk', property: 'parkova' },
    { capacity: 40, code: 'R101', key: 'r101', name: 'Obchodní prostor R101', property: 'riverside' },
    { capacity: 18, code: 'R201', key: 'r201', name: 'Kancelář R201', property: 'riverside' },
    { capacity: 24, code: 'R301', key: 'r301', name: 'Kancelář R301', property: 'riverside' },
    { capacity: null, code: 'S01', key: 's01', name: 'Sklad S01', property: 'riverside' },
  ],
  tenants: [
    { evidenceKey: 'kavarna-u-parku', key: 'kavarna', name: 'Kavárna U Parku s.r.o.' },
    { evidenceKey: 'atelier-horak', key: 'atelier', name: 'Ateliér Horák s.r.o.' },
    { evidenceKey: 'technoservis-praha', key: 'technoservis', name: 'Technoservis Praha a.s.' },
    { evidenceKey: 'lekarna-na-nabrezi', key: 'lekarna', name: 'Lékárna Na Nábřeží s.r.o.' },
    { evidenceKey: 'novotny-consulting', key: 'novotny', name: 'Novotný Consulting s.r.o.' },
  ],
  leases: [
    {
      contract: {
        endDate: '2028-10-31',
        noticePeriod: '6 měsíců ke konci kalendářního měsíce',
        renewalNoticeDate: '2028-04-30',
        responsiblePerson: 'Jana Správcová',
        signedBy: 'Petra Malá, jednatelka Kavárna U Parku s.r.o.',
        signedOn: '2025-10-15',
        state: 'ACTIVE',
        subject: 'Nájem obchodního prostoru R101 pro provoz kavárny',
      },
      endDate: '2028-10-31',
      key: 'r101-kavarna',
      note: 'Kavárna s předzahrádkou, provozní doba 7–20 h.',
      rent: { monthlyRentMinor: 4_800_000, paymentDay: 10, serviceChargesMinor: 650_000 },
      startDate: '2025-11-01',
      state: 'ACTIVE',
      tenant: 'kavarna',
      unit: 'r101',
    },
    {
      contract: {
        endDate: '2027-12-31',
        noticePeriod: '3 měsíce',
        renewalNoticeDate: '2026-11-30',
        responsiblePerson: 'Jana Správcová',
        signedBy: 'Ing. arch. Tomáš Horák',
        signedOn: '2025-12-10',
        state: 'ACTIVE',
        subject: 'Nájem kanceláře R201 (2. NP) včetně dvou parkovacích stání',
      },
      endDate: '2027-12-31',
      key: 'r201-atelier',
      note: null,
      rent: { monthlyRentMinor: 3_200_000, paymentDay: 15, serviceChargesMinor: 420_000 },
      startDate: '2026-01-01',
      state: 'ACTIVE',
      tenant: 'atelier',
      unit: 'r201',
    },
    {
      contract: {
        endDate: '2026-10-31',
        noticePeriod: '2 měsíce',
        renewalNoticeDate: '2026-10-25',
        responsiblePerson: 'Martin Provozní',
        signedBy: 'Karel Dvořák, personální ředitel Technoservis Praha a.s.',
        signedOn: '2025-10-20',
        state: 'ACTIVE',
        subject: 'Služební byt A101 pro zaměstnance nájemce',
      },
      endDate: '2026-10-31',
      key: 'a101-technoservis',
      note: 'Nájem končí 31. 10. 2026 – nájemce zvažuje prodloužení o rok.',
      rent: { monthlyRentMinor: 1_850_000, paymentDay: 5, serviceChargesMinor: 320_000 },
      startDate: '2025-11-01',
      state: 'ACTIVE',
      tenant: 'technoservis',
      unit: 'a101',
    },
    {
      contract: {
        endDate: '2029-11-30',
        noticePeriod: '6 měsíců',
        renewalNoticeDate: '2029-05-31',
        responsiblePerson: 'Jana Správcová',
        signedBy: 'PharmDr. Eva Svobodová',
        signedOn: '2026-10-12',
        state: 'DRAFT',
        subject: 'Nájem kanceláře R301 pro výdejnu a zázemí lékárny',
      },
      endDate: '2029-11-30',
      key: 'r301-lekarna',
      note: 'Nástup 1. 12. 2026 po úpravě dispozice.',
      rent: { monthlyRentMinor: 4_100_000, paymentDay: 1, serviceChargesMinor: 580_000 },
      startDate: '2026-12-01',
      state: 'CONFIRMED',
      tenant: 'lekarna',
      unit: 'r301',
    },
    {
      contract: {
        endDate: null,
        noticePeriod: '3 měsíce',
        renewalNoticeDate: null,
        responsiblePerson: 'Martin Provozní',
        signedBy: 'Jan Novotný, jednatel',
        signedOn: '2025-08-20',
        state: 'TERMINATED',
        subject: 'Nájem bytu A202 – ukončeno dohodou k 31. 8. 2026',
      },
      endDate: '2026-08-31',
      key: 'a202-novotny',
      note: 'Ukončeno dohodou, byt předán bez závad.',
      rent: { monthlyRentMinor: 1_690_000, paymentDay: 15, serviceChargesMinor: 290_000 },
      startDate: '2025-09-01',
      state: 'COMPLETED',
      tenant: 'novotny',
      unit: 'a202',
    },
    {
      contract: null,
      endDate: '2027-12-31',
      key: 'a201-novotny',
      note: 'Rozjednáno: nájemce se stěhuje z A202 do menšího bytu.',
      rent: { monthlyRentMinor: 1_450_000, paymentDay: 15, serviceChargesMinor: 240_000 },
      startDate: '2027-01-01',
      state: 'DRAFT',
      tenant: 'novotny',
      unit: 'a201',
    },
  ],
  tasks: [
    {
      description: 'Roční revize vzduchotechniky a digestoře v kavárně, protokol založit ke smlouvě.',
      dueDate: '2026-11-12',
      key: 'r101-vzt',
      lease: 'r101-kavarna',
      priority: 'HIGH',
      title: 'Revize vzduchotechniky – kavárna R101',
    },
    {
      description: 'Výměna vadného světla na schodišti u R201.',
      dueDate: '2026-10-28',
      key: 'r201-svetlo',
      lease: 'r201-atelier',
      priority: 'NORMAL',
      title: 'Oprava osvětlení před kanceláří R201',
    },
    {
      description: 'Předávací protokol, odečty měřidel a kontrola vybavení při konci nájmu.',
      dueDate: '2026-10-31',
      key: 'a101-predani',
      lease: 'a101-technoservis',
      priority: 'HIGH',
      title: 'Předání bytu A101 při konci nájmu',
    },
    {
      description: 'Úprava dispozice a příprava přípojek pro výdejnu před nástupem nájemce.',
      dueDate: '2026-11-20',
      key: 'r301-dispozice',
      lease: 'r301-lekarna',
      priority: 'NORMAL',
      title: 'Úprava dispozice R301 před nástupem lékárny',
    },
  ],
  invoices: [
    {
      documentNumber: 'NAJ-R101-2026-11',
      dueDate: '2026-11-10',
      issueDate: '2026-11-01',
      lease: 'r101-kavarna',
      period: 'listopad 2026',
    },
    {
      documentNumber: 'NAJ-R201-2026-11',
      dueDate: '2026-11-15',
      issueDate: '2026-11-01',
      lease: 'r201-atelier',
      period: 'listopad 2026',
    },
    {
      documentNumber: 'NAJ-A101-2026-10',
      dueDate: '2026-10-05',
      issueDate: '2026-10-01',
      lease: 'a101-technoservis',
      period: 'říjen 2026',
    },
  ],
  opportunity: {
    expectedCloseDate: '2026-11-15',
    line: { productName: 'Nájem kanceláře R301, roční nájemné', quantity: 12, unitPriceMinor: 4_680_000, vatRate: 21 },
    tenant: 'lekarna',
    title: 'Pronájem Riverside R301 – Lékárna Na Nábřeží',
  },
} as const;

/** Kept for the CLI summary and older callers. */
export const rentalSeed = {
  propertyName: rentalStory.properties[0].name,
  unitName: rentalStory.units[1].name,
} as const;

type PropertySpec = (typeof rentalStory.properties)[number];
type UnitSpec = (typeof rentalStory.units)[number];
type TenantSpec = (typeof rentalStory.tenants)[number];
type LeaseSpec = (typeof rentalStory.leases)[number];
type TaskSpec = (typeof rentalStory.tasks)[number];
type InvoiceSpec = (typeof rentalStory.invoices)[number];

const seedNote = 'DEMO siampark-rental-v2: syntetický příklad, bez skutečného podepsaného souboru.';
const propertyRead = Schema.toEncoded(PropertyRecords);
const occupancyRead = Schema.toEncoded(OccupancyRecords);
const agreementsRead = Schema.toEncoded(AgreementsRecords);
const financeRead = Schema.toEncoded(FinanceRecords);
const propertyCommand = Schema.toEncoded(PropertyCommandSchema);
const occupancyCommand = Schema.toEncoded(OccupancyCommandSchema);
const agreementCommand = Schema.toEncoded(AgreementsCommandSchema);
const financeCommand = Schema.toEncoded(FinanceCommandSchema);
const occupancyReferenceAudiences = [propertyAudience, propertyAudience, partyAudience, agreementsAudience];
const contractReferenceAudiences = [partyAudience, propertyAudience, propertyAudience, occupancyAudience];

const ContextRef = Schema.Struct({
  moduleId: Schema.String,
  resourceId: Schema.String,
  resourceType: Schema.String,
  tenantId: Schema.String,
});
// Bounded operator projection of the public work-tasks records contract.
const WorkRecords = Schema.Struct({
  items: Schema.Array(Schema.Struct({ contextRefs: Schema.Array(ContextRef), title: Schema.String })),
  revision: Schema.Int,
});
const CreateTask = Schema.TaggedStruct('CreateTask', {
  contextRefs: Schema.Array(ContextRef),
  description: Schema.String,
  dueDate: PropertyDateSchema,
  partyId: Schema.String,
  priority: Schema.Literals(['LOW', 'NORMAL', 'HIGH']),
  title: Schema.String,
});
const Line = Schema.Struct({
  productId: Schema.optionalKey(Schema.toEncoded(Schema.String.pipe(Schema.brand('ProductId')))),
  productName: Schema.String,
  quantity: Schema.Int,
  unitPriceMinor: Schema.Int,
  vatRate: Schema.Int,
});
// Bounded operator projection of the public sales-pipeline HTTP contract.
const Opportunities = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      lines: Schema.Array(Line),
      partyId: Schema.toEncoded(Schema.String.pipe(Schema.brand('PartyId'))),
      title: Schema.String,
    }),
  ),
  revision: Schema.Int,
});
const CreateOpportunity = Schema.TaggedStruct('CreateOpportunity', {
  expectedCloseDate: PropertyDateSchema,
  lines: Schema.Array(Line),
  partyId: Schema.toEncoded(Schema.String.pipe(Schema.brand('PartyId'))),
  title: Schema.String,
});

export const requireSeedMatch = (label: string, matches: boolean) =>
  matches
    ? Effect.void
    : Effect.fail(
        new DemoSeedError({ reason: `${label} conflicts with the fixture. Existing data was not overwritten.` }),
      );
export const uniqueSeedRecord = <A,>(label: string, records: readonly A[]) =>
  records.length <= 1
    ? Effect.succeed(records[0])
    : Effect.fail(
        new DemoSeedError({ reason: `${label} has multiple matches. Refusing to create or overwrite data.` }),
      );
const required = <A,>(label: string, value: A | undefined) =>
  value === undefined
    ? Effect.fail(new DemoSeedError({ reason: `${label} could not be read back.` }))
    : Effect.succeed(value);

const storyRef = <M extends string, K extends string>(target: SeedTarget, moduleId: M, kind: K, key: string) => ({
  moduleId,
  resourceId: demoId(`siampark-rental.${kind}`, `${target.tenantId}:${target.legalEntityId}:${key}`),
  resourceType: `${moduleId}.${kind}` as const,
  tenantId: target.tenantId,
});

const ensureProperty = (client: SeedClient, spec: PropertySpec) =>
  Effect.gen(function* property() {
    let snapshot = yield* client.read(propertyAudience, propertyRead);
    const matching = () => snapshot.properties.filter((item) => item.code === spec.code);
    let record = yield* uniqueSeedRecord(`Property ${spec.code}`, matching());
    if (record === undefined) {
      yield* client.apply(
        propertyAudience,
        propertyCommand,
        { _tag: 'CreateProperty', address: spec.address, code: spec.code, name: spec.name },
        snapshot.revision,
      );
      snapshot = yield* client.read(propertyAudience, propertyRead);
      record = yield* required(`Property ${spec.code}`, yield* uniqueSeedRecord(`Property ${spec.code}`, matching()));
    }
    yield* requireSeedMatch(`Property ${spec.code}`, ['PLANNED', 'ACTIVE'].includes(record.lifecycleState));
    if (record.lifecycleState === 'PLANNED') {
      yield* client.apply(
        propertyAudience,
        propertyCommand,
        { _tag: 'ChangePropertyLifecycle', lifecycleState: 'ACTIVE', propertyRef: record.propertyRef },
        snapshot.revision,
      );
    }
    return record;
  });
type Property = Effect.Success<ReturnType<typeof ensureProperty>>;

const ensureUnit = (client: SeedClient, property: Property, spec: UnitSpec) =>
  Effect.gen(function* unit() {
    let snapshot = yield* client.read(propertyAudience, propertyRead);
    const matching = () =>
      snapshot.units.filter(
        (item) => item.code === spec.code && item.propertyRef.resourceId === property.propertyRef.resourceId,
      );
    let record = yield* uniqueSeedRecord(`Unit ${spec.code}`, matching());
    if (record === undefined) {
      yield* client.apply(
        propertyAudience,
        propertyCommand,
        {
          _tag: 'CreateUnit',
          capacity: spec.capacity,
          code: spec.code,
          name: spec.name,
          propertyRef: property.propertyRef,
        },
        snapshot.revision,
      );
      snapshot = yield* client.read(propertyAudience, propertyRead);
      record = yield* required(`Unit ${spec.code}`, yield* uniqueSeedRecord(`Unit ${spec.code}`, matching()));
    }
    yield* requireSeedMatch(`Unit ${spec.code}`, record.lifecycleState === 'ACTIVE');
    return record;
  });
type Unit = Effect.Success<ReturnType<typeof ensureUnit>>;
type Customer = Effect.Success<ReturnType<typeof ensureSeedCustomer>>;

const rentTerms = (spec: LeaseSpec) => ({ currency: 'CZK' as const, ...spec.rent });

/** Creates the lease draft once, then walks it to its target state; contract activation happens in between. */
const ensureLeaseDraft = (client: SeedClient, target: SeedTarget, spec: LeaseSpec, unit: Unit, tenant: Customer) =>
  Effect.gen(function* leaseDraft() {
    const occupancyRef = storyRef(target, 'property.leasing', 'occupancy', spec.key);
    let snapshot = yield* client.read(occupancyAudience, occupancyRead);
    let record = snapshot.occupancies.find((item) => item.occupancyRef.resourceId === occupancyRef.resourceId);
    if (record === undefined) {
      yield* client.apply(
        occupancyAudience,
        occupancyCommand,
        {
          _tag: 'CreateDraft',
          record: {
            contractRef: null,
            customerCounterpartyRef: tenant.counterpartyRef,
            endDate: spec.endDate,
            externalBookingCorrelation: null,
            guestPartyRef: null,
            kind: 'LONG_TERM_LEASE',
            note: spec.note,
            occupancyRef,
            peopleCount: null,
            rentTerms: rentTerms(spec),
            startDate: spec.startDate,
            state: 'DRAFT',
            unitRef: unit.unitRef,
          },
        },
        snapshot.revision,
        occupancyReferenceAudiences,
      );
      snapshot = yield* client.read(occupancyAudience, occupancyRead);
      record = yield* required(
        `Lease ${spec.key}`,
        snapshot.occupancies.find((item) => item.occupancyRef.resourceId === occupancyRef.resourceId),
      );
    }
    yield* requireSeedMatch(
      `Lease ${spec.key}`,
      record.unitRef.resourceId === unit.unitRef.resourceId &&
        record.customerCounterpartyRef?.resourceId === tenant.counterpartyRef.resourceId &&
        record.state !== 'CANCELLED',
    );
    if (record.rentTerms === undefined && record.state !== 'COMPLETED') {
      yield* client.apply(
        occupancyAudience,
        occupancyCommand,
        { _tag: 'SetRentTerms', occupancyRef: record.occupancyRef, rentTerms: rentTerms(spec) },
        snapshot.revision,
      );
    }
    return record;
  });
type Lease = Effect.Success<ReturnType<typeof ensureLeaseDraft>>;

const occupancyState = (client: SeedClient, lease: Lease) =>
  client.read(occupancyAudience, occupancyRead).pipe(
    Effect.map((snapshot) => ({
      record: snapshot.occupancies.find((item) => item.occupancyRef.resourceId === lease.occupancyRef.resourceId),
      revision: snapshot.revision,
    })),
  );
const applyOccupancy = (
  client: SeedClient,
  lease: Lease,
  command: typeof occupancyCommand.Type,
  from: readonly string[],
) =>
  Effect.gen(function* step() {
    const { record, revision } = yield* occupancyState(client, lease);
    if (record !== undefined && from.includes(record.state)) {
      yield* client.apply(occupancyAudience, occupancyCommand, command, revision, occupancyReferenceAudiences);
    }
  });

const ensureContract = (
  client: SeedClient,
  target: SeedTarget,
  spec: LeaseSpec,
  unit: Unit,
  tenant: Customer,
  lease: Lease,
) =>
  Effect.gen(function* contract() {
    const terms = spec.contract;
    if (terms === null) {
      return undefined;
    }
    const contractRef = storyRef(target, 'legal.agreements', 'contract', spec.key);
    const find = (items: (typeof agreementsRead.Type)['contracts']) =>
      items.find((item) => item.contractRef.resourceId === contractRef.resourceId);
    let snapshot = yield* client.read(agreementsAudience, agreementsRead);
    let record = find(snapshot.contracts);
    if (record === undefined) {
      yield* client.apply(
        agreementsAudience,
        agreementCommand,
        {
          _tag: 'CreateContract',
          record: {
            contractRef,
            counterpartyRef: tenant.counterpartyRef,
            endDate: terms.endDate,
            kind: 'LEASE',
            lifecycleState: 'DRAFT',
            note: seedNote,
            noticePeriod: terms.noticePeriod,
            occupancyRef: lease.occupancyRef,
            propertyRef: unit.propertyRef,
            renewalNoticeDate: terms.renewalNoticeDate,
            rentTerms: rentTerms(spec),
            responsiblePerson: terms.responsiblePerson,
            signatureState: 'NOT_SENT',
            startDate: spec.startDate,
            subject: terms.subject,
            supersedesContractRef: null,
            unitRef: unit.unitRef,
          },
        },
        snapshot.revision,
        contractReferenceAudiences,
      );
      snapshot = yield* client.read(agreementsAudience, agreementsRead);
      record = yield* required(`Contract ${spec.key}`, find(snapshot.contracts));
    }
    yield* requireSeedMatch(
      `Contract ${spec.key}`,
      record.counterpartyRef.resourceId === tenant.counterpartyRef.resourceId &&
        record.unitRef?.resourceId === unit.unitRef.resourceId,
    );
    if (
      record.signatureState === 'NOT_SENT' &&
      (record.lifecycleState === 'DRAFT' || record.lifecycleState === 'ACTIVE')
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* client.apply(
        agreementsAudience,
        agreementCommand,
        {
          _tag: 'RecordSignedDocument',
          contractRef: record.contractRef,
          document: {
            contractRef: record.contractRef,
            createdAt: now,
            documentRef: storyRef(target, 'legal.agreements', 'document', spec.key),
            fileName: `Najemni-smlouva-${unit.code}-podepsana.pdf`,
            kind: 'LEASE',
            lifecycleState: 'FINAL',
            signedDocumentReference: `demo://siampark/smlouvy/${spec.key}`,
            title: `Podepsaná nájemní smlouva ${unit.code} (DEMO evidence, bez souboru)`,
            updatedAt: now,
          },
          signedBy: terms.signedBy,
          signedOn: terms.signedOn,
        },
        snapshot.revision,
      );
    }
    return record;
  });
type Contract = NonNullable<Effect.Success<ReturnType<typeof ensureContract>>>;

const contractState = (client: SeedClient, contract: Contract) =>
  client.read(agreementsAudience, agreementsRead).pipe(
    Effect.map((snapshot) => ({
      record: snapshot.contracts.find((item) => item.contractRef.resourceId === contract.contractRef.resourceId),
      revision: snapshot.revision,
    })),
  );

/** Drives contract and lease to the story state in the only order the owners accept. */
const progressLease = (client: SeedClient, spec: LeaseSpec, lease: Lease, contract: Contract | undefined) =>
  Effect.gen(function* progress() {
    if (spec.state === 'DRAFT') {
      return;
    }
    yield* applyOccupancy(client, lease, { _tag: 'Confirm', occupancyRef: lease.occupancyRef }, ['DRAFT']);
    const contractTarget = spec.contract?.state;
    if (contract !== undefined && (contractTarget === 'ACTIVE' || contractTarget === 'TERMINATED')) {
      const { record, revision } = yield* contractState(client, contract);
      if (record?.lifecycleState === 'DRAFT') {
        yield* client.apply(
          agreementsAudience,
          agreementCommand,
          { _tag: 'ActivateContract', contractRef: contract.contractRef },
          revision,
          contractReferenceAudiences,
        );
      }
    }
    if (contract !== undefined && (spec.state === 'ACTIVE' || spec.state === 'COMPLETED')) {
      yield* applyOccupancy(
        client,
        lease,
        { _tag: 'Activate', contractRef: contract.contractRef, occupancyRef: lease.occupancyRef },
        ['CONFIRMED'],
      );
    }
    if (spec.state === 'COMPLETED') {
      yield* applyOccupancy(client, lease, { _tag: 'Complete', occupancyRef: lease.occupancyRef }, ['ACTIVE']);
    }
    if (contract !== undefined && contractTarget === 'TERMINATED') {
      const { record, revision } = yield* contractState(client, contract);
      if (record?.lifecycleState === 'ACTIVE') {
        yield* client.apply(
          agreementsAudience,
          agreementCommand,
          { _tag: 'TerminateContract', contractRef: contract.contractRef },
          revision,
        );
      }
    }
  });

const ensureTenantContacts = (client: SeedClient, lease: Lease) =>
  Effect.gen(function* tenantContacts() {
    if (lease.customerCounterpartyRef === null) return;
    const snapshot = yield* client.read(occupancyAudience, occupancyRead);
    // Retain any operator edits, communication and archival evidence; only fill a missing dossier.
    if (snapshot.tenantDossiers?.some((item) => item.counterpartyId === lease.customerCounterpartyRef?.resourceId))
      return;
    yield* client.apply(
      occupancyAudience,
      occupancyCommand,
      {
        _tag: 'UpdateTenantDossier',
        occupancyRef: lease.occupancyRef,
        contacts: [
          {
            id: demoId('siampark-rental.contact', 'kavarna-lucie'),
            name: 'Lucie Parková',
            role: 'Jednatelka',
            email: 'lucie@kavarna-u-parku.demo',
            phone: '+420 777 101 101',
          },
          {
            id: demoId('siampark-rental.contact', 'kavarna-petr'),
            name: 'Petr Novák',
            role: 'Vedoucí provozu',
            email: 'petr@kavarna-u-parku.demo',
            phone: '+420 777 101 102',
          },
        ],
        activity: { kind: 'NOTE', summary: 'DEMO: založena evidence kontaktních osob nájemce kavárny R101.' },
      },
      snapshot.revision,
    );
  });

const ensureTask = (client: SeedClient, spec: TaskSpec, unit: Unit, tenant: Customer) =>
  Effect.gen(function* task() {
    const snapshot = yield* client.read(workAudience, WorkRecords);
    if (snapshot.items.some((item) => item.title === spec.title)) {
      return;
    }
    yield* client.apply(
      workAudience,
      CreateTask,
      {
        _tag: 'CreateTask',
        contextRefs: [unit.propertyRef, unit.unitRef],
        description: spec.description,
        dueDate: spec.dueDate,
        partyId: tenant.partyRef.resourceId,
        priority: spec.priority,
        title: spec.title,
      },
      snapshot.revision,
      [propertyAudience, propertyAudience],
    );
  });

const ensureInvoice = (
  client: SeedClient,
  spec: InvoiceSpec,
  lease: LeaseSpec,
  unit: Unit,
  tenant: Customer,
  occupancy: Lease,
  contract: Contract | undefined,
) =>
  Effect.gen(function* invoice() {
    const snapshot = yield* client.read(financeAudience, financeRead);
    const lines = [
      {
        description: `Nájemné ${unit.code} – ${spec.period}`,
        quantity: 1,
        unitPriceMinor: lease.rent.monthlyRentMinor,
        vatRate: 21 as const,
      },
      {
        description: `Zálohy na služby ${unit.code} – ${spec.period}`,
        quantity: 1,
        unitPriceMinor: lease.rent.serviceChargesMinor,
        vatRate: 21 as const,
      },
    ];
    const existing = yield* uniqueSeedRecord(
      `Invoice ${spec.documentNumber}`,
      snapshot.state.invoices.filter((item) => item.documentNumber === spec.documentNumber),
    );
    if (existing !== undefined) {
      yield* requireSeedMatch(
        `Invoice ${spec.documentNumber}`,
        existing.counterpartyRef.resourceId === tenant.counterpartyRef.resourceId &&
          isDeepStrictEqual(existing.lines, lines),
      );
      return;
    }
    yield* client.apply(
      financeAudience,
      financeCommand,
      {
        _tag: 'CreateInvoiceDraft',
        ...(contract === undefined ? {} : { contractRef: contract.contractRef }),
        counterpartyRef: tenant.counterpartyRef,
        currency: 'CZK',
        direction: 'OUTGOING',
        documentNumber: spec.documentNumber,
        dueDate: spec.dueDate,
        issueDate: spec.issueDate,
        lines,
        note: `Nájem ${unit.name}, ${spec.period}. ${seedNote}`,
        occupancyRef: occupancy.occupancyRef,
        partyId: tenant.partyRef.resourceId,
        propertyRef: unit.propertyRef,
        unitRef: unit.unitRef,
      },
      snapshot.revision,
      [
        partyAudience,
        propertyAudience,
        propertyAudience,
        occupancyAudience,
        ...(contract === undefined ? [] : [agreementsAudience]),
      ],
    );
  });

const ensureOpportunity = (client: SeedClient, tenant: Customer) =>
  Effect.gen(function* opportunity() {
    const spec = rentalStory.opportunity;
    const snapshot = yield* client.read(pipelineAudience, Opportunities);
    if (snapshot.items.some((item) => item.title === spec.title)) {
      return;
    }
    yield* client.apply(
      pipelineAudience,
      CreateOpportunity,
      {
        _tag: 'CreateOpportunity',
        expectedCloseDate: spec.expectedCloseDate,
        lines: [spec.line],
        partyId: tenant.partyRef.resourceId,
        title: spec.title,
      },
      snapshot.revision,
    );
  });

const byKey = <A extends { readonly key: string }>(label: string, items: ReadonlyMap<string, A>, key: string) => {
  const value = items.get(key);
  return value === undefined
    ? Effect.fail(new DemoSeedError({ reason: `${label} ${key} is missing.` }))
    : Effect.succeed(value);
};

export const seedRentalDemo = (
  client: SeedClient,
  target: SeedTarget,
  options: { readonly apply: boolean; readonly checkpointPath: string; readonly demoSignature: boolean },
) =>
  Effect.gen(function* seedRental() {
    // Fail missing owner/read permissions before the first business write.
    yield* client.read(propertyAudience, propertyRead);
    const customers = yield* seedCustomerList(client);
    for (const tenant of rentalStory.tenants) {
      yield* existingSeedCustomer(customers, tenant.name);
    }
    yield* client.read(occupancyAudience, occupancyRead);
    yield* client.read(agreementsAudience, agreementsRead);
    yield* client.read(workAudience, WorkRecords);
    yield* client.read(pipelineAudience, Opportunities);
    yield* client.read(financeAudience, financeRead);
    if (!options.apply) {
      return { applied: false, demoSignature: options.demoSignature };
    }
    const properties = new Map<string, Property & { readonly key: string }>();
    for (const spec of rentalStory.properties) {
      properties.set(spec.key, { ...(yield* ensureProperty(client, spec)), key: spec.key });
    }
    const units = new Map<string, Unit & { readonly key: string }>();
    for (const spec of rentalStory.units) {
      const property = yield* byKey('Property', properties, spec.property);
      units.set(spec.key, { ...(yield* ensureUnit(client, property, spec)), key: spec.key });
    }
    yield* Console.log(`Properties and units ready: ${properties.size} buildings, ${units.size} units.`);
    const tenants = new Map<string, Customer & { readonly key: string }>();
    const checkpointDirectory = options.checkpointPath.replace(/[^/]+$/u, '');
    for (const spec of rentalStory.tenants) {
      const customer = yield* ensureSeedCustomer(client, target, `${checkpointDirectory}tenant-${spec.key}.json`, {
        evidenceKey: spec.evidenceKey,
        name: spec.name,
      });
      tenants.set(spec.key, { ...customer, key: spec.key });
    }
    yield* Console.log(`Tenants ready: ${tenants.size}.`);
    const leases = new Map<
      string,
      { readonly contract: Contract | undefined; readonly lease: Lease; readonly key: string }
    >();
    for (const spec of rentalStory.leases) {
      const unit = yield* byKey('Unit', units, spec.unit);
      const tenant = yield* byKey('Tenant', tenants, spec.tenant);
      const lease = yield* ensureLeaseDraft(client, target, spec, unit, tenant);
      const contract = yield* ensureContract(client, target, spec, unit, tenant, lease);
      yield* progressLease(client, spec, lease, contract);
      if (spec.key === 'r101-kavarna') yield* ensureTenantContacts(client, lease);
      leases.set(spec.key, { contract, key: spec.key, lease });
      yield* Console.log(
        `Lease ${spec.key}: ${spec.state}${contract === undefined ? '' : `, contract ${spec.contract?.state}`}.`,
      );
    }
    for (const spec of rentalStory.tasks) {
      const leaseSpec = rentalStory.leases.find((item) => item.key === spec.lease);
      if (leaseSpec !== undefined) {
        yield* ensureTask(
          client,
          spec,
          yield* byKey('Unit', units, leaseSpec.unit),
          yield* byKey('Tenant', tenants, leaseSpec.tenant),
        );
      }
    }
    yield* Console.log(`Service tasks ready: ${rentalStory.tasks.length}.`);
    for (const spec of rentalStory.invoices) {
      const leaseSpec = rentalStory.leases.find((item) => item.key === spec.lease);
      const seeded = leases.get(spec.lease);
      if (leaseSpec !== undefined && seeded !== undefined) {
        yield* ensureInvoice(
          client,
          spec,
          leaseSpec,
          yield* byKey('Unit', units, leaseSpec.unit),
          yield* byKey('Tenant', tenants, leaseSpec.tenant),
          seeded.lease,
          seeded.contract,
        );
      }
    }
    yield* Console.log(`Invoice drafts ready: ${rentalStory.invoices.length}.`);
    yield* ensureOpportunity(client, yield* byKey('Tenant', tenants, rentalStory.opportunity.tenant));
    return { applied: true, demoSignature: options.demoSignature };
  });
