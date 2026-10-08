import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { OccurrenceSupplyMeaningsSchema, mapTaxableSupplyUnits } from '../../src/domain/taxable-supply-unit.ts';
import { catalogSelectionInput, occurrenceInput } from './tax-domain-fixtures.ts';

const decodeMeanings = Schema.decodeUnknownSync(OccurrenceSupplyMeaningsSchema);
const setComposition = { revision: 3, setCompositionId: 'set-composition-1' };

describe('Taxable Supply Unit mapping', () => {
  it('#920 F12 F17 maps one ordinary occurrence to one traceable Taxable Supply Unit', () => {
    const mapped = mapTaxableSupplyUnits(decodeMeanings([{ _tag: 'ORDINARY', occurrence: occurrenceInput('o-1') }]));

    expect(mapped).toEqual(
      Result.succeed([
        {
          mapping: { _tag: 'ORDINARY_OCCURRENCE', catalogSelection: catalogSelectionInput(), occurrenceId: 'o-1' },
          unitId: 'taxable-supply-unit:o-1',
        },
      ]),
    );
  });

  it('#920 F13-F16 #936 F10 keeps two equal occurrences as two distinct units', () => {
    const mapped = mapTaxableSupplyUnits(
      decodeMeanings([
        { _tag: 'ORDINARY', occurrence: occurrenceInput('o-1') },
        { _tag: 'ORDINARY', occurrence: occurrenceInput('o-2') },
      ]),
    );
    const units = Result.getOrThrow(mapped);

    expect(units).toHaveLength(2);
    expect(new Set(units.map(({ unitId }) => unitId)).size).toBe(2);
    expect(units.map(({ mapping }) => mapping.occurrenceId)).toEqual(['o-1', 'o-2']);
  });

  it('#920 F25-F26 #934 F11 F22-F23 maps a whole-treatment Set to one unit without component prices', () => {
    const mapped = mapTaxableSupplyUnits(
      decodeMeanings([
        {
          _tag: 'WHOLE_TREATMENT_SET',
          occurrence: occurrenceInput('set-o-1'),
          setCompositionRevisionRef: setComposition,
        },
      ]),
    );

    expect(mapped).toEqual(
      Result.succeed([
        {
          mapping: {
            _tag: 'WHOLE_TREATMENT_SET',
            catalogSelection: catalogSelectionInput(),
            occurrenceId: 'set-o-1',
            setCompositionRevisionRef: setComposition,
          },
          unitId: 'taxable-supply-unit:set-o-1',
        },
      ]),
    );
  });

  it('#920 F29-F30 #918 F39 a Set requiring several taxable supplies is TAX_CASE_UNSUPPORTED with no split', () => {
    const mapped = mapTaxableSupplyUnits(
      decodeMeanings([
        { _tag: 'ORDINARY', occurrence: occurrenceInput('o-1') },
        { _tag: 'MULTI_SUPPLY_SET', occurrence: occurrenceInput('set-o-2'), setCompositionRevisionRef: setComposition },
      ]),
    );

    expect(mapped).toEqual(
      Result.fail({ _tag: 'TAX_CASE_UNSUPPORTED', unsupportedRequirement: 'SET_MULTI_SUPPLY_DECOMPOSITION' }),
    );
  });

  it('#937 F16 #920 F11 rejects one occurrence carrying two supply meanings', () => {
    expect(() =>
      decodeMeanings([
        { _tag: 'ORDINARY', occurrence: occurrenceInput('o-1') },
        { _tag: 'ORDINARY', occurrence: occurrenceInput('o-1') },
      ]),
    ).toThrow();
  });

  it('#936 F58 maps the same exact occurrences deterministically', () => {
    const meanings = decodeMeanings([
      { _tag: 'ORDINARY', occurrence: occurrenceInput('o-1') },
      { _tag: 'ORDINARY', occurrence: occurrenceInput('o-2') },
    ]);

    expect(mapTaxableSupplyUnits(meanings)).toEqual(mapTaxableSupplyUnits(meanings));
  });
});
