import { Schema } from 'effect';

import { AcceptedTaxTermsSchema } from '../../src/domain/accepted-tax-terms.ts';
import type { AcceptedTaxTerms } from '../../src/domain/accepted-tax-terms.ts';
import type { AuthoritativeOriginalAcceptedRecordSchema } from '../../shared/domain/tax-kernel/accepted-tax-terms.ts';
import type { TaxDecisionSchema } from '../../shared/domain/tax-kernel/tax-decision.ts';
import { TaxExactRationalSchema, sumTaxExactRationals } from '../../shared/domain/tax-kernel/tax-exact-rational.ts';
import type { TaxExactRational } from '../../shared/domain/tax-kernel/tax-exact-rational.ts';
import { TaxResultSchema } from '../../src/domain/tax-result.ts';
import { TaxableSupplyUnitIdSchema } from '../../shared/domain/tax-kernel/taxable-supply-unit.ts';
import type { TaxableSupplyUnitId } from '../../src/domain/taxable-supply-unit.ts';
import {
  catalogSelectionInput,
  composeResult,
  decisionUnitInput,
  decodeTaxDecision,
  encodeTaxDecision,
  exactDecimal,
  nonPayerDecisionUnitInput,
  nonPayerTaxDecisionInput,
  purchaseBindingInput,
  shippingSourceRefInput,
  taxDecisionInput,
} from './tax-domain-fixtures.ts';

/**
 * Contract-conforming foreign-owner test double (#961 F17-F23): `acceptedTaxTermsInput` is the
 * Billing-owned accepted Billing Document (#945/#946, H10) as TAX consumes it. It carries no TAX
 * logic; the Decision/Result it embeds are composed by real TAX code. Not production cross-owner
 * integration.
 */

type TaxDecisionInput = typeof TaxDecisionSchema.Encoded;
type TaxDecisionUnitInput = TaxDecisionInput['units'][number];

const encodeResult = Schema.encodeSync(TaxResultSchema);
export const decodeAcceptedTaxTerms = Schema.decodeUnknownSync(AcceptedTaxTermsSchema);
export const encodeAcceptedTaxTerms = Schema.encodeSync(AcceptedTaxTermsSchema);

/**
 * One original accepted unit: its occurrence quantity, Line Commercial Value, rate and optional allocated Shipping.
 * `shipping` accepts either a decimal string or an already-exact fraction (needed for the exact shipping shares an
 * allocator produces); `shippingAmountBasis` is its recorded basis, GROSS unless given (907-Q07). Every shipped
 * unit of one Decision must state the same Shipping basis. `nonPayer: true` on the first unit switches the whole
 * Decision to `SELLER_NOT_VAT_PAYER`; a non-payer Decision carries no Shipping component (Unit 10), so `shipping`
 * together with `nonPayer` throws rather than silently building an undecodable Decision.
 */
export interface OriginalUnitInput {
  readonly amountBasis?: 'GROSS' | 'NET';
  readonly lineValue: string;
  readonly nonPayer?: true;
  readonly occurrenceId: string;
  readonly quantity: string;
  readonly ratePercent?: string;
  readonly shipping?: string | TaxExactRational;
  readonly shippingAmountBasis?: 'GROSS' | 'NET';
}

export const unitIdOf = (occurrenceId: string): TaxableSupplyUnitId =>
  TaxableSupplyUnitIdSchema.make(`taxable-supply-unit:${occurrenceId}`);

type AuthoritativeRecordInput = typeof AuthoritativeOriginalAcceptedRecordSchema.Encoded;

/** Default record of `acceptedTaxTermsInput`: the accepted Billing Document (H10). */
const DEFAULT_BILLING_DOCUMENT_RECORD: AuthoritativeRecordInput = {
  _tag: 'BILLING_DOCUMENT',
  billingDocumentRef: 'invoice-1',
};

const isExactRational = Schema.is(TaxExactRationalSchema);

const shippingExact = (shipping: string | TaxExactRational): TaxExactRational =>
  isExactRational(shipping) ? shipping : exactDecimal(shipping);

interface AllocationKeyInput {
  readonly key: 'GROSS_LINE_VALUE';
  readonly revision: 1;
}

const shippingComponentOf = (
  shipping: string | TaxExactRational,
  shippingAmountBasis: 'GROSS' | 'NET',
  allocationKey: AllocationKeyInput | undefined,
) => {
  const component = {
    _tag: 'SHIPPING_ALLOCATION' as const,
    amount: shippingExact(shipping),
    amountBasis: shippingAmountBasis,
    shippingSourceRef: shippingSourceRefInput,
  };
  return allocationKey === undefined ? component : { ...component, allocationKey };
};

