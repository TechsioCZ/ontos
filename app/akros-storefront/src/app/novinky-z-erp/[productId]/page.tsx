import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ErpProductDetail } from "@/components/erp-product-detail";
import { StorefrontShell } from "@/components/storefront-shell";
import { erpCopy } from "@/lib/erp-catalogue";
import { readErpProduct } from "@/ontos/erp-catalogue-server";
import { getErpOffer } from "@/ontos/erp-config";

interface ErpProductPageProps {
  params: Promise<{ productId: string }>;
}

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

const productOf = async (productId: string) =>
  getErpOffer() === undefined || !UUID.test(productId)
    ? undefined
    : await readErpProduct(productId);

export async function generateMetadata({ params }: ErpProductPageProps): Promise<Metadata> {
  const product = await productOf((await params).productId);
  return { title: product?.name ?? erpCopy.title };
}

/** One imported product: its variants with SKU, options, ERP price and ERP stock. */
export default async function ErpProductPage({ params }: ErpProductPageProps) {
  const product = await productOf((await params).productId);
  if (product === undefined) notFound();
  return (
    <StorefrontShell>
      <ErpProductDetail product={product} />
    </StorefrontShell>
  );
}
