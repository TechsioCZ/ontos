import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  TaxJurisdictionDeterminationSchema,
  TaxJurisdictionInputSchema,
  determineTaxJurisdiction,
} from '../../src/domain/tax-jurisdiction.ts';

const decodeInput = Schema.decodeUnknownSync(TaxJurisdictionInputSchema);

type TaxJurisdictionInputEncoded = typeof TaxJurisdictionInputSchema.Encoded;

const czechPlace = (ownerEvidenceRef: string) =>
  ({ _tag: 'OWNER_RESOLVED', countryCode: 'CZ', ownerEvidenceRef }) as const;

const baseInput: TaxJurisdictionInputEncoded = {
  deliveryDestination: czechPlace('delivery-destination-evidence-1'),
  invoiceRecipient: czechPlace('invoice-recipient-evidence-1'),
  sellingLegalEntity: czechPlace('selling-legal-entity-evidence-1'),
};

const jurisdictionFor = (overrides: Partial<TaxJurisdictionInputEncoded> = {}) =>
  determineTaxJurisdiction(decodeInput({ ...baseInput, ...overrides }));

describe('Tax Jurisdiction', () => {
  it('#927 F1 F5-F6 H owner-resolved Czech place facts give Czech domestic jurisdiction with their evidence', () => {
    expect(jurisdictionFor()).toEqual(
      Result.succeed({
        jurisdiction: 'CZ_DOMESTIC',
        placeEvidenceRefs: {
          deliveryDestination: 'delivery-destination-evidence-1',
          invoiceRecipient: 'invoice-recipient-evidence-1',
          sellingLegalEntity: 'selling-legal-entity-evidence-1',
        },
      }),
    );
  });

  it('#927 F2-F3 F20 Commerce Market, Storefront, hostname, locale, IP and currency are not jurisdiction inputs', () => {
    const withPresentation = decodeInput({
      ...baseInput,
      commerceMarketRef: 'market-cz',
      currency: 'CZK',
      hostname: 'shop.example.cz',
      ipAddress: '192.0.2.10',
      locale: 'cs-CZ',
      storefrontRef: 'storefront-cz',
    });

    expect(Object.keys(withPresentation).toSorted()).toEqual([
      'deliveryDestination',
      'invoiceRecipient',
      'sellingLegalEntity',
    ]);
    expect(determineTaxJurisdiction(withPresentation)).toEqual(jurisdictionFor());
  });

  it('#927 F3 F19-F20 Czech presentation without authoritative place evidence does not fall back to CZ', () => {
    const czechLookingWithoutEvidence = decodeInput({
      ...baseInput,
      deliveryDestination: { _tag: 'NOT_ESTABLISHED', state: 'UNKNOWN' },
      locale: 'cs-CZ',
      storefrontRef: 'storefront-cz',
    });

    expect(determineTaxJurisdiction(czechLookingWithoutEvidence)).toEqual(
      Result.fail({ _tag: 'TAX_STATE_INDETERMINATE' }),
    );
  });

  it('#927 F4 raw client address input is not an authoritative place fact', () => {
    expect(() =>
      decodeInput({ ...baseInput, deliveryDestination: { _tag: 'RAW_ADDRESS', countryCode: 'CZ', street: 'Main 1' } }),
    ).toThrow();
    expect(() =>
      decodeInput({ ...baseInput, deliveryDestination: { _tag: 'OWNER_RESOLVED', countryCode: 'CZ' } }),
    ).toThrow();
  });

  it('#927 F19 #938 F20-F28 a required Delivery Destination that cannot be established gives a typed non-success', () => {
    expect(jurisdictionFor({ deliveryDestination: { _tag: 'NOT_ESTABLISHED', state: 'UNAVAILABLE' } })).toEqual(
      Result.fail({ _tag: 'TAX_DEPENDENCY_UNAVAILABLE' }),
    );
    expect(jurisdictionFor({ deliveryDestination: { _tag: 'NOT_ESTABLISHED', state: 'STALE' } })).toEqual(
      Result.fail({ _tag: 'TAX_INPUT_STALE' }),
    );
    expect(jurisdictionFor({ deliveryDestination: { _tag: 'NOT_ESTABLISHED', state: 'UNRESOLVED' } })).toEqual(
      Result.fail({ _tag: 'TAX_STATE_INDETERMINATE' }),
    );
  });

  it('#927 F6 F19 #937 F40 the Selling Legal Entity place fact is always required', () => {
    expect(jurisdictionFor({ sellingLegalEntity: { _tag: 'NOT_ESTABLISHED', state: 'STALE' } })).toEqual(
      Result.fail({ _tag: 'TAX_INPUT_STALE' }),
    );
    expect(() => decodeInput({ ...baseInput, sellingLegalEntity: { _tag: 'NOT_MATERIAL' } })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(TaxJurisdictionDeterminationSchema)({
        jurisdiction: 'CZ_DOMESTIC',
        placeEvidenceRefs: { deliveryDestination: 'delivery-destination-evidence-1' },
      }),
    ).toThrow();
  });

  it('#937 F52-F54 a declared-material Invoice Recipient is required; a not-material one is not', () => {
    expect(jurisdictionFor({ invoiceRecipient: { _tag: 'NOT_ESTABLISHED', state: 'UNAVAILABLE' } })).toEqual(
      Result.fail({ _tag: 'TAX_DEPENDENCY_UNAVAILABLE' }),
    );
    expect(jurisdictionFor({ invoiceRecipient: { _tag: 'NOT_MATERIAL' } })).toEqual(
      Result.succeed({
        jurisdiction: 'CZ_DOMESTIC',
        placeEvidenceRefs: {
          deliveryDestination: 'delivery-destination-evidence-1',
          sellingLegalEntity: 'selling-legal-entity-evidence-1',
        },
      }),
    );
    const { invoiceRecipient: _undeclared, ...withoutDeclaration } = baseInput;
    expect(() => decodeInput(withoutDeclaration)).toThrow();
  });

  it('#923 F1-F2 #937 F52-F53 a case using neither Delivery Destination nor Invoice Recipient needs only the seller place', () => {
    expect(
      jurisdictionFor({ deliveryDestination: { _tag: 'NOT_MATERIAL' }, invoiceRecipient: { _tag: 'NOT_MATERIAL' } }),
    ).toEqual(
      Result.succeed({
        jurisdiction: 'CZ_DOMESTIC',
        placeEvidenceRefs: { sellingLegalEntity: 'selling-legal-entity-evidence-1' },
      }),
    );
  });

  it('#927 F16 #938 F41 the reported failure does not depend on input key order', () => {
    const input = {
      ...baseInput,
      deliveryDestination: { _tag: 'NOT_ESTABLISHED', state: 'STALE' },
      invoiceRecipient: { _tag: 'NOT_ESTABLISHED', state: 'UNAVAILABLE' },
    } as const;
    const reversedKeys = Object.fromEntries(Object.entries(input).toReversed());

    expect(Object.keys(reversedKeys)).not.toEqual(Object.keys(input));
    expect(determineTaxJurisdiction(decodeInput(reversedKeys))).toEqual(determineTaxJurisdiction(decodeInput(input)));
  });

  it('#907 F2-F3 F12 glossary Tax Jurisdiction any known place outside Czechia is TAX_CASE_UNSUPPORTED', () => {
    const unsupported = Result.fail({
      _tag: 'TAX_CASE_UNSUPPORTED',
      unsupportedRequirement: 'NON_CZECH_DOMESTIC_TAX_PLACE',
    });

    expect(jurisdictionFor({ deliveryDestination: { ...czechPlace('dd-sk'), countryCode: 'SK' } })).toEqual(
      unsupported,
    );
    expect(jurisdictionFor({ invoiceRecipient: { ...czechPlace('ir-de'), countryCode: 'DE' } })).toEqual(unsupported);
    expect(
      jurisdictionFor({
        deliveryDestination: { _tag: 'NOT_ESTABLISHED', state: 'UNAVAILABLE' },
        sellingLegalEntity: { ...czechPlace('sle-at'), countryCode: 'AT' },
      }),
    ).toEqual(unsupported);
  });

  it('#927 F15-F16 same exact owner-resolved inputs repeatedly give the same jurisdiction', () => {
    expect(jurisdictionFor()).toEqual(jurisdictionFor());
    expect(determineTaxJurisdiction(decodeInput(baseInput))).toEqual(determineTaxJurisdiction(decodeInput(baseInput)));
  });
});
