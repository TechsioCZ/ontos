import type { RecordsResponse as Agreements } from '@app/legal-agreements/contracts/records';
import type { RecordsResponse as Occupancies } from '@app/property-leasing/contracts/records';
import type { RecordsResponse as Work } from '@app/work-tasks/contracts/records';
import type { RecordsResponse } from '../../../../shared/apis/records';

export interface RelatedSources {
  readonly agreements?:
    | {
        readonly contracts: readonly Pick<
          Agreements['contracts'][number],
          'contractRef' | 'endDate' | 'lifecycleState' | 'propertyRef' | 'startDate' | 'unitRef'
        >[];
        readonly documents: readonly Pick<
          Agreements['documents'][number],
          'contractRef' | 'documentRef' | 'fileName' | 'signedDocumentReference' | 'title'
        >[];
      }
    | undefined;
  readonly assets: readonly (Pick<RecordsResponse['assets'][number], 'assetRef'> &
    Partial<Pick<RecordsResponse['assets'][number], 'unitRef'>>)[];
  readonly occupancy?:
    | {
        readonly occupancies: readonly Pick<
          Occupancies['occupancies'][number],
          'endDate' | 'occupancyRef' | 'startDate' | 'state' | 'unitRef'
        >[];
      }
    | undefined;
  readonly property?: Pick<RecordsResponse['properties'][number], 'propertyRef'> | undefined;
  readonly unit?: Pick<RecordsResponse['units'][number], 'unitRef'> | undefined;
  readonly units: readonly Pick<RecordsResponse['units'][number], 'unitRef'>[];
  readonly work?:
    | { readonly items: readonly Pick<Work['items'][number], 'contextRefs' | 'ref' | 'title'>[] }
    | undefined;
}

export const projectPropertyRelatedRecords = ({
  agreements,
  assets,
  occupancy,
  property,
  unit,
  units,
  work,
}: RelatedSources) => {
  const relatedUnits = unit === undefined ? units : [unit];
  const activeOccupancies =
    occupancy?.occupancies.filter(
      (item) =>
        item.state === 'ACTIVE' &&
        relatedUnits.some(
          (record) =>
            record.unitRef.tenantId === item.unitRef.tenantId &&
            record.unitRef.moduleId === item.unitRef.moduleId &&
            record.unitRef.resourceType === item.unitRef.resourceType &&
            record.unitRef.resourceId === item.unitRef.resourceId,
        ),
    ) ?? [];
  const propertyContracts =
    agreements?.contracts.filter((item) => {
      const matchesUnit = relatedUnits.some(
        (record) =>
          record.unitRef.tenantId === item.unitRef?.tenantId &&
          record.unitRef.moduleId === item.unitRef.moduleId &&
          record.unitRef.resourceType === item.unitRef.resourceType &&
          record.unitRef.resourceId === item.unitRef.resourceId,
      );
      return unit === undefined
        ? property !== undefined &&
            ((item.propertyRef?.tenantId === property.propertyRef.tenantId &&
              item.propertyRef.moduleId === property.propertyRef.moduleId &&
              item.propertyRef.resourceType === property.propertyRef.resourceType &&
              item.propertyRef.resourceId === property.propertyRef.resourceId) ||
              (item.propertyRef === null && matchesUnit))
        : matchesUnit;
    }) ?? [];
  const propertyDocuments =
    agreements?.documents.filter((item) =>
      propertyContracts.some(
        (record) =>
          record.contractRef.tenantId === item.contractRef?.tenantId &&
          record.contractRef.moduleId === item.contractRef.moduleId &&
          record.contractRef.resourceType === item.contractRef.resourceType &&
          record.contractRef.resourceId === item.contractRef.resourceId,
      ),
    ) ?? [];
  const taskReferences = [
    ...(unit === undefined && property !== undefined ? [property.propertyRef] : []),
    ...relatedUnits.map((record) => record.unitRef),
    ...assets.flatMap((record) =>
      unit === undefined ||
      (record.unitRef?.tenantId === unit.unitRef.tenantId &&
        record.unitRef.moduleId === unit.unitRef.moduleId &&
        record.unitRef.resourceType === unit.unitRef.resourceType &&
        record.unitRef.resourceId === unit.unitRef.resourceId)
        ? [record.assetRef]
        : [],
    ),
  ];
  const propertyTasks =
    work?.items.filter((item) =>
      item.contextRefs.some((reference) =>
        taskReferences.some(
          (owned) =>
            reference.tenantId === owned.tenantId &&
            reference.moduleId === owned.moduleId &&
            reference.resourceType === owned.resourceType &&
            reference.resourceId === owned.resourceId,
        ),
      ),
    ) ?? [];
  return { activeOccupancies, propertyContracts, propertyDocuments, propertyTasks };
};
