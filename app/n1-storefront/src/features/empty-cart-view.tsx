import type { Ref } from "react";
import NextLink from "next/link";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import type { Dictionary } from "@/i18n";

export const EmptyCartView = ({
  dictionary: d,
  headingRef,
  locale,
}: {
  dictionary: Dictionary;
  headingRef?: Ref<HTMLHeadingElement>;
  locale: string;
}) => (
  <article className="mx-auto flex min-h-n1-cart-empty-mobile max-w-n1-product-content md:min-h-n1-cart-empty flex-col gap-4 p-5">
    <h1 className="text-xl font-bold" ref={headingRef} tabIndex={-1}>
      {d.shopping.empty}
    </h1>
    <p className="text-fg-secondary">{d.shopping.emptyDescription}</p>
    <div>
      <LinkButton as={NextLink} href={`/${locale}`} size="md" theme="solid" variant="primary">
        {d.shopping.backHome}
      </LinkButton>
    </div>
  </article>
);
