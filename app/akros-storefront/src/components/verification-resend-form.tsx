"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { FormInput } from "@/components/form-controls";
import { useDictionary } from "@/ontos/market-context";
import { marketRequestHeaders } from "@/ontos/market-locale";

const isError = (value: unknown): value is Error =>
  value !== null && value !== undefined && Error.prototype.isPrototypeOf(value);

export function VerificationResendForm() {
  const copy = useDictionary().auth.resend;
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
        headers: { "content-type": "application/json", ...marketRequestHeaders() },
        body: JSON.stringify({ operation: "resend-verification", email }),
      });
      const result = (await response.json()) as { message?: string; outcome?: string };
      if (!response.ok) throw new Error(result.message ?? copy.failed);
      if (result.outcome !== "EMAIL_VERIFICATION_STARTED") throw new Error(copy.notConfirmed);
      setSent(true);
    } catch (cause) {
      setError(isError(cause) ? cause.message : copy.unavailable);
    } finally {
      setPending(false);
    }
  }

  return (
    <form action="/api/ontos/account" className="sf-auth-form" method="post" onSubmit={resend}>
      <FormInput
        autoComplete="email"
        id="verification-resend-email"
        label={copy.label}
        maxLength={320}
        name="email"
        required
        size="sm"
        type="email"
      />
      <Button disabled={pending} size="md" type="submit" variant="secondary">
        {pending ? copy.sending : copy.submit}
      </Button>
      {error && <p role="alert">{error}</p>}
      {sent && <output>{copy.sent}</output>}
    </form>
  );
}
