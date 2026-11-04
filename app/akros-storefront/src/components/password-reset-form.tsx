"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { FormInput } from "@techsio/ui-kit/molecules/form-input";
import { AuthPageLink } from "@/components/auth-form";
import type { AccountSubmissionResponse } from "@/ontos/account";
import { useDictionary } from "@/ontos/market-context";
import { marketRequestHeaders } from "@/ontos/market-locale";

const isError = (value: unknown): value is Error =>
  value !== null && value !== undefined && Error.prototype.isPrototypeOf(value);

async function postAccount(body: Record<string, unknown>) {
  const response = await fetch("/api/ontos/account", {
    method: "POST",
    headers: { "content-type": "application/json", ...marketRequestHeaders() },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as AccountSubmissionResponse;
  return { ...result, ok: response.ok };
}

export function PasswordRequestForm() {
  const copy = useDictionary().auth;
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function request(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || sent) return;
    const email = String(new FormData(event.currentTarget).get("email") ?? "");
    setPending(true);
    setError("");
    try {
      const result = await postAccount({ operation: "request-password-reset", email });
      if (!result.ok) throw new Error(result.message ?? copy.accountUnavailable);
      if (result.outcome !== "ACCOUNT_RECOVERY_STARTED") throw new Error(copy.passwordResetFailed);
      setSent(true);
    } catch (cause) {
      setError(isError(cause) ? cause.message : copy.passwordResetFailed);
    } finally {
      setPending(false);
    }
  }

  return (
    <form action="/api/ontos/account" className="sf-auth-form" method="post" onSubmit={request}>
      <FormInput
        autoComplete="username"
        id="reset-request-email"
        name="email"
        label={copy.loginEmail}
        required
        size="sm"
        type="email"
      />
      <Button block disabled={pending || sent} size="md" type="submit" variant="primary">
        {pending ? copy.sendingResetLink : copy.sendResetLink}
      </Button>
      {error && <p role="alert">{error}</p>}
      {sent && <output className="sf-form-success">{copy.passwordRequestSent}</output>}
    </form>
  );
}

export function PasswordResetForm() {
  const copy = useDictionary().auth;
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function reset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || done) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const newPassword = String(fields.get("newPassword") ?? "");
    const passwordConfirmation = String(fields.get("passwordConfirmation") ?? "");
    if (newPassword !== passwordConfirmation) {
      setError(copy.passwordMismatch);
      return;
    }
    setPending(true);
    setError("");
    try {
      const result = await postAccount({
        operation: "reset-password",
        newPassword,
        passwordConfirmation,
      });
      if (!result.ok) throw new Error(result.message ?? copy.passwordResetFailed);
      if (result.outcome !== "PASSWORD_RESET_COMPLETED") throw new Error(copy.passwordResetFailed);
      form.reset();
      setDone(true);
    } catch (cause) {
      setError(isError(cause) ? cause.message : copy.passwordResetFailed);
    } finally {
      setPending(false);
    }
  }

  return (
    <form action="/api/ontos/account" className="sf-auth-form" method="post" onSubmit={reset}>
      <FormInput
        autoComplete="new-password"
        id="reset-new-password"
        name="newPassword"
        label={copy.passwordWithHint}
        minLength={12}
        {...{ passwordrules: "minlength: 12;" }}
        required
        size="sm"
        type="password"
      />
      <FormInput
        autoComplete="new-password"
        id="reset-password-confirm"
        name="passwordConfirmation"
        label={copy.passwordConfirmation}
        minLength={12}
        {...{ passwordrules: "minlength: 12;" }}
        required
        size="sm"
        type="password"
      />
      <Button block disabled={pending || done} size="md" type="submit" variant="primary">
        {pending ? copy.savingPassword : copy.savePassword}
      </Button>
      {error && <p role="alert">{error}</p>}
      {done && <output className="sf-form-success">{copy.passwordResetDone}</output>}
      {done && (
        <p>
          <AuthPageLink href="/prihlaseni">{copy.logIn}</AuthPageLink>
        </p>
      )}
    </form>
  );
}
