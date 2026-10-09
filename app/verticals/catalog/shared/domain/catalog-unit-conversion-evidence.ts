import { Schema } from 'effect';

import { CatalogRevisionInstantSchema, sameCatalogRevisionReference } from './catalog-revision-reference.ts';
import type { CatalogResourceRef } from './catalog-revision-reference.ts';
import { CatalogSelectionRevisionSchema } from './catalog-selection-evidence.ts';

const decimalPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;

const ratioText = Schema.String.check(Schema.isPattern(decimalPattern), Schema.isMaxLength(256), Schema.isTrimmed());
const evidenceIdSchema = Schema.String.check(Schema.isUUID(), Schema.isTrimmed()).pipe(
  Schema.brand('CatalogUnitConversionEvidenceId'),
);
const unitRevision = CatalogSelectionRevisionSchema.check(
  Schema.makeFilter(({ resourceRef }) =>
    resourceRef.resourceType === 'commerce.catalog.unit' ? undefined : 'Expected an exact Unit revision',
  ),
);

interface Decimal {
  readonly coefficient: bigint;
  readonly scale: number;
}
interface Rational {
  readonly denominator: bigint;
  readonly numerator: bigint;
}

const parseDecimal = (text: string): Decimal | null => {
  if (!decimalPattern.test(text) || text.length > 256) {
    return null;
  }
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole = '', fraction = ''] = unsigned.split('.');
  return { coefficient: BigInt(`${negative ? '-' : ''}${whole}${fraction}`), scale: fraction.length };
};
const positive = (text: string): boolean => {
  const parsed = parseDecimal(text);
  return parsed !== null && parsed.coefficient > 0n;
};
const rational = (value: Decimal): Rational => ({
  denominator: 10n ** BigInt(value.scale),
  numerator: value.coefficient,
});
const multiply = (left: Rational, right: Rational): Rational => ({
  denominator: left.denominator * right.denominator,
  numerator: left.numerator * right.numerator,
});
const ratio = (numerator: string, denominator: string): Rational | null => {
  const top = parseDecimal(numerator);
  const bottom = parseDecimal(denominator);
  return top === null || bottom === null
    ? null
    : {
        denominator: bottom.coefficient * 10n ** BigInt(top.scale),
        numerator: top.coefficient * 10n ** BigInt(bottom.scale),
      };
};
const equalRational = (left: Rational, right: Rational): boolean =>
  left.numerator * right.denominator === right.numerator * left.denominator;

const exactRatioConverts = (
  conversion: CatalogUnitConversionEvidence,
  fromAmount: string,
  toAmount: string,
): boolean => {
  const from = parseDecimal(fromAmount);
  const to = parseDecimal(toAmount);
  const factor = ratio(conversion.numerator, conversion.denominator);
  return (
    from !== null && to !== null && factor !== null && equalRational(multiply(rational(from), factor), rational(to))
  );
};

/**
 * Owner-issued, exact conversion between two Unit revisions of one Tenant. The ratio is exact
 * decimal arithmetic (`fromAmount * numerator / denominator = toAmount`); it is not an estimate,
 * and no Catalog code may synthesize one without this evidence.
 */
export const CatalogUnitConversionEvidenceSchema = Schema.Struct({
  denominator: ratioText,
  evidenceId: evidenceIdSchema,
  from: unitRevision,
  numerator: ratioText,
  observedAt: CatalogRevisionInstantSchema,
  ownerModuleId: Schema.Literal('commerce.catalog'),
  source: Schema.Literal('CATALOG_OWNER_CURRENT_READ'),
  to: unitRevision,
}).check(
  Schema.makeFilter(({ denominator, from, numerator, to }) => {
    if (from.resourceRef.tenantId !== to.resourceRef.tenantId) {
      return 'Unit conversion must share one Tenant';
    }
    if (from.resourceRef.resourceId === to.resourceRef.resourceId) {
      return 'Unit conversion must relate distinct Units';
    }
    return positive(numerator) && positive(denominator) ? undefined : 'Unit conversion ratio must be positive';
  }),
);
export type CatalogUnitConversionEvidence = typeof CatalogUnitConversionEvidenceSchema.Type;

/** Exact owner-qualified Unit revision identity used as the conversion endpoints. */
export interface CatalogUnitRevisionReference {
  readonly resourceRef: CatalogResourceRef;
  readonly revision: number;
  readonly revisionId?: string;
}

/**
 * True only when the evidence names the exact `from`/`to` Unit revisions and its exact ratio
 * losslessly converts `fromAmount` to `toAmount`.
 */
export const catalogUnitConversionProves = (
  conversion: CatalogUnitConversionEvidence,
  from: CatalogUnitRevisionReference,
  to: CatalogUnitRevisionReference,
  fromAmount: string,
  toAmount: string,
): boolean =>
  sameCatalogRevisionReference(conversion.from, from) &&
  sameCatalogRevisionReference(conversion.to, to) &&
  exactRatioConverts(conversion, fromAmount, toAmount);
