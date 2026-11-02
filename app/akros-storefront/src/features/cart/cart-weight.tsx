"use client";

import { useCart } from "./cart-provider";
import { getCartWeight } from "@/lib/cart-weight";
import { formatWeight } from "@/lib/format";
import { useDictionary, useMoney } from "@/ontos/market-context";

/** Cart weight from each line's kg per sales unit (OntOS projection of the source feed); unknown lines are named. */
export function CartWeight() {
  const { cart } = useCart();
  const cs = useDictionary();
  const { locale } = useMoney();
  const { complete, knownKg, missingLines } = getCartWeight(cart);
  const kilograms = (value: number) => formatWeight(value, locale) ?? `0 kg`;
  return (
    <div className="sf-cart-weight" data-cart-weight>
      <dl>
        <div>
          <dt>{!complete && knownKg > 0 ? cs.cart.weight.knownTotal : cs.cart.weight.total}</dt>
          <dd>
            <output aria-live="polite">
              {complete || knownKg > 0 ? kilograms(knownKg) : cs.cart.weight.unknown}
            </output>
          </dd>
        </div>
      </dl>
      {!complete && <p>{cs.cart.weight.missing(missingLines, knownKg > 0)}</p>}
    </div>
  );
}
