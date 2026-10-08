import { Schema } from 'effect';

import { AcceptedTaxTermsSchema } from '../../src/domain/accepted-tax-terms.ts';
import type { AcceptedTaxTerms } from '../../src/domain/accepted-tax-terms.ts';
import type { TaxDecisionSchema } from '../../src/domain/tax-decision.ts';
import { sumTaxExactRationals } from '../../src/domain/tax-exact-rational.ts';
import { TaxResultSchema } from '../../src/domain/tax-result.ts';
import { TaxableSupplyUnitIdSchema } from '../../src/domain/taxable-supply-unit.ts';
import type { TaxableSupplyUnitId } from '../../src/domain/taxable-supply-unit.ts';
import {
  catalogSelectionInput,
  composeResult,
  decisionUnitInput,
  decodeTaxDecision,
  encodeTaxDecision,
  exactDecimal,
  purchaseBindingInput,
  shippingSourceRefInput,
  taxDecisionInput,
} from './tax-domain-fixtures.ts';

type TaxDecisionInput = typeof TaxDecisionSchema.Encoded;
type TaxDecisionUnitInput = TaxDecisionInput['units'][number];

const encodeResult = Schema.encodeSync(TaxResultSchema);
export const decodeAcceptedTaxTerms = Schema.decodeUnknownSync(AcceptedTaxTermsSchema);
export const encodeAcceptedTaxTerms = Schema.encodeSync(AcceptedTaxTermsSchema);

/** One original accepted unit: its occurrence quantity, Line Commercial Value, rate and optional allocated Shipping. */
export interface OriginalUnitInput {
  readonly lineValue: string;
  readonly occurrenceId: string;
  readonly quantity: string;
  readonly ratePercent?: string;
  readonly shipping?: string;
}

export const unitIdOf = (occurrenceId: string): TaxableSupplyUnitId =>
  TaxableSupplyUnitIdSchema.make(`taxable-supply-unit:${occurrenceId}`);

const unitInput = ({
  lineValue,
  occurrenceId,
  ratePercent = '21',
  shipping,
}: OriginalUnitInput): TaxDecisionUnitInput => {
  const unit = decisionUnitInput(occurrenceId, lineValue, ratePercent);
  return shipping === undefined
    ? unit
    : {
        ...unit,
        taxableBasisInterpretation: {
          components: [
            ...unit.taxableBasisInterpretation.components,
            { _tag: 'SHIPPING_ALLOCATION', amount: exactDecimal(shipping), shippingSourceRef: shippingSourceRefInput },
          ],
        },
      };
};

/** Encoded final Tax Decision of the given original units, as retained by an Accepted record. */
export const originalDecisionInput = (
  units: readonly [OriginalUnitInput, ...OriginalUnitInput[]],
): TaxDecisionInput => {
  const occurrenceIds = units.map(({ occurrenceId }) => occurrenceId);
  const [first = 'o-1', ...rest] = occurrenceIds;
  const shipped = units.filter(({ shipping }) => shipping !== undefined);
  const binding = purchaseBindingInput(
    [first, ...rest],
    shipped.length > 0 ? { shippingSourceRef: shippingSourceRefInput } : {},
  );
  const [firstShipped, ...restShipped] = shipped;
  const input = taxDecisionInput([first, ...rest], {
    purchaseBinding: {
      ...binding,
      purchaseDemandOccurrences: [
        {
          catalogSelection: catalogSelectionInput(),
          occurrenceId: first,
          quantity: { amount: units[0].quantity, unitRef: 'piece' },
        },
        ...units.slice(1).map(({ occurrenceId, quantity }) => ({
          catalogSelection: catalogSelectionInput(),
          occurrenceId,
          quantity: { amount: quantity, unitRef: 'piece' },
        })),
      ],
    },
    units: [unitInput(units[0]), ...units.slice(1).map(unitInput)],
  });
  if (firstShipped === undefined) {
    return input;
  }
  return {
    ...input,
    shippingAllocation: {
      ownerIssuedShippingAmount: sumTaxExactRationals([
        exactDecimal(firstShipped.shipping ?? '0'),
        ...restShipped.map(({ shipping = '0' }) => exactDecimal(shipping)),
      ]),
      unitAllocations: [
        {
          basisComponent: {
            _tag: 'SHIPPING_ALLOCATION',
            amount: exactDecimal(firstShipped.shipping ?? '0'),
            shippingSourceRef: shippingSourceRefInput,
          },
          taxableSupplyUnitId: unitIdOf(firstShipped.occurrenceId),
        },
        ...restShipped.map(({ occurrenceId, shipping = '0' }) => ({
          basisComponent: {
            _tag: 'SHIPPING_ALLOCATION' as const,
            amount: exactDecimal(shipping),
            shippingSourceRef: shippingSourceRefInput,
          },
          taxableSupplyUnitId: unitIdOf(occurrenceId),
        })),
      ],
    },
  };
};

/** Encoded Accepted Tax Terms of a B2C final Order Snapshot whose Order Commitment Time is the Decision's T. */
export const acceptedTaxTermsInput = (units: readonly [OriginalUnitInput, ...OriginalUnitInput[]]) => {
  const decision = decodeTaxDecision(originalDecisionInput(units));
  const encodedDecision = encodeTaxDecision(decision);
  return {
    authoritativeRecord: { _tag: 'ORDER_SNAPSHOT' as const },
    finalTax: {
      _tag: 'TAX_DETERMINED' as const,
      decision: encodedDecision,
      result: encodeResult(composeResult(decision)),
    },
    orderCommitmentTime: encodedDecision.taxRelevantTime,
    orderLineage: { bundleRef: 'bundle-1', orderRef: 'order-1' },
  };
};

export const acceptedTaxTerms = (units: readonly [OriginalUnitInput, ...OriginalUnitInput[]]): AcceptedTaxTerms =>
  decodeAcceptedTaxTerms(acceptedTaxTermsInput(units));
