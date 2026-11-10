"use client";

import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@techsio/ui-kit/atoms/badge";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { StatusText } from "@techsio/ui-kit/atoms/status-text";
import type { Dictionary } from "@/i18n";
import type { CheckoutOptions } from "@/ontos/checkout-server";
import { CheckoutFields } from "./checkout-fields";
import { CheckoutItems, CheckoutShipping, CheckoutTotals } from "./checkout-panels";
import { EmptyCartView } from "./empty-cart-view";
import { useCheckout } from "./use-checkout";

const dateFormatters = {
  cs: new Intl.DateTimeFormat("cs", { dateStyle: "long", timeStyle: "short" }),
  en: new Intl.DateTimeFormat("en", { dateStyle: "long", timeStyle: "short" }),
};
const receiptDate = (value: string | null | undefined, locale: string) => {
  const milliseconds = value === null || value === undefined ? Number.NaN : Date.parse(value);
  return Number.isFinite(milliseconds)
    ? dateFormatters[locale === "en" ? "en" : "cs"].format(milliseconds)
    : null;
};
type ReadyOptions = Extract<CheckoutOptions, { state: "ready" }>;
type Checkout = ReturnType<typeof useCheckout>;
const noticeText = (checkout: Checkout, d: Dictionary) => {
  if (checkout.notice === "cart-preserved") {
    return d.checkout.cartPreserved;
  }
  if (checkout.notice === "scope-mismatch") {
    return d.checkout.scopeMismatch;
  }
  if (checkout.notice === "invalid" && checkout.quote?.outcome === "REJECTED") {
    return d.checkout.rejected;
  }
  if (checkout.notice !== null) {
    return d.checkout[checkout.notice];
  }
  if (checkout.progress !== "idle") {
    return "";
  }
  if (checkout.receipt !== null) {
    return "";
  }
  if (checkout.guarded) {
    return d.checkout.uncertain;
  }
  if (checkout.quote?.outcome === "REJECTED") {
    return d.checkout.rejected;
  }
  return "";
};
const noticeStatus = (checkout: Checkout) =>
  checkout.notice === "uncertain" ||
  checkout.notice === "cart-preserved" ||
  (checkout.notice === null && checkout.guarded)
    ? "warning"
    : "error";

const ReceiptHeader = ({
  checkout,
  dictionary: d,
  locale,
  result,
}: {
  checkout: Checkout;
  dictionary: Dictionary;
  locale: string;
  result: NonNullable<Checkout["receipt"]>;
}) => {
  const { receipt } = result;
  const date = receiptDate(receipt?.createdAt, locale);
  return (
    <section className="flex flex-col gap-3 rounded-xs border border-border-secondary p-4">
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-xl font-bold">
            {d.checkout.orderNumber}: {result.orderNumber}
          </h2>
          {date !== null && <p className="text-sm text-fg-secondary">{date}</p>}
        </div>
        {result.status !== null && (
          <Badge size="md" variant={result.status === "CANCELLED" ? "danger" : "info"}>
            {d.checkout.statuses[result.status]}
          </Badge>
        )}
      </div>
      {receipt?.contact !== null && receipt?.contact !== undefined && (
        <p className="text-sm text-fg-secondary">
          {d.checkout.email}: {receipt.contact.email}
        </p>
      )}
      {(receipt === null || receipt === undefined) && checkout.progress !== "recovery" && (
        <div>
          <Button
            disabled={checkout.progress !== "idle"}
            onClick={() => checkout.recover()}
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {d.checkout.loadReceipt}
          </Button>
        </div>
      )}
    </section>
  );
};
const checkoutNeedsBackLink = (checkout: Checkout) =>
  checkout.cart === null ||
  checkout.cart.entries.length === 0 ||
  checkout.guarded ||
  checkout.notice === "storage";

