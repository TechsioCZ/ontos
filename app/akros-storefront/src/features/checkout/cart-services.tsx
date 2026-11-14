"use client";

import { useDictionary } from "@/ontos/market-context";

export function CartServices() {
  const cs = useDictionary();
  return <p className="py-4 text-sm">{cs.cart.servicesNote}</p>;
}
