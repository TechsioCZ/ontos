import { isDeepStrictEqual } from 'node:util';

import { AgreementsCommandSchema } from '@app/siampark-agreements/contracts/apply-command';
import { RecordsResponseSchema as AgreementsRecords } from '@app/siampark-agreements/contracts/records';
import { FinanceCommandSchema } from '@app/siampark-billing-finance/contracts/apply-command';
import { RecordsResponseSchema as FinanceRecords } from '@app/siampark-billing-finance/contracts/records';
import { OccupancyCommandSchema } from '@app/siampark-occupancy/contracts/apply-command';
import { RecordsResponseSchema as OccupancyRecords } from '@app/siampark-occupancy/contracts/records';
import { PropertyCommandSchema } from '@app/siampark-property/contracts/apply-command';
import { PropertyDateSchema, RecordsResponseSchema as PropertyRecords } from '@app/siampark-property/contracts/records';
import { DateTime, Effect, Schema } from 'effect';

import { demoId } from './fixture-ids.mts';
import { ensureSeedCustomer, existingSeedCustomer, seedCustomerList } from './rental-seed-customer.mts';
import { DemoSeedError } from './seed-client.mts';
import type { SeedClient, SeedTarget } from './seed-client.mts';

const propertyAudience = 'siampark-property';
const occupancyAudience = 'siampark-occupancy';
const agreementsAudience = 'siampark-agreements';
const financeAudience = 'siampark-billing-finance';
const partyAudience = 'party-registry';
const pipelineAudience = 'sales-pipeline';
const propertyLabel = 'Property';
const unitLabel = 'Unit';
const occupancyLabel = 'Occupancy';
const contractLabel = 'Contract';
export const rentalSeed = {
  address: 'Parková 12, Praha',
  endDate: '2027-10-31',
  invoiceNumber: 'DEMO-PARKOVA-2026-11',
  line: { productName: 'Nájem Parková, byt A102, listopad 2026', quantity: 1, unitPriceMinor: 1_250_025, vatRate: 21 },
  propertyCode: 'PARKOVA',
  propertyName: 'Rezidence Parková',
  startDate: '2026-11-01',
  title: 'Pronájem Parková, byt A102',
  unitCode: 'A102',
  unitName: 'Byt A102',
} as const;
const seedNote = 'DEMO sales-rental-v1: synthetic rental example, no real signed file.';
const propertyRead = Schema.toEncoded(PropertyRecords);
const occupancyRead = Schema.toEncoded(OccupancyRecords);
const agreementsRead = Schema.toEncoded(AgreementsRecords);
const financeRead = Schema.toEncoded(FinanceRecords);
const propertyCommand = Schema.toEncoded(PropertyCommandSchema);
const occupancyCommand = Schema.toEncoded(OccupancyCommandSchema);
const agreementCommand = Schema.toEncoded(AgreementsCommandSchema);
const financeCommand = Schema.toEncoded(FinanceCommandSchema);
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