const ConfirmedCheckout = ({
  checkout,
  dictionary: d,
  locale,
  options,
}: {
  checkout: Checkout;
  dictionary: Dictionary;
  locale: string;
  options: ReadyOptions;
}) => {
  const router = useRouter();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const result = checkout.receipt;
  if (result === null) {
    return null;
  }
  const { receipt } = result;
  const shipping = options.shippingMethods.find((method) => method.id === receipt?.shippingMethod);
  const home = `/${locale}`;
  const notice = noticeText(checkout, d);
  return (
    <article className="mx-auto flex w-full max-w-n1-product-content flex-col items-center gap-5 p-5">
      <div
        aria-live="polite"
        className="flex w-full flex-col gap-1 rounded-xs border border-border-success bg-bg-success/15 p-4"
      >
        <h1 className="text-lg font-semibold leading-7" ref={heading} tabIndex={-1}>
          {d.checkout.confirmed}
        </h1>
        <p className="text-sm text-fg-secondary">{d.checkout.thankYou}</p>
      </div>
      <div className="flex w-full max-w-3xl flex-col gap-5">
        <ReceiptHeader checkout={checkout} dictionary={d} locale={locale} result={result} />
        <section className="flex flex-col gap-4 rounded-xs border border-border-secondary p-4">
          <h2 className="text-lg font-semibold">{d.checkout.orderItems}</h2>
          <CheckoutItems
            currency={result.scope.currency}
            dictionary={d}
            entries={checkout.receiptEntries}
            imageHosts={checkout.cart?.imageHosts ?? []}
            locale={locale}
            result={result}
          />
        </section>
        {receipt?.deliveryAddress !== null && receipt?.deliveryAddress !== undefined && (
          <section className="flex flex-col gap-4 rounded-xs border border-border-secondary p-4">
            <h2 className="text-lg font-semibold">{d.checkout.deliveryAddress}</h2>
            <div className="text-sm text-fg-secondary">
              {receipt.contact !== null && <p>{receipt.contact.name}</p>}
              <p>{receipt.deliveryAddress.street}</p>
              <p>
                {receipt.deliveryAddress.city}, {receipt.deliveryAddress.postalCode}
              </p>
              <p>{receipt.deliveryAddress.country}</p>
            </div>
          </section>
        )}
        {shipping !== undefined && (
          <section className="flex flex-col gap-4 rounded-xs border border-border-secondary p-4">
            <h2 className="text-lg font-semibold">{d.checkout.shipping}</h2>
            <p className="text-sm text-fg-secondary">{shipping.title}</p>
          </section>
        )}
        <section className="flex flex-col gap-4 rounded-xs border border-border-secondary p-4">
          <h2 className="text-lg font-semibold">{d.checkout.priceSummary}</h2>
          <CheckoutTotals
            actions={
              <LinkButton
                as={NextLink}
                block
                href={home}
                onClick={(event) => {
                  event.preventDefault();
                  checkout.dismiss(() => router.push(home));
                }}
                size="md"
                theme="solid"
                variant="secondary"
              >
                {d.shopping.backHome}
              </LinkButton>
            }
            currency={result.scope.currency}
            dictionary={d}
            locale={locale}
            result={result}
          />
        </section>
        {notice !== "" && (
          <StatusText align="start" showIcon status={noticeStatus(checkout)}>
            {notice}
          </StatusText>
        )}
      </div>
    </article>
  );
};

const CheckoutActions = ({
  checkout,
  dictionary: d,
  disabled,
  locale,
}: {
  checkout: Checkout;
  dictionary: Dictionary;
  disabled: boolean;
  locale: string;
}) => {
  const pending = checkout.progress !== "idle";
  const confirming = checkout.quote?.outcome === "VALID";
  const pendingLabel = checkout.progress === "place" ? d.checkout.sending : d.checkout.checking;
  const actionLabel = confirming ? d.checkout.confirm : d.checkout.verify;
  const submit = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const wasPending = useRef(pending);
  useEffect(() => {
    const completed = wasPending.current && !pending;
    wasPending.current = pending;
    if (!completed) {
      return;
    }
    const requested = restoreFocus.current;
    restoreFocus.current = false;
    const button = submit.current;
    if (
      requested &&
      button !== null &&
      button.isConnected &&
      !button.disabled &&
      document.activeElement === document.body
    ) {
      button.focus();
    }
  }, [pending]);
  return (
    <div className="grid grid-cols-2 gap-2">
      {pending ? (
        <Button block disabled size="md" theme="solid" type="button" variant="secondary">
          {d.checkout.back}
        </Button>
      ) : (
        <LinkButton
          as={NextLink}
          block
          href={`/${locale}/kosik`}
          size="md"
          theme="solid"
          variant="secondary"
        >
          {d.checkout.back}
        </LinkButton>
      )}
      <Button
        aria-busy={pending}
        aria-label={pending ? pendingLabel : actionLabel}
        block
        disabled={disabled || pending}
        isLoading={pending}
        onClick={() => {
          restoreFocus.current = submit.current?.form?.contains(document.activeElement) ?? false;
        }}
        ref={submit}
        size="md"
        theme="solid"
        type="submit"
        variant="primary"
      >
        {pending && <span className="sr-only xl:not-sr-only">{pendingLabel}</span>}
        {!pending && confirming && d.checkout.confirm}
        {!pending && !confirming && (
          <>
            <span className="xl:hidden">{d.checkout.verifyShort}</span>
            <span className="hidden xl:inline">{d.checkout.verify}</span>
          </>
        )}
      </Button>
    </div>
  );
};

