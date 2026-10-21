import { readFileSync } from 'node:fs';
import { demoId } from '../../../scripts/demo/fixture-ids.mts';
import { buildAkrosEncodedFrom } from './akros-baseline.ts';
import type { AkrosEncodedState, AkrosSource } from './akros-baseline.ts';

const source: AkrosSource = {
  catalog: JSON.parse(
    readFileSync(
      new URL('../../../akros-storefront/src/mock-storefront/generated/catalog.generated.json', import.meta.url),
      'utf8',
    ),
  ) as AkrosSource['catalog'],
  categories: (
    JSON.parse(
      readFileSync(
        new URL('../../../akros-storefront/src/mock-storefront/generated/categories.generated.json', import.meta.url),
        'utf8',
      ),
    ) as { categories: AkrosSource['categories'] }
  ).categories,
};
// Import every source group; never silently curate the live owner catalog.
export const akrosSourceProducts = source.catalog.products;
export const buildAkrosEncoded = (): AkrosEncodedState => buildAkrosEncodedFrom(source, demoId);
