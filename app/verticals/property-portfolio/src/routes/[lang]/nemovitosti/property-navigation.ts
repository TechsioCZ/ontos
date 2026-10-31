import { Schema } from 'effect';

import type { RecordsResponse } from '../../../../shared/apis/records.ts';
import { UnitRefSchema } from '../../../../shared/resources/unit.ts';

const TabSchema = Schema.Literals([
  'units',
  'leases',
  'agreements',
  'documents',
  'tasks',
  'equipment',
  'finance',
  'discussion',
]);
export type PropertyTab = typeof TabSchema.Type;
export interface PropertySearch {
  includeArchived?: true | undefined;
  includeClosed?: true | undefined;
  resourceId?: string | undefined;
  tab?: PropertyTab | undefined;
}
export const PropertySearchInputSchema = Schema.Struct({
  includeArchived: Schema.optional(Schema.Unknown),
  includeClosed: Schema.optional(Schema.Unknown),
  resourceId: Schema.optional(Schema.Unknown),
  tab: Schema.optional(Schema.Unknown),
});
type PropertySearchInput = typeof PropertySearchInputSchema.Type;
const ResourceIdSchema = UnitRefSchema.fields.resourceId.check(Schema.isUUID());

/** Validate fields independently so an old or invalid tab never loses a valid deep link. */
export const readPropertySearch = (input: PropertySearchInput | null): PropertySearch => {
  if (input === null) {
    return {};
  }
  const search: PropertySearch = {};
  if (Schema.is(ResourceIdSchema)(input.resourceId)) {
    search.resourceId = input.resourceId;
  }
  if (Schema.is(TabSchema)(input.tab)) {
    search.tab = input.tab;
  }
  if (input.includeClosed === true) {
    search.includeClosed = true;
  }
  if (input.includeArchived === true) {
    search.includeArchived = true;
  }
  return search;
};

export const propertyTabs = (unitSelected: boolean): readonly PropertyTab[] =>
  unitSelected
    ? ['leases', 'agreements', 'documents', 'tasks', 'equipment', 'discussion']
    : ['units', 'equipment', 'agreements', 'documents', 'tasks', 'finance', 'discussion'];

export const selectedPropertyTab = (
  search: PropertySearch,
  unitSelected: boolean,
  assetSelected: boolean,
): PropertyTab => {
  const tabs = propertyTabs(unitSelected);
  const selected = tabs.find((tab) => tab === search.tab);
  if (selected !== undefined) {
    return selected;
  }
  if (assetSelected) {
    return 'equipment';
  }
  return unitSelected ? 'leases' : 'units';
};

export const selectPropertyResource = (search: PropertySearch, resourceId?: string): PropertySearch => {
  if (resourceId !== undefined) {
    return { ...search, resourceId };
  }
  const next = { ...search };
  delete next.resourceId;
  delete next.tab;
  return next;
};

interface RecordVisibility {
  readonly archived: boolean;
  readonly closed: boolean;
  readonly selected: boolean;
}
export const propertyRecordVisible = (record: RecordVisibility, search: PropertySearch): boolean => {
  if (record.selected) {
    return true;
  }
  if (record.archived) {
    return search.includeArchived === true;
  }
  return !record.closed || search.includeClosed === true;
};

/** Unit and equipment deep links resolve their real parent; missing IDs never select another record. */
export const propertySelection = (records: RecordsResponse | undefined, resourceId: string | undefined) => {
  const property = records?.properties.find((item) => item.propertyRef.resourceId === resourceId);
  const unit = records?.units.find((item) => item.unitRef.resourceId === resourceId);
  const asset = records?.assets.find((item) => item.assetRef.resourceId === resourceId);
  const propertyRef = property?.propertyRef ?? unit?.propertyRef ?? asset?.propertyRef;
  return {
    assetId: asset?.assetRef.resourceId ?? '',
    propertyId:
      records?.properties.find(
        (item) =>
          item.propertyRef.resourceId === propertyRef?.resourceId && item.propertyRef.tenantId === propertyRef.tenantId,
      )?.propertyRef.resourceId ?? '',
    unitId:
      unit?.unitRef.resourceId ??
      records?.units.find(
        (item) =>
          item.unitRef.resourceId === asset?.unitRef?.resourceId && item.unitRef.tenantId === asset?.unitRef?.tenantId,
      )?.unitRef.resourceId ??
      '',
  };
};