const ReadyCheckout = ({
  dictionary: d,
  locale,
  options,
}: {
  dictionary: Dictionary;
  locale: string;
  options: ReadyOptions;
}) => {
  const checkout = useCheckout(options, locale);
  const [shippingId, setShippingId] = useState<string | null>(
    options.shippingMethods[0]?.id ?? null,
  );
  const method = options.shippingMethods.find((item) => item.id === shippingId);
  const pending = checkout.progress !== "idle";
  const notice = noticeText(checkout, d);
  if (checkout.receipt !== null) {
    return (
      <ConfirmedCheckout checkout={checkout} dictionary={d} locale={locale} options={options} />
    );
  }
  let body;
  if (!checkout.guardLoaded || checkout.cart?.loaded !== true) {
    body = <output>{d.shopping.loading}</output>;
  } else if (checkout.guarded) {
    body = (
      <div className="flex flex-col items-start gap-4">
        {notice !== "" && (
          <StatusText align="start" showIcon status={noticeStatus(checkout)}>
            {notice}
          </StatusText>
        )}
        <Button
          disabled={pending}
          isLoading={pending}
          loadingText={d.checkout.checking}
          onClick={() => checkout.recover()}
          size="md"
          theme="solid"
          variant="secondary"
        >
          {d.checkout.checkResult}
        </Button>
      </div>
    );
  } else if (checkout.cart.error || checkout.notice === "storage") {
    body = (
      <StatusText align="start" showIcon status="error">
        {d.checkout.storage}
      </StatusText>
    );
  } else if (checkout.cart.scope === null) {
    body = (
      <StatusText align="start" showIcon status="error">
        {d.checkout.scopeMismatch}
      </StatusText>
    );
  } else if (checkout.cart.entries.length === 0) {
    return <EmptyCartView dictionary={d} locale={locale} />;
  } else {
    body = (
      <form
        action="/api/checkout"
        method="post"
        onInvalidCapture={(event) => {
          event.preventDefault();
          event.currentTarget.querySelector<HTMLInputElement>("input:invalid")?.focus();
        }}
        onSubmit={(event) => {
          event.preventDefault();
          checkout.submit(new FormData(event.currentTarget), method);
        }}
      >
        <noscript>
          <p>{d.auth.javascriptRequired}</p>
        </noscript>
        <div className="grid min-w-0 items-start gap-8 md:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-5">
            <CheckoutFields
              countryCodes={options.countryCodes}
              dictionary={d}
              disabled={pending}
              locale={locale}
              onEdit={checkout.handleEdit}
            />
            <CheckoutShipping
              dictionary={d}
              disabled={pending}
              locale={locale}
              onChange={(value) => {
                setShippingId(value);
                checkout.handleEdit();
              }}
              options={options}
              value={shippingId}
            />
            <section className="flex flex-col gap-4 rounded-xs border border-border-secondary bg-fill-surface p-4">
              <h2 className="text-lg font-semibold">{d.payment}</h2>
              <p className="text-sm text-fg-secondary">{d.checkout.paymentNote}</p>
            </section>
            {options.countryCodes.length === 0 && <p role="alert">{d.checkout.noCountries}</p>}
          </div>
          <section className="n1-checkout-totals flex min-w-0 flex-col gap-4 rounded-xs border border-border-secondary bg-fill-surface p-4">
            <h2 className="text-lg font-semibold">{d.checkout.summary}</h2>
            <CheckoutItems
              currency={options.scope.currency}
              dictionary={d}
              entries={checkout.cart.entries}
              imageHosts={checkout.cart.imageHosts}
              locale={locale}
              result={checkout.quote}
            />
            <hr className="border-0 border-t border-border-secondary" />
            <CheckoutTotals
              actions={
                <CheckoutActions
                  checkout={checkout}
                  dictionary={d}
                  disabled={options.countryCodes.length === 0 || method === undefined}
                  locale={locale}
                />
              }
              currency={options.scope.currency}
              dictionary={d}
              locale={locale}
              result={checkout.quote}
            />
            {notice !== "" && (
              <StatusText align="start" showIcon status={noticeStatus(checkout)}>
                {notice}
              </StatusText>
            )}
          </section>
        </div>
      </form>
    );
  }
  return (
    <article className="mx-auto w-full max-w-n1-product-content p-5">
      <h1 className="mb-5 text-2xl leading-normal font-bold">{d.checkout.heading}</h1>
      {body}
      {checkoutNeedsBackLink(checkout) && (
        <div className="mt-5">
          <LinkButton
            as={NextLink}
            href={`/${locale}/kosik`}
            size="md"
            theme="outlined"
            variant="secondary"
          >
            {d.cart}
          </LinkButton>
        </div>
      )}
    </article>
  );
};

export const CheckoutView = ({
  dictionary: d,
  locale,
  options,
}: {
  dictionary: Dictionary;
  locale: string;
  options: CheckoutOptions;
}) => {
  const router = useRouter();
  if (options.state === "ready") {
    return <ReadyCheckout dictionary={d} locale={locale} options={options} />;
  }
  return (
    <article className="mx-auto flex max-w-n1-product-content flex-col items-start gap-5 p-5">
      <h1 className="text-2xl leading-normal font-bold">{d.checkout.heading}</h1>
      <output>{d.checkout.unavailable}</output>
      <Button onClick={() => router.refresh()} size="md" theme="outlined" variant="secondary">
        {d.contact.retry}
      </Button>
      <LinkButton
        as={NextLink}
        href={`/${locale}/kosik`}
        size="md"
        theme="solid"
        variant="secondary"
      >
        {d.checkout.back}
      </LinkButton>
    </article>
  );
};