const ensureProperty = (client: SeedClient) =>
  Effect.gen(function* property() {
    let snapshot = yield* client.read(propertyAudience, propertyRead);
    let record = yield* uniqueSeedRecord(
      propertyLabel,
      snapshot.properties.filter((item) => item.code === rentalSeed.propertyCode),
    );
    if (record === undefined) {
      yield* client.apply(
        propertyAudience,
        propertyCommand,
        {
          _tag: 'CreateProperty',
          address: rentalSeed.address,
          code: rentalSeed.propertyCode,
          name: rentalSeed.propertyName,
        },
        snapshot.revision,
      );
      snapshot = yield* client.read(propertyAudience, propertyRead);
      record = yield* uniqueSeedRecord(
        propertyLabel,
        snapshot.properties.filter((item) => item.code === rentalSeed.propertyCode),
      );
    }
    if (record === undefined) {
      return yield* new DemoSeedError({ reason: 'Created property could not be read.' });
    }
    yield* requireSeedMatch(
      propertyLabel,
      record.name === rentalSeed.propertyName &&
        record.address === rentalSeed.address &&
        ['PLANNED', 'ACTIVE'].includes(record.lifecycleState),
    );
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
const ensureUnit = (client: SeedClient, property: Effect.Success<ReturnType<typeof ensureProperty>>) =>
  Effect.gen(function* unit() {
    let snapshot = yield* client.read(propertyAudience, propertyRead);
    const matching = (items: typeof snapshot.units) =>
      items.filter(
        (item) => item.code === rentalSeed.unitCode && item.propertyRef.resourceId === property.propertyRef.resourceId,
      );
    let record = yield* uniqueSeedRecord(unitLabel, matching(snapshot.units));
    if (record === undefined) {
      yield* client.apply(
        propertyAudience,
        propertyCommand,
        {
          _tag: 'CreateUnit',
          capacity: null,
          code: rentalSeed.unitCode,
          name: rentalSeed.unitName,
          propertyRef: property.propertyRef,
        },
        snapshot.revision,
      );
      snapshot = yield* client.read(propertyAudience, propertyRead);
      record = yield* uniqueSeedRecord(unitLabel, matching(snapshot.units));
    }
    if (record === undefined) {
      return yield* new DemoSeedError({ reason: 'Created unit could not be read.' });
    }
    yield* requireSeedMatch(unitLabel, record.name === rentalSeed.unitName && record.lifecycleState === 'ACTIVE');
    return record;
  });
type Customer = Effect.Success<ReturnType<typeof ensureSeedCustomer>>;
type Unit = Effect.Success<ReturnType<typeof ensureUnit>>;
const resourceRef = <M extends string, K extends string>(target: SeedTarget, moduleId: M, kind: K) => ({
  moduleId,
  resourceId: demoId(`rental-seed.${kind}`, `${target.tenantId}:${target.legalEntityId}:v1`),
  resourceType: `${moduleId}.${kind}` as const,
  tenantId: target.tenantId,
});
const ensureOpportunity = (client: SeedClient, customer: Customer) =>
  Effect.gen(function* opportunity() {
    const snapshot = yield* client.read(pipelineAudience, Opportunities);
    const existing = yield* uniqueSeedRecord(
      'Opportunity',
      snapshot.items.filter((item) => item.title === rentalSeed.title),
    );
    if (existing !== undefined) {
      yield* requireSeedMatch(
        'Opportunity',
        existing.partyId === customer.partyRef.resourceId && isDeepStrictEqual(existing.lines, [rentalSeed.line]),
      );
      return;
    }
    yield* client.apply(
      pipelineAudience,
      CreateOpportunity,
      {
        _tag: 'CreateOpportunity',
        expectedCloseDate: rentalSeed.startDate,
        lines: [rentalSeed.line],
        partyId: customer.partyRef.resourceId,
        title: rentalSeed.title,
      },
      snapshot.revision,
    );
  });
const ensureOccupancy = (client: SeedClient, target: SeedTarget, unit: Unit, customer: Customer) =>
  Effect.gen(function* occupancy() {
    let snapshot = yield* client.read(occupancyAudience, occupancyRead);
    const matching = (items: typeof snapshot.occupancies) =>
      items.filter(
        (item) =>
          item.unitRef.resourceId === unit.unitRef.resourceId &&
          item.startDate === rentalSeed.startDate &&
          item.endDate === rentalSeed.endDate,
      );
    let record = yield* uniqueSeedRecord(occupancyLabel, matching(snapshot.occupancies));
    if (record === undefined) {
      yield* client.apply(
        occupancyAudience,
        occupancyCommand,
        {
          _tag: 'CreateDraft',
          record: {
            contractRef: null,
            customerCounterpartyRef: customer.counterpartyRef,
            endDate: rentalSeed.endDate,
            externalBookingCorrelation: null,
            guestPartyRef: null,
            kind: 'LONG_TERM_LEASE',
            note: seedNote,
            occupancyRef: resourceRef(target, 'siampark.occupancy', 'occupancy'),
            peopleCount: null,
            startDate: rentalSeed.startDate,
            state: 'DRAFT',
            unitRef: unit.unitRef,
          },
        },
        snapshot.revision,
        [propertyAudience, propertyAudience, partyAudience, agreementsAudience],
      );
      snapshot = yield* client.read(occupancyAudience, occupancyRead);
      record = yield* uniqueSeedRecord(occupancyLabel, matching(snapshot.occupancies));
    }
    if (record === undefined) {
      return yield* new DemoSeedError({ reason: 'Created occupancy could not be read.' });
    }
    yield* requireSeedMatch(
      occupancyLabel,
      record.kind === 'LONG_TERM_LEASE' &&
        record.customerCounterpartyRef?.resourceId === customer.counterpartyRef.resourceId &&
        ['DRAFT', 'CONFIRMED', 'ACTIVE'].includes(record.state),
    );
    if (record.state === 'DRAFT') {
      yield* client.apply(
        occupancyAudience,
        occupancyCommand,
        { _tag: 'Confirm', occupancyRef: record.occupancyRef },
        snapshot.revision,
        [propertyAudience, propertyAudience, partyAudience, agreementsAudience],
      );
    }
    return record;
  });
const ensureContract = (
  client: SeedClient,
  target: SeedTarget,
  unit: Unit,
  customer: Customer,
  occupancy: Effect.Success<ReturnType<typeof ensureOccupancy>>,
) =>
  Effect.gen(function* contract() {
    let snapshot = yield* client.read(agreementsAudience, agreementsRead);
    const matching = (items: typeof snapshot.contracts) =>
      items.filter(
        (item) =>
          item.occupancyRef?.resourceId === occupancy.occupancyRef.resourceId && item.supersedesContractRef === null,
      );
    let record = yield* uniqueSeedRecord(contractLabel, matching(snapshot.contracts));
    if (record === undefined) {
      yield* client.apply(
        agreementsAudience,
        agreementCommand,
        {
          _tag: 'CreateContract',
          record: {
            contractRef: resourceRef(target, 'siampark.agreements', 'contract'),
            counterpartyRef: customer.counterpartyRef,
            endDate: rentalSeed.endDate,
            kind: 'LEASE',
            lifecycleState: 'DRAFT',
            note: seedNote,
            occupancyRef: occupancy.occupancyRef,
            propertyRef: unit.propertyRef,
            renewalNoticeDate: null,
            signatureState: 'NOT_SENT',
            startDate: rentalSeed.startDate,
            supersedesContractRef: null,
            unitRef: unit.unitRef,
          },
        },
        snapshot.revision,
        [partyAudience, propertyAudience, propertyAudience, occupancyAudience],
      );
      snapshot = yield* client.read(agreementsAudience, agreementsRead);
      record = yield* uniqueSeedRecord(contractLabel, matching(snapshot.contracts));
    }
    if (record === undefined) {
      return yield* new DemoSeedError({ reason: 'Created contract could not be read.' });
    }
    yield* requireSeedMatch(
      contractLabel,
      record.kind === 'LEASE' &&
        record.counterpartyRef.resourceId === customer.counterpartyRef.resourceId &&
        record.unitRef?.resourceId === unit.unitRef.resourceId &&
        record.startDate === rentalSeed.startDate &&
        record.endDate === rentalSeed.endDate &&
        ['DRAFT', 'ACTIVE'].includes(record.lifecycleState),
    );
    return record;
  });
const seedSignature = (
  client: SeedClient,
  target: SeedTarget,
  contract: Effect.Success<ReturnType<typeof ensureContract>>,
) =>
  Effect.gen(function* signature() {
    const snapshot = yield* client.read(agreementsAudience, agreementsRead);
    if (contract.signatureState === 'SIGNED') {
      yield* requireSeedMatch(
        'Demo signature',
        snapshot.documents.some(
          (item) =>
            item.contractRef?.resourceId === contract.contractRef.resourceId &&
            item.signedDocumentReference === 'demo://sales-rental-v1/signed-example' &&
            item.lifecycleState === 'FINAL',
        ),
      );
      return;
    }
    yield* requireSeedMatch('Demo signature', contract.signatureState === 'NOT_SENT');
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* client.apply(
      agreementsAudience,
      agreementCommand,
      {
        _tag: 'RecordSignedDocument',
        contractRef: contract.contractRef,
        document: {
          contractRef: contract.contractRef,
          createdAt: now,
          documentRef: resourceRef(target, 'siampark.agreements', 'document'),
          fileName: 'DEMO-podepsana-smlouva.pdf',
          kind: 'LEASE',
          lifecycleState: 'FINAL',
          signedDocumentReference: 'demo://sales-rental-v1/signed-example',
          title: 'DEMO evidence podpisu, bez skutečného souboru',
          updatedAt: now,
        },
        signedBy: 'DEMO: Ukázkový nájemce Siampark',
        signedOn: '2026-10-05',
      },
      snapshot.revision,
    );
  });
const ensureInvoice = (client: SeedClient, customer: Customer) =>
  Effect.gen(function* invoice() {
    const snapshot = yield* client.read(financeAudience, financeRead);
    const line = {
      description: rentalSeed.line.productName,
      quantity: rentalSeed.line.quantity,
      unitPriceMinor: rentalSeed.line.unitPriceMinor,
      vatRate: rentalSeed.line.vatRate,
    };
    const existing = yield* uniqueSeedRecord(
      'Invoice',
      snapshot.state.invoices.filter(
        (item) =>
          item.documentNumber === rentalSeed.invoiceNumber ||
          (item.partyId === customer.partyRef.resourceId &&
            (item.lines?.some((entry) => entry.description === line.description) ?? false)),
      ),
    );
    if (existing !== undefined) {
      yield* requireSeedMatch(
        'Invoice',
        existing.counterpartyRef.resourceId === customer.counterpartyRef.resourceId &&
          existing.direction === 'OUTGOING' &&
          existing.currency === 'CZK' &&
          isDeepStrictEqual(existing.lines, [line]) &&
          existing.businessState !== 'VOIDED',
      );
      return;
    }
    yield* client.apply(
      financeAudience,
      financeCommand,
      {
        _tag: 'CreateInvoiceDraft',
        counterpartyRef: customer.counterpartyRef,
        currency: 'CZK',
        direction: 'OUTGOING',
        documentNumber: rentalSeed.invoiceNumber,
        dueDate: '2026-11-15',
        issueDate: '2026-11-01',
        lines: [line],
        note: seedNote,
        partyId: customer.partyRef.resourceId,
      },
      snapshot.revision,
      [partyAudience],
    );
  });

export const seedRentalDemo = (
  client: SeedClient,
  target: SeedTarget,
  options: { readonly apply: boolean; readonly checkpointPath: string; readonly demoSignature: boolean },
) =>
  Effect.gen(function* seedRental() {
    // Fail missing owner/read permissions before the first business write.
    yield* client.read(propertyAudience, propertyRead);
    yield* existingSeedCustomer(yield* seedCustomerList(client));
    yield* client.read(occupancyAudience, occupancyRead);
    yield* client.read(agreementsAudience, agreementsRead);
    yield* client.read(pipelineAudience, Opportunities);
    yield* client.read(financeAudience, financeRead);
    if (!options.apply) {
      return { applied: false, demoSignature: options.demoSignature };
    }
    const property = yield* ensureProperty(client);
    const unit = yield* ensureUnit(client, property);
    const customer = yield* ensureSeedCustomer(client, target, options.checkpointPath);
    yield* ensureOpportunity(client, customer);
    const occupancy = yield* ensureOccupancy(client, target, unit, customer);
    const contract = yield* ensureContract(client, target, unit, customer, occupancy);
    if (options.demoSignature) {
      yield* seedSignature(client, target, contract);
    }
    yield* ensureInvoice(client, customer);
    return { applied: true, demoSignature: options.demoSignature };
  });
