import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { LaunchTaxCoverageInputSchema, evaluateLaunchTaxCoverage } from '../../src/domain/launch-coverage.ts';
import type { TaxUnsupportedRequirement } from '../../src/domain/tax-non-success-outcome.ts';
import { catalogSelectionInput, occurrenceInput } from './tax-domain-fixtures.ts';

const decodeInput = Schema.decodeUnknownSync(LaunchTaxCoverageInputSchema);

const baseInput: typeof LaunchTaxCoverageInputSchema.Encoded = {
  currency: 'CZK',
  requiredTaxRegimes: ['ORDINARY_DOMESTIC'],
  requiredTaxTreatments: ['TAXABLE'],
  sellingLegalEntityVatRegistration: 'CURRENT_POSITIVE',
  supplyMeanings: [{ _tag: 'ORDINARY', occurrence: occurrenceInput('o-1') }],
};

const coverageInput = (overrides: Partial<typeof LaunchTaxCoverageInputSchema.Encoded> = {}) =>
  decodeInput({ ...baseInput, ...overrides });

const unsupported = (unsupportedRequirement: TaxUnsupportedRequirement) =>
  Result.fail({ _tag: 'TAX_CASE_UNSUPPORTED', unsupportedRequirement });

describe('Launch Tax Coverage', () => {
  it('#918 F2 F13 ordinary domestic B2C CZK purchase with Current CZ VAT-registered seller is supported', () => {
    const coverage = evaluateLaunchTaxCoverage(coverageInput());

    expect(Result.isSuccess(coverage)).toBe(true);
    expect(Result.getOrThrow(coverage).map(({ unitId }) => unitId)).toEqual(['taxable-supply-unit:o-1']);
  });

  it('#918 F3 F6-F9 #923 F6-F8 F14-F15 ordinary B2B is supported whatever the buyer VAT status', () => {
    const retail = decodeInput({ ...baseInput, purchasingSubject: 'RETAIL_CUSTOMER' });
    const registeredBuyer = decodeInput({
      ...baseInput,
      buyerVatRegistration: 'VAT_REGISTERED',
      purchasingSubject: 'COUNTERPARTY',
    });
    const nonRegisteredBuyer = decodeInput({
      ...baseInput,
      buyerVatRegistration: 'VAT_NON_REGISTERED',
      purchasingSubject: 'COUNTERPARTY',
    });

    expect(Object.keys(registeredBuyer)).not.toContain('buyerVatRegistration');
    expect(Object.keys(registeredBuyer)).not.toContain('purchasingSubject');
    expect(evaluateLaunchTaxCoverage(registeredBuyer)).toEqual(evaluateLaunchTaxCoverage(retail));
    expect(evaluateLaunchTaxCoverage(registeredBuyer)).toEqual(evaluateLaunchTaxCoverage(nonRegisteredBuyer));
    expect(Result.isSuccess(evaluateLaunchTaxCoverage(nonRegisteredBuyer))).toBe(true);
  });

  it('#918 F4 #923 F1-F2 #924 F8 B2C has no VAT payer/non-payer input', () => {
    const b2c = decodeInput({ ...baseInput, purchasingSubject: 'RETAIL_CUSTOMER', vatPayer: false });

    expect(Object.keys(b2c)).not.toContain('vatPayer');
    expect(Result.isSuccess(evaluateLaunchTaxCoverage(b2c))).toBe(true);
  });

  it('#918 F17-F21 F28-F30 special or international regimes are unsupported with no domestic fallback', () => {
    expect(evaluateLaunchTaxCoverage(coverageInput({ requiredTaxRegimes: ['REVERSE_CHARGE'] }))).toEqual(
      unsupported('REVERSE_CHARGE'),
    );
    expect(evaluateLaunchTaxCoverage(coverageInput({ requiredTaxRegimes: ['ORDINARY_DOMESTIC', 'OSS'] }))).toEqual(
      unsupported('OSS'),
    );
    expect(evaluateLaunchTaxCoverage(coverageInput({ requiredTaxRegimes: ['EXPORT'] }))).toEqual(unsupported('EXPORT'));
    expect(evaluateLaunchTaxCoverage(coverageInput({ requiredTaxRegimes: ['INTRA_EU_SPECIAL_REGIME'] }))).toEqual(
      unsupported('INTRA_EU_SPECIAL_REGIME'),
    );
    expect(evaluateLaunchTaxCoverage(coverageInput({ requiredTaxRegimes: ['FOREIGN_VAT_REGIME'] }))).toEqual(
      unsupported('FOREIGN_VAT_REGIME'),
    );
  });

  it('#918 F31-F33 #907 F14 non-CZK selling currency is unsupported', () => {
    expect(evaluateLaunchTaxCoverage(coverageInput({ currency: 'EUR' }))).toEqual(unsupported('NON_CZK_CURRENCY'));
  });

  it('#918 F22-F23 #924 F23-F25 an unactivated exemption requirement is unsupported, not a missing rule', () => {
    expect(evaluateLaunchTaxCoverage(coverageInput({ requiredTaxTreatments: ['TAXABLE', 'EXEMPTION'] }))).toEqual(
      unsupported('EXEMPTION_TREATMENT'),
    );
  });

  it('#918 F36-F39 a Set requiring multi-supply decomposition is unsupported', () => {
    const coverage = evaluateLaunchTaxCoverage(
      coverageInput({
        supplyMeanings: [
          {
            _tag: 'MULTI_SUPPLY_SET',
            occurrence: {
              ...occurrenceInput('set-o-1'),
              catalogSelection: {
                ...catalogSelectionInput('set-variant-1'),
                setCompositionRevisionRef: { revision: 1, setCompositionId: 'set-composition-1' },
              },
            },
          },
        ],
      }),
    );

    expect(coverage).toEqual(unsupported('SET_MULTI_SUPPLY_DECOMPOSITION'));
  });

  it('#918 F14 F16 #938 F8-F10 known ended or non-registered seller is TAX_PREREQUISITE_NOT_MET', () => {
    expect(
      evaluateLaunchTaxCoverage(coverageInput({ sellingLegalEntityVatRegistration: 'KNOWN_ENDED_OR_NON_REGISTERED' })),
    ).toEqual(
      Result.fail({
        _tag: 'TAX_PREREQUISITE_NOT_MET',
        unmetPrerequisite: 'SELLING_LEGAL_ENTITY_CURRENT_CZ_VAT_REGISTRATION',
      }),
    );
  });

  it('#938 F7 an unsupported scope is reported before a known-negative seller', () => {
    expect(
      evaluateLaunchTaxCoverage(
        coverageInput({
          requiredTaxRegimes: ['REVERSE_CHARGE'],
          sellingLegalEntityVatRegistration: 'KNOWN_ENDED_OR_NON_REGISTERED',
        }),
      ),
    ).toEqual(unsupported('REVERSE_CHARGE'));
  });

  it('#918 F15 #938 F13-F15 F20-F28 stale, unavailable, unknown and unresolved seller state are never negative', () => {
    const outcomeFor = (sellingLegalEntityVatRegistration: (typeof baseInput)['sellingLegalEntityVatRegistration']) =>
      evaluateLaunchTaxCoverage(coverageInput({ sellingLegalEntityVatRegistration }));

    expect(outcomeFor('STALE')).toEqual(Result.fail({ _tag: 'TAX_INPUT_STALE' }));
    expect(outcomeFor('UNAVAILABLE')).toEqual(Result.fail({ _tag: 'TAX_DEPENDENCY_UNAVAILABLE' }));
    expect(outcomeFor('UNKNOWN')).toEqual(Result.fail({ _tag: 'TAX_STATE_INDETERMINATE' }));
    expect(outcomeFor('UNRESOLVED')).toEqual(Result.fail({ _tag: 'TAX_STATE_INDETERMINATE' }));
    expect(() => decodeInput({ ...baseInput, sellingLegalEntityVatRegistration: null })).toThrow();
  });

  it('#938 F34 F41 the same unchanged unsupported case stays unsupported on repeated evaluation', () => {
    const input = coverageInput({ requiredTaxRegimes: ['OSS'] });

    expect(evaluateLaunchTaxCoverage(input)).toEqual(evaluateLaunchTaxCoverage(input));
  });

  it('#938 F41 several unsupported requirements give the same outcome whatever their input order', () => {
    expect(evaluateLaunchTaxCoverage(coverageInput({ requiredTaxRegimes: ['REVERSE_CHARGE', 'OSS'] }))).toEqual(
      evaluateLaunchTaxCoverage(coverageInput({ requiredTaxRegimes: ['OSS', 'REVERSE_CHARGE'] })),
    );
    expect(evaluateLaunchTaxCoverage(coverageInput({ requiredTaxTreatments: ['ZERO_RATE', 'EXEMPTION'] }))).toEqual(
      evaluateLaunchTaxCoverage(coverageInput({ requiredTaxTreatments: ['EXEMPTION', 'ZERO_RATE'] })),
    );
  });
});
