"use client";

import { useEffect, useRef, useState } from "react";
import { FormCheckbox } from "@techsio/ui-kit/molecules/form-checkbox";
import { Button } from "@techsio/ui-kit/atoms/button";
import { isCustomerNewsletterConsent } from "@/ontos/consent-model";
import type { CustomerNewsletterConsent } from "@/ontos/consent-model";

/** Only an actual owner projection reveals the control; unavailable authorization never becomes a default choice. */
export function CustomerNewsletterConsentForm() {
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
          throw new Error(result.message ?? "Stav souhlasu nelze ověřit v OntOS.");
        }
        return result.consent;
      })
      .then((current) => {
        if (!signal?.aborted) setConsent(current);
      })
      .catch((cause) => {
        if (signal?.aborted) return;
        setConsent(null);
        setError(cause instanceof Error ? cause.message : "Souhlas je dočasně nedostupný.");
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
      noticeAcknowledged: true,
      noticeVersionId: consent.notice.noticeVersionId,
      purposeVersionId: consent.notice.purposeVersionId,
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
      if (
        !response.ok ||
        !isCustomerNewsletterConsent(result.consent) ||
        result.consent.decision !== fields.decision
      ) {
        throw new Error(
          result.message ?? "OntOS nepotvrdil uložení souhlasu. Načtěte aktuální stav znovu.",
        );
      }
      setConsent(result.consent);
      request.current = null;
      setSaved(true);
    } catch (cause) {
      setConsent(null);
      setError(cause instanceof Error ? cause.message : "Změnu souhlasu nelze potvrdit.");
    } finally {
      setPending(false);
    }
  }
  return (
    <section aria-labelledby="newsletter-consent-heading" className="akros-auth-form">
      <h2 id="newsletter-consent-heading">Newsletter</h2>
      {consent ? (
        <>
          <p className="whitespace-pre-wrap" lang={consent.notice.language}>
            {consent.notice.wording}
          </p>
          <p>
            Změnou volby potvrzuji seznámení s uvedenými informacemi. Souhlas je dobrovolný a lze
            jej zde kdykoli odvolat. Nesouvisí s přijetím obchodních podmínek.
          </p>
          <FormCheckbox
            id="account-newsletter"
            name="newsletterConsent"
            label="Souhlasím se zasíláním newsletteru e-mailem"
            size="sm"
            checked={consent.decision === "GRANTED"}
            disabled={pending}
            onCheckedChange={(checked) => void choose(checked)}
          />
          <p>
            Stav v OntOS:{" "}
            {consent.decision === "GRANTED"
              ? "souhlas udělen"
              : consent.decision === "WITHDRAWN"
                ? "souhlas odvolán"
                : "souhlas neudělen"}
            .
          </p>
        </>
      ) : (
        <p>
          {pending
            ? "Načítám aktuální informace z OntOS…"
            : "Bez aktuálního znění a ověřeného stavu nelze souhlas měnit."}
        </p>
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
          Načíst souhlas znovu
        </Button>
      )}
      {saved && <output>Volba byla uložena v OntOS.</output>}
    </section>
  );
}