const unitInput = (
  {
    amountBasis = 'NET',
    lineValue,
    nonPayer,
    occurrenceId,
    ratePercent = '21',
    shipping,
    shippingAmountBasis = 'GROSS',
  }: OriginalUnitInput,
  allocationKey?: AllocationKeyInput,
): TaxDecisionUnitInput => {
  if (nonPayer === true) {
    if (shipping !== undefined) {
      throw new Error('A SELLER_NOT_VAT_PAYER unit fixture carries no Shipping component');
    }
    return nonPayerDecisionUnitInput(occurrenceId, lineValue, amountBasis);
  }
  const unit = decisionUnitInput(occurrenceId, lineValue, ratePercent, amountBasis);
  if (shipping === undefined) {
    return unit;
  }
  return {
    ...unit,
    taxableBasisInterpretation: {
      components: [
        ...unit.taxableBasisInterpretation.components,
        shippingComponentOf(shipping, shippingAmountBasis, allocationKey),
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
  const nonPayer = units[0].nonPayer === true;
  const shipped = units.filter(({ shipping }) => shipping !== undefined);
  const binding = purchaseBindingInput(
    [first, ...rest],
    shipped.length > 0 ? { shippingSourceRef: shippingSourceRefInput } : {},
  );
  const [firstShipped, ...restShipped] = shipped;
  // Two or more shipped units carry the derived `GROSS_LINE_VALUE` allocation key at both the Decision-level
  // `shippingAllocation` and on each shipped unit's own recorded component: `shippingAllocatedCompletely` requires
  // an exact match between the two, including the key (#920 F33, #933 F17-F18).
  const sharedAllocationKey = restShipped.length > 0 ? ({ key: 'GROSS_LINE_VALUE', revision: 1 } as const) : undefined;
  const overrides = {
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
    units: [
      unitInput(units[0], sharedAllocationKey),
      ...units.slice(1).map((unit) => unitInput(unit, sharedAllocationKey)),
    ],
  } as const;
  const input = nonPayer
    ? nonPayerTaxDecisionInput([first, ...rest], overrides)
    : taxDecisionInput([first, ...rest], overrides);
  if (firstShipped === undefined) {
    return input;
  }
  return {
    ...input,
    shippingAllocation: {
      ownerIssuedShippingAmount: sumTaxExactRationals([
        shippingExact(firstShipped.shipping ?? '0'),
        ...restShipped.map(({ shipping = '0' }) => shippingExact(shipping)),
      ]),
      unitAllocations: [
        {
          basisComponent: shippingComponentOf(
            firstShipped.shipping ?? '0',
            firstShipped.shippingAmountBasis ?? 'GROSS',
            sharedAllocationKey,
          ),
          taxableSupplyUnitId: unitIdOf(firstShipped.occurrenceId),
        },
        ...restShipped.map(({ occurrenceId, shipping = '0', shippingAmountBasis = 'GROSS' }) => ({
          basisComponent: shippingComponentOf(shipping, shippingAmountBasis, sharedAllocationKey),
          taxableSupplyUnitId: unitIdOf(occurrenceId),
        })),
      ],
    },
  };
};

/**
 * Encoded Accepted Tax Terms retained by an accepted Billing Document, whose Order Commitment Time is the Decision's
 * T (H10: the record of a correction is the accepted Billing Document). A different `resultUnits` input publishes a
 * Result bound to the Decision whose amounts do not follow from it. Tests that need the Order Snapshot pass
 * `record` explicitly.
 */
export const acceptedTaxTermsInput = (
  units: readonly [OriginalUnitInput, ...OriginalUnitInput[]],
  resultUnits: readonly [OriginalUnitInput, ...OriginalUnitInput[]] = units,
  record: AuthoritativeRecordInput = DEFAULT_BILLING_DOCUMENT_RECORD,
) => {
  const decision = decodeTaxDecision(originalDecisionInput(units));
  const encodedDecision = encodeTaxDecision(decision);
  return {
    authoritativeRecord: record,
    finalTax: {
      _tag: 'TAX_DETERMINED' as const,
      decision: encodedDecision,
      result: encodeResult(composeResult(decodeTaxDecision(originalDecisionInput(resultUnits)))),
    },
    orderCommitmentTime: encodedDecision.taxRelevantTime,
    orderLineage: { bundleRef: 'bundle-1', orderRef: 'order-1' },
  };
};

export const acceptedTaxTerms = (units: readonly [OriginalUnitInput, ...OriginalUnitInput[]]): AcceptedTaxTerms =>
  decodeAcceptedTaxTerms(acceptedTaxTermsInput(units));
