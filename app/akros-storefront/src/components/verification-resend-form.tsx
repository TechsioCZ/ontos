"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { FormInput } from "@techsio/ui-kit/molecules/form-input";

const isError = (value: unknown): value is Error =>
  value !== null && value !== undefined && Error.prototype.isPrototypeOf(value);

export function VerificationResendForm() {
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function resend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const email = new FormData(event.currentTarget).get("email");
    setPending(true);
    setSent(false);
    setError("");
    try {
      const response = await fetch("/api/ontos/account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "resend-verification", email }),
      });
      const result = (await response.json()) as { message?: string; outcome?: string };
      if (!response.ok)
        throw new Error(result.message ?? "Ověřovací e-mail se nepodařilo odeslat.");
      if (result.outcome !== "EMAIL_VERIFICATION_STARTED")
        throw new Error("Odeslání ověřovacího e-mailu nebylo potvrzeno.");
      setSent(true);
    } catch (cause) {
      setError(isError(cause) ? cause.message : "Ověřovací e-mail je dočasně nedostupný.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="akros-auth-form" onSubmit={resend}>
      <FormInput
        autoComplete="email"
        id="verification-resend-email"
        label="E-mail pro ověření"
        maxLength={320}
        name="email"
        required
        size="sm"
        type="email"
      />
      <Button disabled={pending} size="md" type="submit" variant="secondary">
        {pending ? "Odesílám…" : "Poslat ověřovací e-mail znovu"}
      </Button>
      {error && <p role="alert">{error}</p>}
      {sent && (
        <output>
          Pokud účet s tímto e-mailem čeká na ověření, poslali jsme nový ověřovací odkaz.
          Zkontrolujte také nevyžádanou poštu.
        </output>
      )}
    </form>
  );
}
