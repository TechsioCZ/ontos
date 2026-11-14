import { Option } from 'effect';
import { expect, it } from 'effect-rstest';
import { decodeRecordsSearch } from '../../shared/domain/records-search.ts';

const leaseId = '0f8b7f52-3c55-4c8e-9a4e-5c2b8a1d7e10';

it('decodes the query the Shell passes to the leasing page and its preload', () => {
  expect(decodeRecordsSearch('')).toStrictEqual(Option.some({}));
  expect(decodeRecordsSearch(`?resourceId=${leaseId}&tab=ignored`)).toStrictEqual(Option.some({ resourceId: leaseId }));
  expect(decodeRecordsSearch(`?create=lease&unitId=${leaseId}`)).toStrictEqual(
    Option.some({ create: 'lease', unitId: leaseId }),
  );
});

it('decodes an opened counterparty', () => {
  expect(decodeRecordsSearch(`?counterpartyId=${leaseId}`)).toStrictEqual(Option.some({ counterpartyId: leaseId }));
});

it('decodes every supported field without a leading question mark and ignores unrelated parameters', () => {
  expect(
    decodeRecordsSearch(`counterpartyId=${leaseId}&create=lease&resourceId=${leaseId}&unitId=${leaseId}&tab=ignored`),
  ).toStrictEqual(Option.some({ counterpartyId: leaseId, create: 'lease', resourceId: leaseId, unitId: leaseId }));
});

it('rejects a query whose record reference is not a resource id', () => {
  expect(Option.isNone(decodeRecordsSearch('?resourceId=not-a-uuid'))).toBe(true);
  expect(Option.isNone(decodeRecordsSearch('?counterpartyId=not-a-uuid'))).toBe(true);
  expect(Option.isNone(decodeRecordsSearch('?create=lease&unitId=not-a-uuid'))).toBe(true);
  expect(Option.isNone(decodeRecordsSearch('?create=stay'))).toBe(true);
});
