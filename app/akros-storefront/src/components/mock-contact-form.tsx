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
          placeholder="Jan Novák"
          required
          size="md"
        />
        <FormInput
          autoComplete="email"
          id={compact ? "faq-email" : "contact-email"}
          inputMode="email"
          label="E-mail"
          name="email"
          placeholder="jan.novak@akros.cz"
          required
          size="md"
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
      <FormTextarea
        id={compact ? "faq-message" : "contact-message"}
        label="Zpráva"
        name="message"
        placeholder="Popište detail vašeho požadavku"
        required
        rows={compact ? 4 : 6}
        size="md"
      />
      <Button type="submit" variant="primary">
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
