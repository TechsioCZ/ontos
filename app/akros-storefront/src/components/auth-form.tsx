"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useDictionary, useStoreHref } from "@/ontos/market-context";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { FormCheckbox } from "@techsio/ui-kit/molecules/form-checkbox";
import { FormInput } from "@techsio/ui-kit/molecules/form-input";
import StoreLink from "@/components/store-link";
import { VerificationResendForm } from "@/components/verification-resend-form";
import type { AccountSubmissionResponse } from "@/ontos/account";

const isError = (value: unknown): value is Error =>
  value !== null && value !== undefined && Error.prototype.isPrototypeOf(value);

// Keep LinkButton's event handlers inside a client boundary for the auth server pages.
export function AuthPageLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <LinkButton
      as={StoreLink}
      href={href}
      data-sf-auth-link
      theme="borderless"
      variant="secondary"
      size="current"
      className="inline"
    >
      {children}
    </LinkButton>
  );
}

async function submitAccount(
  form: HTMLFormElement,
  operation: "login" | "register",
  requestId?: string,
) {
  const fields = new FormData(form);
  const response = await fetch("/api/ontos/account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...Object.fromEntries(fields),
      operation,
      requestId,
      rememberMe: fields.has("rememberMe"),
      termsAccepted: fields.has("privacyConsent"),
    }),
  });
  const result = (await response.json()) as AccountSubmissionResponse;
  return { ...result, ok: response.ok };
}

export function LoginForm() {
  const router = useRouter();
  const storeHref = useStoreHref();
  const copy = useDictionary().auth;
  const [error, setError] = useState("");
  const [verificationRequired, setVerificationRequired] = useState(false);
  const [pending, setPending] = useState(false);
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    setPending(true);
    setError("");
    setVerificationRequired(false);
    try {
      const result = await submitAccount(form, "login");
      if (!result.ok) {
        setVerificationRequired(result.code === "verification_required");
        setError(result.message ?? copy.accountUnavailable);
        return;
      }
      if (result.outcome !== "SESSION_CREATED") throw new Error(copy.loginNotConfirmed);
      form.reset();
      router.push(storeHref("/dokonceni-registrace"));
      router.refresh();
    } catch (cause) {
      setError(isError(cause) ? cause.message : copy.loginFailed);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <form action="/api/ontos/account" className="sf-auth-form" method="post" onSubmit={login}>
        <FormInput
          autoComplete="username"
          id="login-email"
          name="email"
          label={copy.loginEmail}
          required
          size="sm"
          type="email"
        />
        <FormInput
          autoComplete="current-password"
          id="login-password"
          name="password"
          label={copy.password}
          required
          size="sm"
          type="password"
        />
        <div className="sf-auth-form__row">
          <FormCheckbox name="rememberMe" label={copy.rememberMe} size="sm" />
        </div>
        <Button block disabled={pending} size="md" type="submit" variant="primary">
          {pending ? copy.loggingIn : copy.logIn}
        </Button>
        {error && <p role="alert">{error}</p>}
      </form>
      {verificationRequired && <VerificationResendForm />}
    </>
  );
}

export function RegistrationForm() {
  const copy = useDictionary().auth;
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const requestId = useRef<string | undefined>(undefined);
  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || submitted) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    if (fields.get("password") !== fields.get("passwordConfirmation")) {
      setError(copy.passwordMismatch);
      return;
    }
    requestId.current ??= crypto.randomUUID();
    setPending(true);
    setError("");
    try {
      const result = await submitAccount(form, "register", requestId.current);
      if (!result.ok) throw new Error(result.message ?? copy.accountUnavailable);
      if (result.outcome !== "ENROLLMENT_STARTED") throw new Error(copy.registrationNotAccepted);
      form.reset();
      setSubmitted(true);
    } catch (cause) {
      setError(isError(cause) ? cause.message : copy.registrationFailed);
    } finally {
      setPending(false);
    }
  }

  return (
    <form action="/api/ontos/account" className="sf-auth-form" method="post" onSubmit={register}>
      <div className="sf-form-grid">
        <FormInput
          autoComplete="given-name"
          id="register-first-name"
          name="firstName"
          label={copy.firstName}
          required
          size="sm"
          type="text"
        />
        <FormInput
          autoComplete="family-name"
          id="register-last-name"
          name="lastName"
          label={copy.lastName}
          required
          size="sm"
          type="text"
        />
        <FormInput
          autoComplete="username"
          id="register-email"
          name="email"
          label={copy.email}
          required
          size="sm"
          type="email"
        />
        <FormInput
          autoComplete="tel"
          id="register-phone"
          name="phone"
          label={copy.phone}
          required
          size="sm"
          type="tel"
        />
        <FormInput
          autoComplete="new-password"
          id="register-password"
          name="password"
          label={copy.passwordWithHint}
          minLength={12}
          {...{ passwordrules: "minlength: 12;" }}
          required
          size="sm"
          type="password"
        />
        <FormInput
          autoComplete="new-password"
          id="register-password-confirm"
          name="passwordConfirmation"
          label={copy.passwordConfirmation}
          minLength={12}
          {...{ passwordrules: "minlength: 12;" }}
          required
          size="sm"
          type="password"
        />
      </div>
      <FormCheckbox name="privacyConsent" label={copy.consent} required size="sm" />
      <Button disabled={pending || submitted} size="md" type="submit" variant="primary">
        {pending ? copy.creating : copy.create}
      </Button>
      {error && <p role="alert">{error}</p>}
      {submitted && <output className="sf-form-success">{copy.registrationAccepted}</output>}
    </form>
  );
}
