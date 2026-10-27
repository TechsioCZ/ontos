import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { RecordsResponseSchema } from '../../shared/apis/records.ts';
import {
  propertySelection,
  propertyRecordVisible,
  propertyTabs,
  readPropertySearch,
  selectedPropertyTab,
  selectPropertyResource,
} from '../../src/routes/[lang]/nemovitosti/property-navigation.ts';

it('reveals archived records independently of the closed-record filter and preserves explicit deep links', () => {
  expect(propertyRecordVisible({ archived: true, closed: true, selected: false }, {})).toBe(false);
  expect(propertyRecordVisible({ archived: true, closed: true, selected: false }, { includeArchived: true })).toBe(
    true,
  );
  expect(propertyRecordVisible({ archived: false, closed: true, selected: false }, {})).toBe(false);
  expect(propertyRecordVisible({ archived: false, closed: true, selected: false }, { includeClosed: true })).toBe(true);
  expect(propertyRecordVisible({ archived: true, closed: true, selected: true }, {})).toBe(true);
});

const resourceId = '76000000-0000-4000-8000-000000000001';

it('keeps a valid resource selection when an old tab or another query field is invalid', () => {
  expect(readPropertySearch({ includeArchived: 'yes', resourceId, tab: 'old-tab' })).toEqual({ resourceId });
  expect(readPropertySearch({ resourceId: 'not-a-resource', tab: 'agreements' })).toEqual({ tab: 'agreements' });
  expect(readPropertySearch(null)).toEqual({});
});

it('restores the selected tab and filters from a parsed URL', () => {
  const search = readPropertySearch({ includeArchived: true, includeClosed: true, resourceId, tab: 'agreements' });
  expect(search).toEqual({ includeArchived: true, includeClosed: true, resourceId, tab: 'agreements' });
  expect(selectedPropertyTab(search, true, false)).toBe('agreements');
  expect(selectedPropertyTab(search, false, false)).toBe('agreements');
});

it('uses only tabs applicable to the selected record, including equipment deep links', () => {
  expect(selectedPropertyTab({ resourceId, tab: 'units' }, true, false)).toBe('leases');
  expect(selectedPropertyTab({ resourceId, tab: 'leases' }, false, false)).toBe('units');
  expect(selectedPropertyTab({ resourceId }, true, true)).toBe('equipment');
  expect(propertyTabs(false)).toContain('finance');
  expect(propertyTabs(true)).not.toContain('finance');
});

it('preserves the tab between units but returns to the portfolio without a stale detail tab', () => {
  const search = readPropertySearch({ includeClosed: true, resourceId, tab: 'documents' });
  const nextId = '76000000-0000-4000-8000-000000000002';
  expect(selectPropertyResource(search, nextId)).toEqual({
    includeClosed: true,
    resourceId: nextId,
    tab: 'documents',
  });
  expect(selectPropertyResource(search)).toEqual({ includeClosed: true });
});

