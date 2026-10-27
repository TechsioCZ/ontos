"use client";

import Image from "next/image";
import { useState } from "react";

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
  const [failed, setFailed] = useState<string[]>([]);
  const image = [src, fallback, "/akros/products/image-unavailable.svg"].find(
    (candidate): candidate is string => !!candidate && !failed.includes(candidate),
  );
  return image ? (
    <Image
      src={image}
      alt={alt}
      width={preview ? 160 : 480}
      height={preview ? 160 : 400}
      className={preview ? "akros-variant-preview__image" : "akros-variant-detail__image"}
      onError={() => setFailed((current) => [...current, image])}
    />
  ) : (
    <span>Obrázek není k dispozici.</span>
  );
}
