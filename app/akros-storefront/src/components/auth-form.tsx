"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@techsio/ui-kit/atoms/button";
import { FormCheckbox } from "@techsio/ui-kit/molecules/form-checkbox";
import { FormInput } from "@techsio/ui-kit/molecules/form-input";

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
  const result = (await response.json()) as { message?: string; outcome?: string };
  if (!response.ok) throw new Error(result.message ?? "Účet je dočasně nedostupný.");
  return result;
}

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    setPending(true);
    setError("");
    try {
      const result = await submitAccount(form, "login");
      if (result.outcome !== "SESSION_CREATED") throw new Error("Přihlášení nebylo potvrzeno.");
      form.reset();
      router.push("/muj-ucet");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Přihlášení se nepodařilo.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form action="/api/ontos/account" className="akros-auth-form" method="post" onSubmit={login}>
      <FormInput
        autoComplete="username"
        id="login-email"
        name="email"
        label="Přihlašovací e-mail"
        required
        size="sm"
        type="email"
      />
      <FormInput
        autoComplete="current-password"
        id="login-password"
        name="password"
        label="Heslo"
        required
        size="sm"
        type="password"
      />
      <div className="akros-auth-form__row">
        <FormCheckbox name="rememberMe" label="Zapamatovat si mě" size="sm" />
      </div>
      <Button block disabled={pending} size="md" type="submit" variant="primary">
        {pending ? "Přihlašuji…" : "Přihlásit se"}
      </Button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

export function RegistrationForm() {
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
      setError("Hesla se neshodují.");
      return;
    }
    requestId.current ??= crypto.randomUUID();
    setPending(true);
    setError("");
    try {
      const result = await submitAccount(form, "register", requestId.current);
      if (result.outcome !== "ENROLLMENT_STARTED") throw new Error("Registrace nebyla přijata.");
      form.reset();
      setSubmitted(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Registrace se nepodařila.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form action="/api/ontos/account" className="akros-auth-form" method="post" onSubmit={register}>
      <div className="akros-form-grid">
        <FormInput
          autoComplete="given-name"
          id="register-first-name"
          name="firstName"
          label="Jméno"
          required
          size="sm"
          type="text"
        />
        <FormInput
          autoComplete="family-name"
          id="register-last-name"
          name="lastName"
          label="Příjmení"
          required
          size="sm"
          type="text"
        />
        <FormInput
          autoComplete="username"
          id="register-email"
          name="email"
          label="E-mailová adresa"
          required
          size="sm"
          type="email"
        />
        <FormInput
          autoComplete="tel"
          id="register-phone"
          name="phone"
          label="Telefonní číslo"
          required
          size="sm"
          type="tel"
        />
        <FormInput
          autoComplete="new-password"
          id="register-password"
          name="password"
          label="Heslo (minimálně 12 znaků)"
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
          label="Potvrzení hesla"
          minLength={12}
          {...{ passwordrules: "minlength: 12;" }}
          required
          size="sm"
          type="password"
        />
      </div>
      <FormCheckbox
        name="privacyConsent"
        label="Souhlasím s obchodními podmínkami a zásadami zpracování osobních údajů"
        required
        size="sm"
      />
      <Button disabled={pending || submitted} size="md" type="submit" variant="primary">
        {pending ? "Vytvářím účet…" : "Vytvořit účet"}
      </Button>
      {error && <p role="alert">{error}</p>}
      {submitted && (
        <output className="akros-form-success">
          Registrace byla přijata. Potvrďte svůj e-mail odkazem v doručené zprávě. Přihlášení bude
          dostupné po dokončení registrace.
        </output>
      )}
    </form>
  );
}