const navigationTenantId = '70000000-0000-4000-8000-000000000020';
const otherNavigationTenantId = '70000000-0000-4000-8000-000000000021';
const navigationResourceId = (index: number) => `76000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const navigationRef = (kind: 'property' | 'unit' | 'asset', index: number, tenantId = navigationTenantId) => ({
  moduleId: 'property.portfolio',
  resourceId: navigationResourceId(index),
  resourceType: `property.portfolio.${kind}`,
  tenantId,
});
const navigationProperty = (index: number, tenantId = navigationTenantId) => ({
  address: `${index} Garden Street`,
  code: `PROPERTY-${index}`,
  createdAt: '2026-10-01T09:00:00.000Z',
  legalEntityRef: {
    moduleId: 'core.identity',
    resourceId: navigationResourceId(90),
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
  lifecycleState: 'ACTIVE',
  name: `Garden property ${index}`,
  note: null,
  propertyRef: navigationRef('property', index, tenantId),
  updatedAt: '2026-10-02T09:00:00.000Z',
});
const navigationUnit = (index: number, propertyIndex: number, tenantId = navigationTenantId) => ({
  capacity: 2,
  code: `UNIT-${index}`,
  lifecycleState: 'ACTIVE',
  name: `Garden unit ${index}`,
  note: null,
  propertyRef: navigationRef('property', propertyIndex, tenantId),
  unitKind: 'Apartment',
  unitRef: navigationRef('unit', index, tenantId),
});
const navigationAsset = (index: number, propertyIndex: number) => ({
  acquiredAt: '2026-10-01',
  assetRef: navigationRef('asset', index),
  category: 'Equipment',
  code: `ASSET-${index}`,
  lastServiceAt: null,
  lifecycleState: 'ACTIVE',
  name: `Garden equipment ${index}`,
  nextServiceAt: null,
  propertyRef: navigationRef('property', propertyIndex),
  serialNumber: null,
  unitRef: null,
});
const navigationFixture = {
  assets: [navigationAsset(5, 2), navigationAsset(6, 1)],
  properties: [navigationProperty(2), navigationProperty(1)],
  revision: 3,
  units: [navigationUnit(4, 2), navigationUnit(3, 1)],
};
const decodeNavigationRecords = Schema.decodeUnknownSync(RecordsResponseSchema);

it('resolves a property deep link without selecting a unit or equipment from another property', () => {
  const records = decodeNavigationRecords(navigationFixture);
  expect(propertySelection(records, navigationResourceId(1))).toEqual({
    assetId: '',
    propertyId: navigationResourceId(1),
    unitId: '',
  });
});

it('resolves a unit deep link to its actual property rather than the first property', () => {
  const records = decodeNavigationRecords(navigationFixture);
  expect(propertySelection(records, navigationResourceId(3))).toEqual({
    assetId: '',
    propertyId: navigationResourceId(1),
    unitId: navigationResourceId(3),
  });
});

it('resolves property equipment without inventing a unit selection', () => {
  const records = decodeNavigationRecords(navigationFixture);
  expect(propertySelection(records, navigationResourceId(6))).toEqual({
    assetId: navigationResourceId(6),
    propertyId: navigationResourceId(1),
    unitId: '',
  });
});

it('inherits the owning unit selection for equipment assigned to that unit', () => {
  const records = decodeNavigationRecords({
    ...navigationFixture,
    assets: [...navigationFixture.assets, { ...navigationAsset(7, 1), unitRef: navigationRef('unit', 3) }],
  });
  expect(propertySelection(records, navigationResourceId(7))).toEqual({
    assetId: navigationResourceId(7),
    propertyId: navigationResourceId(1),
    unitId: navigationResourceId(3),
  });
});

it('keeps unknown and absent resource IDs unselected even when other records are available', () => {
  const records = decodeNavigationRecords(navigationFixture);
  const unselected = { assetId: '', propertyId: '', unitId: '' };
  expect(propertySelection(records, navigationResourceId(99))).toEqual(unselected);
  expect(propertySelection(records, readPropertySearch({}).resourceId)).toEqual(unselected);
  expect(propertySelection(undefined, navigationResourceId(1))).toEqual(unselected);
  expect(
    propertySelection(decodeNavigationRecords({ assets: [], properties: [], revision: 0, units: [] }), resourceId),
  ).toEqual(unselected);
});

it('does not fall back to an unrelated property when a selected unit or equipment has a missing parent', () => {
  const records = decodeNavigationRecords({
    ...navigationFixture,
    assets: [{ ...navigationAsset(7, 99), unitRef: navigationRef('unit', 98) }],
    units: [navigationUnit(3, 99)],
  });
  expect(propertySelection(records, navigationResourceId(3))).toEqual({
    assetId: '',
    propertyId: '',
    unitId: navigationResourceId(3),
  });
  expect(propertySelection(records, navigationResourceId(7))).toEqual({
    assetId: navigationResourceId(7),
    propertyId: '',
    unitId: '',
  });
});

it('keeps explicitly selected archived properties and units resolvable', () => {
  const archive = {
    archivedAt: '2026-10-03T09:00:00.000Z',
    archivedBy: 'Portfolio manager',
    reason: 'Retained for history',
  };
  const records = decodeNavigationRecords({
    ...navigationFixture,
    properties: [navigationProperty(2), { ...navigationProperty(1), archive }],
    units: [navigationUnit(4, 2), { ...navigationUnit(3, 1), archive }],
  });
  expect(propertySelection(records, navigationResourceId(1))).toEqual({
    assetId: '',
    propertyId: navigationResourceId(1),
    unitId: '',
  });
  expect(propertySelection(records, navigationResourceId(3))).toEqual({
    assetId: '',
    propertyId: navigationResourceId(1),
    unitId: navigationResourceId(3),
  });
});

it('does not resolve a parent property with the same ID in another tenant', () => {
  const records = decodeNavigationRecords({
    ...navigationFixture,
    properties: [navigationProperty(1, otherNavigationTenantId), navigationProperty(2)],
  });
  expect(propertySelection(records, navigationResourceId(3))).toEqual({
    assetId: '',
    propertyId: '',
    unitId: navigationResourceId(3),
  });
  expect(propertySelection(records, navigationResourceId(6))).toEqual({
    assetId: navigationResourceId(6),
    propertyId: '',
    unitId: '',
  });
});

it('does not inherit an equipment unit with the same ID in another tenant', () => {
  const records = decodeNavigationRecords({
    ...navigationFixture,
    assets: [{ ...navigationAsset(7, 1), unitRef: navigationRef('unit', 3) }],
    units: [navigationUnit(3, 1, otherNavigationTenantId), navigationUnit(4, 2)],
  });
  expect(propertySelection(records, navigationResourceId(7))).toEqual({
    assetId: navigationResourceId(7),
    propertyId: navigationResourceId(1),
    unitId: '',
  });
});

it('resolves an equipment unit and parent only when their tenant references match', () => {
  const records = decodeNavigationRecords({
    ...navigationFixture,
    assets: [{ ...navigationAsset(7, 1), unitRef: navigationRef('unit', 3) }],
    properties: [navigationProperty(1, otherNavigationTenantId), ...navigationFixture.properties],
    units: [navigationUnit(3, 1, otherNavigationTenantId), ...navigationFixture.units],
  });
  expect(propertySelection(records, navigationResourceId(7))).toEqual({
    assetId: navigationResourceId(7),
    propertyId: navigationResourceId(1),
    unitId: navigationResourceId(3),
  });
});
