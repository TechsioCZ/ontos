import { expect, it } from 'effect-rstest';
import csResource from '../../locales/cs/merchandise.json';
import enResource from '../../locales/en/merchandise.json';
import { DEFAULT_SORT, SORTS, sortSelectItems } from '../../src/routes/[lang]/provoz/produkty/select-items.ts';

type LocaleResource = typeof csResource;

/** The sort labels of a locale; a missing key fails the test instead of falling back to the raw key. */
const sortLabelsOf = (resource: LocaleResource) => {
  const labels: Record<string, string> = resource.merchandise.pages.products.sort;
  return (path: string) => {
    const key = path.slice('sort.'.length);
    if (!Object.hasOwn(labels, key)) {
      throw new TypeError(`Missing sort label: ${key}`);
    }
    return labels[key] ?? '';
  };
};

it('gives every sort option a human label for the hidden native option, in Czech and English', () => {
  for (const resource of [csResource, enResource]) {
    const items = sortSelectItems(sortLabelsOf(resource));
    expect(items.map((item) => item.value)).toEqual([DEFAULT_SORT, ...SORTS]);
    for (const item of items) {
      expect(item.displayValue).toBe(item.label);
      expect(item.displayValue).not.toBe(item.value);
    }
  }
  expect(sortSelectItems(sortLabelsOf(csResource)).length).toBe(SORTS.length + 1);
  expect(sortSelectItems(sortLabelsOf(csResource)).find((item) => item.value === 'name')?.displayValue).toBe(
    'Název A–Z',
  );
  expect(sortSelectItems(sortLabelsOf(enResource)).find((item) => item.value === 'name')?.displayValue).toBe(
    'Name A–Z',
  );
});
