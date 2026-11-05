"use client";

import { Button } from "@techsio/ui-kit/atoms/button";
import { Link } from "@techsio/ui-kit/atoms/link";
import { FormInput } from "@techsio/ui-kit/molecules/form-input";
import { FormTextarea } from "@techsio/ui-kit/molecules/form-textarea";
import { Effect, Fiber } from "effect";
import { useParams } from "next/navigation";
import type { SubmitEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { inquiryMessageMaximum } from "@/ontos/inquiry";
import type { InquiryOutcome, InquiryProductContext } from "@/ontos/inquiry";
import { inquiryRuntime, startInquirySubmission } from "@/ontos/inquiry-client";
import type { Dictionary } from "@/i18n";
import { inquiryGuardKey, readInquiryBarrier, submitGuardedInquiry } from "./inquiry-guard";

type ContactState = InquiryOutcome["state"] | "idle" | "pending";
type BarrierState = "loading" | "clear" | "blocked" | "unavailable";
const observeBarrier = (accept: (value: BarrierState) => void) =>
  readInquiryBarrier().pipe(
    Effect.match({
      onFailure: (failure) => accept(failure.reason === "blocked" ? "blocked" : "unavailable"),
      onSuccess: (blocked) => accept(blocked ? "blocked" : "clear"),
    }),
  );
const useInquiryBarrier = () => {
  const [barrier, setBarrier] = useState<BarrierState>("loading");
  useEffect(() => {
    const refresh = () => {
      inquiryRuntime.runFork(observeBarrier(setBarrier));
    };
    const changed = (event: StorageEvent) => {
      if (event.key === null || event.key === inquiryGuardKey) {
        refresh();
      }
    };
    refresh();
    window.addEventListener("storage", changed);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("storage", changed);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return {
    barrier,
    refresh: () => {
      inquiryRuntime.runFork(observeBarrier(setBarrier));
    },
  };
};
const visibleContactState = (state: ContactState, barrier: BarrierState): ContactState => {
  if (state === "pending" || state === "sent" || state === "unconfirmed") {
    return state;
  }
  if (barrier === "blocked") {
    return "unconfirmed";
  }
  return barrier === "unavailable" ? "unavailable" : state;
};

/** N1 contact composition with owner-confirmed submission and explicit uncertain outcomes. */
export const ContactView = ({
  dictionary: d,
  question,
}: {
  dictionary: Dictionary;
  question?: { product: InquiryProductContext; state: "ready" } | { state: "unavailable" };
}) => {
  const { locale } = useParams<{ locale: string }>();
  const product = question?.state === "ready" ? question.product : undefined;
  const unavailableProduct = question?.state === "unavailable";
  const defaultMessage =
    product === undefined
      ? undefined
      : [
          d.contact.productLine.replace("{name}", () => product.productName),
          ...(product.variant === undefined
            ? []
            : [
                d.contact.variantLine
                  .replace("{name}", () => product.variant?.name ?? "")
                  .replace("{sku}", () => product.variant?.sku ?? ""),
              ]),
          "",
          d.contact.productQuestionPrompt,
          "",
        ].join("\n");
  const [localState, setLocalState] = useState<ContactState>("idle");
  const { barrier, refresh } = useInquiryBarrier();
  const state = visibleContactState(localState, barrier);
  const active = useRef<Fiber.Fiber<InquiryOutcome> | null>(null);
  useEffect(
    () => () => {
      const fiber = active.current;
      active.current = null;
      if (fiber !== null) {
        inquiryRuntime.runFork(Fiber.interrupt(fiber));
      }
    },
    [],
  );
  const locked =
    unavailableProduct ||
    barrier === "loading" ||
    state === "pending" ||
    state === "sent" ||
    state === "unconfirmed";
  const statusText = unavailableProduct
    ? d.contact.formUnavailable
    : {
        forbidden: d.contact.forbidden,
        idle: "",
        invalid: d.contact.invalid,
        pending: d.contact.submitting,
        sent: d.contact.sent,
        unavailable: d.contact.formUnavailable,
        unconfirmed: d.contact.unconfirmed,
      }[state];
  const buttonText = { pending: d.contact.submitting, unavailable: d.contact.retry };
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (active.current !== null || locked) {
      return;
    }
    const fields = new FormData(event.currentTarget);
    setLocalState("pending");
    const selector =
      product === undefined
        ? undefined
        : {
            productId: product.productId,
            variantIds: product.variant === undefined ? [] : [product.variant.id],
          };
    startInquirySubmission(
      active,
      (result) => {
        setLocalState(result.state);
        refresh();
      },
      submitGuardedInquiry(fields, locale, selector),
    );
  };
  return (
    <article className="mx-auto w-full max-w-n1-content p-10">
      <h1 className="relative text-xl leading-8 font-bold">
        {d.contacts}
        <span aria-hidden="true" className="absolute bottom-0 left-0 h-1 w-24 bg-primary" />
      </h1>
      <section aria-labelledby="returns-heading" className="mt-6 text-center">
        <p className="wrap-break-word">
          {d.contact.email}:{" "}
          <Link href="mailto:eshop@ndistribution.cz">eshop@ndistribution.cz</Link>
        </p>
        <h2 className="mt-n1-contact-address text-md" id="returns-heading">
          {d.contact.returnsHeading}
        </h2>
        <address className="mt-6 not-italic">
          <div className="space-y-2">
            <p className="text-lg font-bold">{d.contactHeading}</p>
            <p>{d.contact.administrativeCentre}</p>
            <p>{d.contact.returnsStreet}</p>
            <p>{d.contact.city}</p>
            <p>{d.contact.country}</p>
          </div>
          <p className="mt-4">
            <span className="font-medium">{d.contact.phone}: </span>
            <Link href="tel:+420244402795">+420 244 402 795</Link>
          </p>
          <div className="mt-4 space-y-2 wrap-break-word">
            <p>
              <span className="font-medium">{d.contact.shop}: </span>
              <Link href="mailto:eshop@ndistribution.cz">eshop@ndistribution.cz</Link>
            </p>
            <p>
              <span className="font-medium">{d.contact.claims}: </span>
              <Link href="mailto:reklamace@ndistribution.cz">reklamace@ndistribution.cz</Link>
            </p>
            <p>
              <span className="font-medium">{d.contact.office}: </span>
              <Link href="mailto:office@ndistribution.cz">office@ndistribution.cz</Link>
            </p>
          </div>
          <div className="mt-8 space-y-2">
            <p className="font-medium">{d.contact.premises}:</p>
            <p>{d.contact.premisesStreet}</p>
            <p>{d.contact.city}</p>
          </div>
        </address>
      </section>
      <section aria-labelledby="contact-form-heading" className="mt-6">
        <h2 className="text-lg font-semibold" id="contact-form-heading">
          {d.contact.formHeading}
        </h2>
        {(state !== "idle" || unavailableProduct) && (
          <output aria-live="polite" className="mt-4 block" id="contact-form-status">
            {statusText}
          </output>
        )}
        <form onSubmit={submit}>
          <fieldset
            aria-busy={state === "pending"}
            aria-describedby={
              state === "idle" && !unavailableProduct ? undefined : "contact-form-status"
            }
            className="mt-6 grid min-w-0 grid-cols-2 gap-4"
            disabled={locked}
          >
            <legend className="sr-only">{d.contact.formHeading}</legend>
            <div className="min-w-0 space-y-4">
              <FormInput
                autoComplete="name"
                disabled={locked}
                id="contact-name"
                label={d.contact.fullName}
                maxLength={120}
                name="name"
                required
                size="md"
              />
              <FormInput
                autoComplete="tel"
                disabled={locked}
                id="contact-phone"
                label={d.contact.phone}
                maxLength={40}
                name="phone"
                size="md"
                type="tel"
              />
              <FormInput
                autoComplete="email"
                disabled={locked}
                id="contact-email"
                label={d.contact.email}
                maxLength={254}
                name="email"
                required
                size="md"
                type="email"
              />
            </div>
            <div className="min-w-0 space-y-3">
              <FormTextarea
                defaultValue={defaultMessage}
                disabled={locked}
                id="contact-message"
                label={d.contact.message}
                maxLength={inquiryMessageMaximum(product, locale)}
                name="message"
                required
                resize="none"
                rows={5}
                size="md"
              />
              <Button
                block
                disabled={locked}
                size="md"
                theme="solid"
                type="submit"
                variant="secondary"
              >
                {state === "pending" || state === "unavailable"
                  ? buttonText[state]
                  : d.contact.send}
              </Button>
            </div>
          </fieldset>
        </form>
      </section>
    </article>
  );
};
