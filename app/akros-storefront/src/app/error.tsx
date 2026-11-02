"use client";
import { useOptionalBrand } from "@/brand/brand-context";
import { Unavailable } from "@/ontos/unavailable";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return <Unavailable reset={reset} storeName={useOptionalBrand()?.name} />;
}
