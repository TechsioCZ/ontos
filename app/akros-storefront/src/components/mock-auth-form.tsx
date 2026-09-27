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
      className="akros-auth-form"
      onSubmit={(event) => {
        event.preventDefault();
        router.push("/muj-ucet");
      }}
    >
      <FormInput
        autoComplete="email"
        id="login-email"
        label="Přihlašovací e-mail"
        required
        size="sm"
        type="email"
      />
      <FormInput
        autoComplete="current-password"
        id="login-password"
        label="Heslo"
        required
        size="sm"
        type="password"
      />
      <div className="akros-auth-form__row">
        <FormCheckbox label="Zapamatovat si mě" size="sm" />
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
      className="akros-auth-form"
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
      }}
    >
      <div className="akros-form-grid">
        <FormInput
          autoComplete="given-name"
          id="register-first-name"
          label="Jméno"
          required
          size="sm"
        />
        <FormInput
          autoComplete="family-name"
          id="register-last-name"
          label="Příjmení"
          required
          size="sm"
        />
        <FormInput
          autoComplete="email"
          id="register-email"
          label="E-mailová adresa"
          required
          size="sm"
          type="email"
        />
        <FormInput
          autoComplete="tel"
          id="register-phone"
          label="Telefonní číslo"
          required
          size="sm"
          type="tel"
        />
        <FormInput
          autoComplete="new-password"
          id="register-password"
          label="Heslo (minimálně 8 znaků)"
          minLength={8}
          required
          size="sm"
          type="password"
        />
        <FormInput
          autoComplete="new-password"
          id="register-password-confirm"
          label="Potvrzení hesla"
          minLength={8}
          required
          size="sm"
          type="password"
        />
      </div>
      <FormCheckbox
        label="Souhlasím s obchodními podmínkami a zásadami zpracování osobních údajů"
        required
        size="sm"
      />
      <FormCheckbox
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
