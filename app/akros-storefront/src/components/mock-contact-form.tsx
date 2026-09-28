"use client";

import { useState } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { FormInput } from "@techsio/ui-kit/molecules/form-input";
import { FormTextarea } from "@techsio/ui-kit/molecules/form-textarea";

export function MockContactForm({ compact = false }: { compact?: boolean }) {
  const [submitted, setSubmitted] = useState(false);

  return (
    <form
      className="akros-contact-form"
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
      }}
    >
      <div className="akros-form-grid">
        <FormInput
          autoComplete="name"
          id={compact ? "faq-name" : "contact-name"}
          label="Jméno"
          name="name"
          placeholder={compact ? "Zadejte celé jméno" : "Jan Novák"}
          required
          size={compact ? "sm" : "md"}
        />
        <FormInput
          autoComplete="email"
          id={compact ? "faq-email" : "contact-email"}
          inputMode="email"
          label="E-mail"
          name="email"
          placeholder={compact ? "např. jmeno@firma.cz" : "jan.novak@akros.cz"}
          required
          size={compact ? "sm" : "md"}
          type="email"
        />
      </div>
      {!compact && (
        <FormInput
          id="contact-subject"
          label="Předmět"
          name="subject"
          placeholder="S čím vám můžeme pomoci?"
          size="md"
        />
      )}
      <div className={compact ? "akros-contact-form__message--compact" : undefined}>
        <FormTextarea
          id={compact ? "faq-message" : "contact-message"}
          label="Zpráva"
          name="message"
          placeholder={
            compact ? "Zde podrobně popište váš dotaz…" : "Popište detail vašeho požadavku"
          }
          required
          rows={compact ? 4 : 6}
          size={compact ? "sm" : "md"}
        />
      </div>
      <Button size={compact ? "md" : undefined} type="submit" variant="primary">
        Odeslat dotaz
      </Button>
      {submitted && (
        <output className="akros-form-success">
          Děkujeme. V této ukázce byl formulář zpracován pouze lokálně.
        </output>
      )}
    </form>
  );
}
