"use client";

import Image from "next/image";
import { useState } from "react";
import { useDictionary } from "@/ontos/market-context";
import { imagePlaceholder } from "@/ontos/media-path";

/** The variant's own image, else the product image, else the neutral placeholder. */
export function ProductVariantImage({
  src,
  fallback,
  alt,
  preview = false,
}: {
  src?: string;
  fallback: string;
  alt: string;
  preview?: boolean;
}) {
  const cs = useDictionary();
  const [failed, setFailed] = useState<string[]>([]);
  const image = [src, fallback, imagePlaceholder].find(
    (candidate): candidate is string => !!candidate && !failed.includes(candidate),
  );
  return image ? (
    <Image
      src={image}
      alt={alt}
      width={preview ? 160 : 480}
      height={preview ? 160 : 400}
      className={preview ? "sf-variant-preview__image" : "sf-variant-detail__image"}
      onError={() => setFailed((current) => [...current, image])}
    />
  ) : (
    <span>{cs.variants.imageUnavailable}</span>
  );
}
