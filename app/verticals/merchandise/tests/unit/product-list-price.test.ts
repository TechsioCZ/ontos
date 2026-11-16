// A products list row's price: the stored price including VAT when there is one; otherwise the net price, labelled as
// a price without VAT rather than presented as one including VAT.
import { expect, it } from 'effect-rstest';

import { listPriceOf } from '../../src/routes/[lang]/provoz/produkty/product-list-price.ts';

it('shows the stored gross as a price including VAT, and a net price only as a price without VAT', () => {
  expect(listPriceOf({ currentPriceMinor: 1000, grossPriceMinor: 1211 })).toEqual({
    fromVariants: false,
    minor: 1211,
    withVat: true,
  });
  expect(listPriceOf({ currentPriceMinor: 1000 })).toEqual({ fromVariants: false, minor: 1000, withVat: false });
  expect(listPriceOf({ currentPriceMinor: 1000, grossPriceMinor: 900, variantCount: 2 })).toEqual({
    fromVariants: true,
    minor: 900,
    withVat: true,
  });
});
