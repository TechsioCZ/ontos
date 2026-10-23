"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@techsio/ui-kit/atoms/button";
import { FormCheckbox } from "@techsio/ui-kit/molecules/form-checkbox";
import { FormInput } from "@techsio/ui-kit/molecules/form-input";

export function MockLoginForm() {
  const router = useRouter();

  return (
    <form
      action="/prihlaseni"
      className="akros-auth-form"
      method="post"
      onSubmit={(event) => {
        event.preventDefault();
        router.push("/muj-ucet");
      }}
    >
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
        <a href="#login-password">Zapomenuté heslo?</a>
      </div>
      <Button block size="md" type="submit" variant="primary">
        Přihlásit se
      </Button>
    </form>
  );
}

export function MockRegistrationForm() {
  const [submitted, setSubmitted] = useState(false);

  return (
    <form
      action="/registrace"
      className="akros-auth-form"
      method="post"
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
      }}
    >
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
      <FormCheckbox
        name="newsletter"
        label="Chci odebírat newsletter s akčními nabídkami nerezového materiálu"
        size="sm"
      />
      <Button size="md" type="submit" variant="primary">
        Vytvořit účet
      </Button>
      {submitted && (
        <output className="akros-form-success">
          Ukázkový účet byl vytvořen pouze pro tuto stránku.
        </output>
      )}
    </form>
  );
}
