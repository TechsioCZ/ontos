import { selectItem } from '../../../../components/select-item.ts';
import type { ProductSort } from './products-api.ts';

export const ALL_CATEGORIES = '__all__';
export const DEFAULT_SORT = '__default__';
export const SORTS: readonly ProductSort[] = [
  'name',
  'sku',
  'price-asc',
  'price-desc',
  'stock-asc',
  'stock-desc',
  'updated-desc',
];

/** The sort options, the default first. `label` reads a `merchandise.pages.products.*` path, e.g. `sort.name`. */
export const sortSelectItems = (label: (path: string) => string) => [
  selectItem(DEFAULT_SORT, label('sort.default')),
  ...SORTS.map((value) => selectItem(value, label(`sort.${value}`))),
];
