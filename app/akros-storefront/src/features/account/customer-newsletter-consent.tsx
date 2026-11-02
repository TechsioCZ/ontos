"use client";

import { useEffect, useRef, useState } from "react";
import { FormCheckbox } from "@techsio/ui-kit/molecules/form-checkbox";
import { Button } from "@techsio/ui-kit/atoms/button";
import { isCustomerNewsletterConsent } from "@/ontos/consent-model";
import type { CustomerNewsletterConsent } from "@/ontos/consent-model";
import { useDictionary } from "@/ontos/market-context";

const isError = (value: unknown): value is Error =>
  value !== null && value !== undefined && Error.prototype.isPrototypeOf(value);

/** Only an actual owner projection reveals the control; unavailable authorization never becomes a default choice. */
export function CustomerNewsletterConsentForm() {
  const copy = useDictionary().account.newsletter;
  const [consent, setConsent] = useState<CustomerNewsletterConsent | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const request = useRef<{ identity: string; requestId: string } | null>(null);
  function load(signal?: AbortSignal) {
    return fetch("/api/ontos/account/consent", { cache: "no-store", signal })
      .then(async (response) => {
        const result = (await response.json()) as { consent?: unknown; message?: string };
        if (!response.ok || !isCustomerNewsletterConsent(result.consent)) {
          throw new Error(result.message ?? copy.unverifiable);
        }
        return result.consent;
      })
      .then((current) => {
        if (!signal?.aborted) setConsent(current);
      })
      .catch((cause) => {
        if (signal?.aborted) return;
        setConsent(null);
        setError(isError(cause) ? cause.message : copy.unavailable);
      })
      .finally(() => {
        if (!signal?.aborted) setPending(false);
      });
  }
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, []);
  async function choose(subscribed: boolean) {
    if (!consent || pending) return;
    const fields = {
      decision: subscribed ? "GRANTED" : "WITHDRAWN",
      noticeAcknowledged: subscribed,
      noticeVersionId: consent.notice.noticeVersionId,
      expectedRevision: consent.revision,
    };
    const identity = JSON.stringify(fields);
    if (request.current?.identity !== identity)
      request.current = { identity, requestId: crypto.randomUUID() };
    setPending(true);
    setSaved(false);
    setError("");
    try {
      const response = await fetch("/api/ontos/account/consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...fields, requestId: request.current.requestId }),
      });
      const result = (await response.json()) as { consent?: unknown; message?: string };
      if (response.status === 409) {
        request.current = null;
        await load();
        setError(result.message ?? copy.changed);
        return;
      }
      if (
        !response.ok ||
        !isCustomerNewsletterConsent(result.consent) ||
        result.consent.decision !== fields.decision
      ) {
        throw new Error(result.message ?? copy.notConfirmed);
      }
      setConsent(result.consent);
      request.current = null;
      setSaved(true);
    } catch (cause) {
      setConsent(null);
      setError(isError(cause) ? cause.message : copy.changeUnconfirmed);
    } finally {
      setPending(false);
    }
  }
  return (
    <section aria-labelledby="newsletter-consent-heading" className="sf-auth-form">
      <h2 id="newsletter-consent-heading">{copy.title}</h2>
      {consent ? (
        <>
          <p className="whitespace-pre-wrap" lang={consent.notice.language}>
            {consent.notice.wording}
          </p>
          <p>{copy.acknowledgement}</p>
          <FormCheckbox
            id="account-newsletter"
            name="newsletterConsent"
            label={copy.label}
            size="sm"
            checked={consent.decision === "GRANTED"}
            disabled={pending}
            onCheckedChange={(checked) => {
              void choose(checked);
            }}
          />
          <p>
            {copy.state}{" "}
            {consent.decision === "GRANTED"
              ? copy.granted
              : consent.decision === "WITHDRAWN"
                ? copy.withdrawn
                : copy.notGranted}
            .
          </p>
        </>
      ) : (
        <p>{pending ? copy.loading : copy.locked}</p>
      )}
      {error && <p role="alert">{error}</p>}
      {!consent && !pending && (
        <Button
          type="button"
          size="sm"
          onClick={() => {
            setPending(true);
            setError("");
            void load();
          }}
        >
          {copy.reload}
        </Button>
      )}
      {saved && <output>{copy.saved}</output>}
    </section>
  );
}
