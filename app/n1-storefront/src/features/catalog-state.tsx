"use client";

import { useParams, useRouter } from "next/navigation";
import { Skeleton } from "@techsio/ui-kit/atoms/skeleton";
import { Button } from "@techsio/ui-kit/atoms/button";
import { PriceBlock } from "@techsio/ui-kit/molecules/price-block";
import { AvailabilityStatus } from "@techsio/ui-kit/molecules/availability-status";
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
  const unavailableDescription = kind === "product" ? d.productLoadFailed : d.categoryLoadFailed;
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
      <output className={pending && kind === "product" ? "sr-only" : ""}>
        {pending ? message : unavailableDescription}
      </output>
      {pending && kind === "product" && (
        <>
          <div className="w-full">
            <PriceBlock pendingLabel={d.loadingPrice} state="pending" />
          </div>
          <div className="w-full">
            <AvailabilityStatus pendingLabel={d.loadingAvailability} status="pending" />
          </div>
          <Button
            block
            isLoading
            loadingText={d.notifications.loading}
            size="md"
            theme="solid"
            type="button"
            variant="primary"
          >
            {d.notifications.loading}
          </Button>
        </>
      )}
      {pending && kind === "category" && (
        <div className="w-full">
          <Skeleton speed="slow">
            <div className="h-n1-loading-image">
              <div className="w-full max-w-80">
                <Skeleton.Rectangle className="h-20" />
              </div>
            </div>
            <div className="mt-6 flex w-full max-w-80 flex-col gap-6">
              <Skeleton.Text noOfLines={1} size="sm" />
              <Skeleton.Text noOfLines={1} size="sm" />
              <Skeleton.Text noOfLines={1} size="sm" />
            </div>
          </Skeleton>
        </div>
      )}
      {!pending && (
        <Button block onClick={() => router.refresh()} size="md" theme="solid" variant="primary">
          {d.retry}
        </Button>
      )}
    </section>
  );
};
