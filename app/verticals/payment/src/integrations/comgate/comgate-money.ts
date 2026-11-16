import { Option, Schema } from 'effect';

import type { PaymentMonetaryAmount } from '../../../shared/domain/payment-money.ts';
import { parseExactMinorUnits, ProviderReportedAmountSchema } from '../psp/psp-money.ts';
import type { ProviderReportedAmount } from '../psp/psp-money.ts';

/**
 * Comgate money (#1156). `price` and refund `amount` are integer "cents or pennies": the CZK minor
 * units (haléře) Payment already holds, so the value passes through unchanged. Comgate accepts CZK
 * payments from 1 CZK to 1 000 000 CZK (https://apidoc.comgate.cz/en/api/rest/). The status and push
 * `price` is a string ("10000") and is parsed exactly; nothing rounds, scales or converts.
 */

export const COMGATE_MINIMUM_PRICE_MINOR = 100;
export const COMGATE_MAXIMUM_PRICE_MINOR = 100_000_000;

/** Create `price`: the CZK amount when it lies inside 100..100 000 000, else `None` (prepare fails Unsupported). */
export const toComgatePrice = (amount: PaymentMonetaryAmount): Option.Option<number> =>
  amount.amountMinor >= COMGATE_MINIMUM_PRICE_MINOR && amount.amountMinor <= COMGATE_MAXIMUM_PRICE_MINOR
    ? Option.some(amount.amountMinor)
    : Option.none();

/**
 * Refund `amount`: a positive CZK amount no larger than the maximum price (a refund never exceeds
 * its payment, and Comgate answers 1402 when it would). Anything else is `None`.
 */
export const toComgateRefundAmount = (amount: PaymentMonetaryAmount): Option.Option<number> =>
  amount.amountMinor >= 1 && amount.amountMinor <= COMGATE_MAXIMUM_PRICE_MINOR
    ? Option.some(amount.amountMinor)
    : Option.none();

/**
 * The authentic amount of a status or push (`price` text, `curr` code). The currency is kept as
 * reported (e.g. EUR); a price that is not an exact unsigned integer is `None` (response invalid).
 */
export const fromComgatePrice = (reported: {
  readonly curr: string;
  readonly price: string;
}): Option.Option<ProviderReportedAmount> =>
  Option.flatMap(parseExactMinorUnits(reported.price), (amountMinor) =>
    Schema.decodeUnknownOption(ProviderReportedAmountSchema)({ amountMinor, currency: reported.curr }),
  );

/**
 * A statement amount (`Potvrzená částka`, decimal comma with exactly two decimals, e.g. `"-422,00"`) as
 * signed integer minor units (`-42200`). The digits are joined as text and parsed exactly; anything else
 * (thousands separators, a decimal point, more or fewer decimals) is `None`.
 */
export const parseComgateStatementAmount = (text: string): Option.Option<number> => {
  const match = /^(?<sign>-?)(?<units>0|[1-9][0-9]{0,12}),(?<cents>[0-9]{2})$/u.exec(text);
  const groups = match?.groups;
  if (groups === undefined) {
    return Option.none();
  }
  const digits = `${groups['units'] ?? ''}${groups['cents'] ?? ''}`.replace(/^0+(?=[0-9])/u, '');
  return Option.map(parseExactMinorUnits(digits), (magnitude) =>
    groups['sign'] === '-' && magnitude !== 0 ? -magnitude : magnitude,
  );
};
