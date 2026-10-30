import { ContractSchema, DocumentSchema } from '@app/legal-agreements/contracts/records';
import { OccupancySchema } from '@app/property-leasing/contracts/records';
import { TaskSchema } from '@app/work-tasks/contracts/records';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { AssetRecordSchema } from '../../shared/apis/records.ts';
import { AssetRefSchema } from '../../shared/resources/asset.ts';
import { PropertyRefSchema } from '../../shared/resources/property.ts';
import { UnitRefSchema } from '../../shared/resources/unit.ts';
import { projectPropertyRelatedRecords } from '../../src/routes/[lang]/nemovitosti/property-relations.ts';

const tenantId = '70000000-0000-4000-8000-000000000020';
const otherTenantId = '70000000-0000-4000-8000-000000000021';
const ref = (owner: string, resource: string, index: number, tenant = tenantId) => ({
  moduleId: owner,
  resourceId: `76000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  resourceType: `${owner}.${resource}`,
  tenantId: tenant,
});
const propertyRef = ref('property.portfolio', 'property', 1);
const otherPropertyRef = ref('property.portfolio', 'property', 2);
const unitRef = ref('property.portfolio', 'unit', 3);
const neighboringUnitRef = ref('property.portfolio', 'unit', 5);
const assetRef = ref('property.portfolio', 'asset', 4);
const SourceSchema = Schema.Struct({
  agreements: Schema.Struct({
    contracts: Schema.Array(
      Schema.Struct({
        contractRef: ContractSchema.fields.contractRef,
        endDate: ContractSchema.fields.endDate,
        lifecycleState: ContractSchema.fields.lifecycleState,
        propertyRef: ContractSchema.fields.propertyRef,
        startDate: ContractSchema.fields.startDate,
        unitRef: ContractSchema.fields.unitRef,
      }),
    ),
    documents: Schema.Array(
      Schema.Struct({
        contractRef: DocumentSchema.fields.contractRef,
        documentRef: DocumentSchema.fields.documentRef,
        fileName: DocumentSchema.fields.fileName,
        signedDocumentReference: DocumentSchema.fields.signedDocumentReference,
        title: DocumentSchema.fields.title,
      }),
    ),
  }),
  assets: Schema.Array(
    Schema.Struct({
      assetRef: AssetRefSchema,
      unitRef: Schema.optionalKey(AssetRecordSchema.fields.unitRef),
    }),
  ),
  occupancy: Schema.Struct({
    occupancies: Schema.Array(
      Schema.Struct({
        endDate: OccupancySchema.fields.endDate,
        occupancyRef: OccupancySchema.fields.occupancyRef,
        startDate: OccupancySchema.fields.startDate,
        state: OccupancySchema.fields.state,
        unitRef: OccupancySchema.fields.unitRef,
      }),
    ),
  }),
  property: Schema.Struct({ propertyRef: PropertyRefSchema }),
  unit: Schema.optionalKey(Schema.Struct({ unitRef: UnitRefSchema })),
  units: Schema.Array(Schema.Struct({ unitRef: UnitRefSchema })),
  work: Schema.Struct({
    items: Schema.Array(
      Schema.Struct({
        contextRefs: TaskSchema.fields.contextRefs,
        ref: TaskSchema.fields.ref,
        title: TaskSchema.fields.title,
      }),
    ),
  }),
});
const contract = (index: number) => ({
  contractRef: ref('legal.agreements', 'contract', index),
  endDate: '2027-10-05',
  lifecycleState: 'ACTIVE',
  propertyRef,
  startDate: '2026-10-05',
  unitRef,
});
const occupancy = (index: number) => ({
  endDate: '2027-10-05',
  occupancyRef: ref('property.leasing', 'occupancy', index),
  startDate: '2026-10-05',
  state: 'ACTIVE',
  unitRef,
});
const document = (index: number, contractIndex: number) => ({
  contractRef: ref('legal.agreements', 'contract', contractIndex),
  documentRef: ref('legal.agreements', 'document', index),
  fileName: 'lease.pdf',
  signedDocumentReference: 'SIMULATED:signature',
  title: 'Signed lease',
});

it.effect(
  'links only the selected property owners, excluding other properties and colliding cross-tenant identifiers',
  () =>
    Effect.gen(function* propertyReferencesRemainScoped() {
      const sources = yield* Schema.decodeUnknownEffect(SourceSchema)({
        agreements: {
          contracts: [
            contract(10),
            { ...contract(11), propertyRef: otherPropertyRef },
            { ...contract(12), propertyRef: { ...propertyRef, tenantId: otherTenantId } },
          ],
          documents: [
            document(20, 10),
            document(21, 11),
            { ...document(22, 10), contractRef: ref('legal.agreements', 'contract', 10, otherTenantId) },
          ],
        },
        assets: [{ assetRef }],
        occupancy: {
          occupancies: [
            occupancy(30),
            { ...occupancy(31), state: 'CONFIRMED' },
            { ...occupancy(32), unitRef: { ...unitRef, tenantId: otherTenantId } },
          ],
        },
        property: { propertyRef },
        units: [{ unitRef }],
        work: {
          items: [
            { contextRefs: [assetRef], ref: ref('work.tasks', 'task', 40), title: 'Service' },
            { contextRefs: [otherPropertyRef], ref: ref('work.tasks', 'task', 41), title: 'Other property' },
            {
              contextRefs: [{ ...assetRef, tenantId: otherTenantId }],
              ref: ref('work.tasks', 'task', 42),
              title: 'Other tenant',
            },
          ],
        },
      });
      const result = projectPropertyRelatedRecords(sources);
      expect(result.activeOccupancies.map((item) => item.occupancyRef.resourceId)).toEqual([
        occupancy(30).occupancyRef.resourceId,
      ]);
      expect(result.propertyContracts.map((item) => item.contractRef.resourceId)).toEqual([
        contract(10).contractRef.resourceId,
      ]);
      expect(result.propertyDocuments.map((item) => item.documentRef.resourceId)).toEqual([
        document(20, 10).documentRef.resourceId,
      ]);
      expect(result.propertyTasks.map((item) => item.title)).toEqual(['Service']);
    }),
);

it.effect('keeps unavailable owner reads absent rather than inventing related records', () =>
  Effect.gen(function* unavailableSourcesDoNotProduceData() {
    const property = yield* Schema.decodeUnknownEffect(PropertyRefSchema)(propertyRef);
    expect(projectPropertyRelatedRecords({ assets: [], property: { propertyRef: property }, units: [] })).toEqual({
      activeOccupancies: [],
      propertyContracts: [],
      propertyDocuments: [],
      propertyTasks: [],
    });
  }),
);

it.effect('preserves property-wide unit fallback, contract history and all owned task contexts', () =>
  Effect.gen(function* propertyProjectionKeepsExistingBehavior() {
    const sources = yield* Schema.decodeUnknownEffect(SourceSchema)({
      agreements: {
        contracts: [
          { ...contract(10), unitRef: null },
          { ...contract(11), propertyRef: null, unitRef: neighboringUnitRef },
          { ...contract(12), lifecycleState: 'EXPIRED' },
          { ...contract(13), propertyRef: otherPropertyRef },
          { ...contract(14), propertyRef: null, unitRef: null },
          { ...contract(15), propertyRef: null, unitRef: { ...unitRef, tenantId: otherTenantId } },
        ],
        documents: [document(20, 10), document(21, 11), document(22, 12), document(23, 13)],
      },
      assets: [{ assetRef }],
      occupancy: {
        occupancies: [
          { ...occupancy(30), endDate: '2025-10-05', startDate: '2024-10-05' },
          { ...occupancy(31), unitRef: neighboringUnitRef },
          { ...occupancy(32), state: 'COMPLETED' },
          { ...occupancy(33), state: 'CANCELLED' },
        ],
      },
      property: { propertyRef },
      units: [{ unitRef }, { unitRef: neighboringUnitRef }],
      work: {
        items: [
          { contextRefs: [propertyRef], ref: ref('work.tasks', 'task', 40), title: 'Property' },
          { contextRefs: [neighboringUnitRef], ref: ref('work.tasks', 'task', 41), title: 'Neighboring unit' },
          { contextRefs: [assetRef], ref: ref('work.tasks', 'task', 42), title: 'Asset without unit metadata' },
        ],
      },
    });
    const result = projectPropertyRelatedRecords(sources);
    expect(result.activeOccupancies).toEqual(sources.occupancy.occupancies.slice(0, 2));
    expect(result.propertyContracts).toEqual(sources.agreements.contracts.slice(0, 3));
    expect(result.propertyDocuments).toEqual(sources.agreements.documents.slice(0, 3));
    expect(result.propertyTasks).toEqual(sources.work.items);
    expect(
      projectPropertyRelatedRecords({
        agreements: sources.agreements,
        assets: sources.assets,
        occupancy: sources.occupancy,
        units: sources.units,
        work: sources.work,
      }).propertyContracts,
    ).toEqual([]);
  }),
);

it.effect('scopes occupancy and contracts to the exact selected unit and documents to those contracts', () =>
  Effect.gen(function* unitProjectionExcludesNeighboringAndPropertyOnlyRecords() {
    const sources = yield* Schema.decodeUnknownEffect(SourceSchema)({
      agreements: {
        contracts: [
          contract(10),
          { ...contract(11), propertyRef: null },
          { ...contract(12), unitRef: neighboringUnitRef },
          { ...contract(13), unitRef: null },
          { ...contract(14), unitRef: { ...unitRef, tenantId: otherTenantId } },
          { ...contract(15), lifecycleState: 'TERMINATED' },
        ],
        documents: [
          document(20, 10),
          document(21, 11),
          document(22, 12),
          document(23, 13),
          document(24, 14),
          document(25, 15),
          { ...document(26, 10), contractRef: ref('legal.agreements', 'contract', 10, otherTenantId) },
          { ...document(27, 10), contractRef: null },
          document(28, 99),
        ],
      },
      assets: [],
      occupancy: {
        occupancies: [
          occupancy(30),
          { ...occupancy(31), unitRef: neighboringUnitRef },
          { ...occupancy(32), unitRef: { ...unitRef, tenantId: otherTenantId } },
          { ...occupancy(33), state: 'CONFIRMED' },
          { ...occupancy(34), state: 'COMPLETED' },
          { ...occupancy(35), state: 'CANCELLED' },
          { ...occupancy(36), state: 'DRAFT' },
        ],
      },
      property: { propertyRef },
      unit: { unitRef },
      units: [{ unitRef }, { unitRef: neighboringUnitRef }],
      work: { items: [] },
    });
    const result = projectPropertyRelatedRecords(sources);
    expect(result.activeOccupancies).toEqual(sources.occupancy.occupancies.slice(0, 1));
    expect(result.propertyContracts).toEqual([
      sources.agreements.contracts[0],
      sources.agreements.contracts[1],
      sources.agreements.contracts[5],
    ]);
    expect(result.propertyDocuments).toEqual([
      sources.agreements.documents[0],
      sources.agreements.documents[1],
      sources.agreements.documents[5],
    ]);
  }),
);

it.effect('matches unit tasks only through that unit or assets with that exact unit reference', () =>
  Effect.gen(function* unitTaskContextsRequireFullReferenceIdentity() {
    const sources = yield* Schema.decodeUnknownEffect(SourceSchema)({
      agreements: { contracts: [], documents: [] },
      assets: [
        { assetRef, unitRef },
        { assetRef: ref('property.portfolio', 'asset', 6), unitRef: neighboringUnitRef },
        { assetRef: ref('property.portfolio', 'asset', 7), unitRef: null },
        { assetRef: ref('property.portfolio', 'asset', 8) },
        {
          assetRef: ref('property.portfolio', 'asset', 9),
          unitRef: { ...unitRef, tenantId: otherTenantId },
        },
      ],
      occupancy: { occupancies: [] },
      property: { propertyRef },
      unit: { unitRef },
      units: [{ unitRef }, { unitRef: neighboringUnitRef }],
      work: {
        items: [
          { contextRefs: [unitRef], ref: ref('work.tasks', 'task', 40), title: 'Selected unit' },
          { contextRefs: [assetRef], ref: ref('work.tasks', 'task', 41), title: 'Selected unit asset' },
          {
            contextRefs: [propertyRef, unitRef, assetRef],
            ref: ref('work.tasks', 'task', 42),
            title: 'Multiple matching contexts',
          },
          { contextRefs: [propertyRef], ref: ref('work.tasks', 'task', 43), title: 'Property only' },
          { contextRefs: [neighboringUnitRef], ref: ref('work.tasks', 'task', 44), title: 'Neighboring unit' },
          {
            contextRefs: [ref('property.portfolio', 'asset', 6)],
            ref: ref('work.tasks', 'task', 45),
            title: 'Neighboring asset',
          },
          {
            contextRefs: [ref('property.portfolio', 'asset', 7), ref('property.portfolio', 'asset', 8)],
            ref: ref('work.tasks', 'task', 46),
            title: 'Assets without unit assignment',
          },
          {
            contextRefs: [ref('property.portfolio', 'asset', 9)],
            ref: ref('work.tasks', 'task', 47),
            title: 'Asset assigned to colliding cross-tenant unit',
          },
          {
            contextRefs: [
              { ...unitRef, tenantId: otherTenantId },
              { ...assetRef, tenantId: otherTenantId },
            ],
            ref: ref('work.tasks', 'task', 48),
            title: 'Colliding cross-tenant task contexts',
          },
          {
            contextRefs: [ref('property.portfolio', 'property', 3), ref('property.portfolio', 'unit', 4)],
            ref: ref('work.tasks', 'task', 49),
            title: 'Colliding resource types',
          },
          {
            contextRefs: [ref('legal.agreements', 'contract', 3), ref('legal.agreements', 'contract', 4)],
            ref: ref('work.tasks', 'task', 50),
            title: 'Colliding owner module',
          },
        ],
      },
    });
    const result = projectPropertyRelatedRecords(sources);
    expect(result.propertyTasks).toEqual(sources.work.items.slice(0, 3));
    expect(result.propertyTasks[0]).toBe(sources.work.items[0]);
  }),
);

it.effect('uses the selected unit without property-wide lists and never synthesizes missing owner records', () =>
  Effect.gen(function* unitProjectionUsesOnlyAvailableOwnerRecords() {
    const sources = yield* Schema.decodeUnknownEffect(SourceSchema)({
      agreements: { contracts: [{ ...contract(10), propertyRef: null }], documents: [document(20, 10)] },
      assets: [],
      occupancy: { occupancies: [occupancy(30)] },
      property: { propertyRef },
      unit: { unitRef },
      units: [],
      work: {
        items: [{ contextRefs: [unitRef], ref: ref('work.tasks', 'task', 40), title: 'Selected unit' }],
      },
    });
    expect(
      projectPropertyRelatedRecords({
        agreements: sources.agreements,
        assets: sources.assets,
        occupancy: sources.occupancy,
        unit: sources.unit,
        units: sources.units,
        work: sources.work,
      }),
    ).toEqual({
      activeOccupancies: sources.occupancy.occupancies,
      propertyContracts: sources.agreements.contracts,
      propertyDocuments: sources.agreements.documents,
      propertyTasks: sources.work.items,
    });
    expect(
      projectPropertyRelatedRecords({
        assets: sources.assets,
        property: sources.property,
        unit: sources.unit,
        units: sources.units,
      }),
    ).toEqual({
      activeOccupancies: [],
      propertyContracts: [],
      propertyDocuments: [],
      propertyTasks: [],
    });
    expect(
      projectPropertyRelatedRecords({
        ...sources,
        agreements: { ...sources.agreements, contracts: [] },
      }).propertyDocuments,
    ).toEqual([]);
  }),
);
