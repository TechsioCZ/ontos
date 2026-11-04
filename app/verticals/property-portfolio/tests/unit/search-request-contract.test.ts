import { CoreSearchQueryTextSchema } from '@app/core-runtime/search-contract';
import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { AssetsProviderRequestSchema } from '../../shared/apis/assets-search.ts';
import { PropertiesProviderRequestSchema } from '../../shared/apis/properties-search.ts';
import { UnitsProviderRequestSchema } from '../../shared/apis/units-search.ts';

for (const [name, schema] of [
  ['assets', AssetsProviderRequestSchema],
  ['properties', PropertiesProviderRequestSchema],
  ['units', UnitsProviderRequestSchema],
] as const) {
  describe(`${name} public search request`, () => {
    it('uses the shared query contract and accepts the inclusive 1–200 boundary without truncation', () => {
      expect(schema.fields.query).toBe(CoreSearchQueryTextSchema);
      for (const query of ['š', 'Český šroub', 'x'.repeat(200)]) {
        expect(Schema.decodeUnknownSync(schema)({ query: `  ${query}  ` })).toEqual({ query });
      }
    });

    it('rejects malformed, overlong and normalized-empty queries at ingress', () => {
      for (const query of [
        undefined,
        null,
        1,
        {},
        [],
        '',
        ' \t\n ',
        '\u0301',
        '\u00A8',
        ' \u0301 \uFE0F ',
        'x'.repeat(201),
        'x'.repeat(300),
      ]) {
        expect(Result.isFailure(Schema.decodeUnknownResult(schema)({ query }))).toBe(true);
      }
    });
  });
}
