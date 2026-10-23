"use client";

import { useCart } from "./cart-provider";
import { getCartWeight } from "@/lib/cart-weight";

const kilograms = (value: number) =>
  `${value.toLocaleString("cs-CZ", { maximumFractionDigits: 6 })} kg`;

export function CartWeight() {
  const { cart } = useCart();
  const { complete, knownKg, missingLines } = getCartWeight(cart);
  return (
    <div className="akros-cart-weight" data-cart-weight>
      <dl>
        <div>
          <dt>{!complete && knownKg > 0 ? "Hmotnost známých položek" : "Celková hmotnost"}</dt>
          <dd>
            <output aria-live="polite">
              {complete || knownKg > 0 ? kilograms(knownKg) : "Nelze určit"}
            </output>
          </dd>
        </div>
      </dl>
      {!complete && (
        <p>
          {knownKg > 0 ? "Neúplný součet: u " : "U "}
          {missingLines} {missingLines === 1 ? "položky chybí hmotnost" : "položek chybí hmotnost"}{" "}
          za prodejní jednotku.
        </p>
      )}
    </div>
  );
}
