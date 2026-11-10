"use client";

import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@techsio/ui-kit/atoms/button";
import { Link } from "@/features/plain-link";
import type { Dictionary } from "@/i18n";
import type { FulfillmentResult } from "@/ontos/fulfillment-model";

const priceFormatters = {
  CZK: {
    cs: new Intl.NumberFormat("cs", { currency: "CZK", style: "currency" }),
    en: new Intl.NumberFormat("en", { currency: "CZK", style: "currency" }),
  },
  EUR: {
    cs: new Intl.NumberFormat("cs", { currency: "EUR", style: "currency" }),
    en: new Intl.NumberFormat("en", { currency: "EUR", style: "currency" }),
  },
  PLN: {
    cs: new Intl.NumberFormat("cs", { currency: "PLN", style: "currency" }),
    en: new Intl.NumberFormat("en", { currency: "PLN", style: "currency" }),
  },
};

/** Owner-backed information in the Figma article composition, never a checkout selector. */
export const FulfillmentView = ({
  dictionary: d,
  kind,
  locale,
  result,
}: {
  dictionary: Dictionary;
  kind: "shipping" | "payment";
  locale: string;
  result: FulfillmentResult;
}) => {
  const router = useRouter();
  let content;
  if (result.state === "unavailable") {
    content = (
      <div className="mt-6 flex flex-col items-start gap-4">
        <output>{d.fulfillment.unavailable}</output>
        <Button onClick={() => router.refresh()} size="sm" theme="outlined" variant="secondary">
          {d.contact.retry}
        </Button>
      </div>
    );
  } else if (kind === "shipping") {
    content = (
      <div className="flex flex-col gap-6 pt-6">
        {result.info.shippingMethods.length === 0 && <p>{d.fulfillment.noShipping}</p>}
        {result.info.shippingMethods.map((method) => (
          <section className="flex min-w-0 flex-col gap-4" key={method.id}>
            <h2 className="text-lg font-semibold">{method.title}</h2>
            <p className="text-lg font-bold">
              {priceFormatters[result.info.currency][locale === "en" ? "en" : "cs"].format(
                method.priceMinor / 100,
              )}
            </p>
            <p className="text-fg-secondary">{d.fulfillment.shippingDescriptions[method.id]}</p>
          </section>
        ))}
      </div>
    );
  } else {
    content = (
      <p className="pt-6 text-fg-secondary">
        {result.info.paymentAvailable
          ? d.fulfillment.paymentDetailsUnavailable
          : d.fulfillment.noPayment}
      </p>
    );
  }
  return (
    <article className="mx-auto w-full md:min-h-n1-article-min max-w-n1-content p-10">
      <div className="relative">
        <h1 className="text-xl leading-8 font-bold">
          {kind === "shipping" ? d.shipping : d.payment}
        </h1>
        <div aria-hidden className="absolute bottom-0 h-1 w-24 bg-primary" />
      </div>
      {content}
      {(result.state === "unavailable" ||
        kind === "payment" ||
        result.info.shippingMethods.length === 0) && (
        <div className="pt-6">
          <Link as={NextLink} href={`/${locale}/kontakty`}>
            {d.contacts}
          </Link>
        </div>
      )}
    </article>
  );
};
