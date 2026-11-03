"use client";

import { useParams, useRouter } from "next/navigation";
import { Skeleton } from "@techsio/ui-kit/atoms/skeleton";
import { Button } from "@techsio/ui-kit/atoms/button";
import { getDictionary } from "@/i18n";

/** Framework loading/unavailable states contain no product fixtures or synthetic success data. */
export const CatalogState = ({
  kind,
  pending = false,
}: {
  kind: "category" | "product";
  pending?: boolean;
}) => {
  const params = useParams<{ locale: string }>();
  const router = useRouter();
  const d = getDictionary(params.locale);
  const message = kind === "product" ? d.loadingProduct : d.loadingCatalog;
  const unavailableTitle = kind === "product" ? d.productUnavailable : d.unavailable;
  const loadingTitle = kind === "product" ? d.detail : d.catalog;
  const title = pending ? loadingTitle : unavailableTitle;
  return (
    <section
      aria-busy={pending}
      className="mx-auto flex max-w-n1-content flex-col items-start gap-6 p-4"
    >
      <h1
        className={
          kind === "product"
            ? "text-xl leading-normal font-semibold"
            : "text-2xl leading-normal font-bold"
        }
      >
        {title}
      </h1>
      <output>{pending ? message : d.unavailableDescription}</output>
      {pending ? (
        <div className="w-full">
          <Skeleton speed="slow">
            <Skeleton.Rectangle>
              <div className="h-n1-loading-image" />
            </Skeleton.Rectangle>
            <div className="mt-6">
              <Skeleton.Text noOfLines={3} size="sm" />
            </div>
          </Skeleton>
        </div>
      ) : (
        <Button block onClick={() => router.refresh()} size="md" theme="solid" variant="primary">
          {d.retry}
        </Button>
      )}
    </section>
  );
};
