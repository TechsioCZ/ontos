import { ContractSchema, DocumentSchema } from '@app/legal-agreements/contracts/records';
import { OccupancySchema } from '@app/property-leasing/contracts/records';
import { TaskSchema } from '@app/work-tasks/contracts/records';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { AssetRefSchema } from '../../shared/resources/asset.ts';
import { PropertyRefSchema } from '../../shared/resources/property.ts';
import { UnitRefSchema } from '../../shared/resources/unit.ts';
import { projectPropertyRelatedRecords } from '../../src/routes/[lang]/nemovitosti/page.tsx';

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
  assets: Schema.Array(Schema.Struct({ assetRef: AssetRefSchema })),
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
