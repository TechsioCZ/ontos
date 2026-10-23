"use client";

import { useRef, useState, type FormEvent } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { FormInput } from "@techsio/ui-kit/molecules/form-input";
import { FormTextarea } from "@techsio/ui-kit/molecules/form-textarea";
import type { InquiryKind } from "@/ontos/inquiry-model";

export function ContactForm({
  compact = false,
  kind = "CONTACT",
  productId,
  productName,
}: {
  compact?: boolean;
  kind?: InquiryKind;
  productId?: string;
  productName?: string;
}) {
  const [pending, setPending] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submission = useRef<{ identity: string; requestId: string } | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    const fields = {
      kind,
      name: String(data.get("name") ?? ""),
      email: String(data.get("email") ?? ""),
      subject:
        String(data.get("subject") ?? "").trim() ||
        (kind === "COMPLAINT"
          ? "Podnět k reklamaci"
          : kind === "PRODUCT_QUESTION"
            ? "Dotaz na produkt"
            : "Dotaz z e-shopu"),
      message: String(data.get("message") ?? ""),
      ...(productId ? { productId } : {}),
    };
    const identity = JSON.stringify(fields);
    if (submission.current?.identity !== identity)
      submission.current = { identity, requestId: crypto.randomUUID() };
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/ontos/inquiries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...fields, requestId: submission.current.requestId }),
      });
      const body: unknown = await response.json();
      if (!response.ok)
        throw new Error(
          typeof body === "object" &&
            body !== null &&
            "message" in body &&
            typeof body.message === "string"
            ? body.message
            : "Přijetí dotazu se nepodařilo potvrdit.",
        );
      if (
        typeof body !== "object" ||
        body === null ||
        !("taskId" in body) ||
        typeof body.taskId !== "string"
      )
        throw new Error("Přijetí dotazu nebylo potvrzeno.");
      setTaskId(body.taskId);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Spojení se nezdařilo. Údaje zachovejte a zkuste znovu.",
      );
    } finally {
      setPending(false);
    }
  };
  if (taskId !== null)
    return (
      <output className="akros-form-success">
        Děkujeme. Dotaz je uložen v OntOS pro tým AKROS k vyřízení. Číslo požadavku: {taskId}.
      </output>
    );
  return (
    <form
      className="akros-contact-form"
      action="/api/ontos/inquiries"
      method="post"
      onSubmit={submit}
      aria-busy={pending}
    >
      <fieldset disabled={pending} className="grid gap-4 border-0 p-0">
        <legend className="sr-only">
          {kind === "COMPLAINT" ? "Podnět k reklamaci" : "Kontaktní dotaz"}
        </legend>
        <div className="akros-form-grid">
          <FormInput
            autoComplete="name"
            id={compact ? "faq-name" : "contact-name"}
            label="Jméno"
            name="name"
            maxLength={120}
            required
            size={compact ? "sm" : "md"}
          />
          <FormInput
            autoComplete="email"
            id={compact ? "faq-email" : "contact-email"}
            inputMode="email"
            label="E-mail"
            name="email"
            maxLength={254}
            required
            size={compact ? "sm" : "md"}
            type="email"
          />
        </div>
        {productName && (
          <p>
            Dotaz na produkt: <strong>{productName}</strong>
          </p>
        )}
        {!compact && (
          <FormInput
            id="contact-subject"
            label="Předmět"
            name="subject"
            defaultValue={productName ? `Dotaz na produkt: ${productName}`.slice(0, 160) : ""}
            maxLength={160}
            placeholder="S čím vám můžeme pomoci?"
            size="md"
          />
        )}
        <FormTextarea
          id={compact ? "faq-message" : "contact-message"}
          label="Zpráva"
          name="message"
          maxLength={1500}
          placeholder={
            kind === "COMPLAINT"
              ? "Uveďte číslo objednávky, kód produktu a popis problému."
              : "Popište detail svého požadavku"
          }
          required
          rows={compact ? 4 : 6}
          size={compact ? "sm" : "md"}
        />
        <p>
          Údaje odešleme týmu AKROS v OntOS k vyřízení vašeho dotazu. Nejde o přihlášení k
          newsletteru.
        </p>
        {kind === "COMPLAINT" && (
          <p>
            Odesláním vznikne úkol pro podporu, nikoli automaticky zaevidovaný reklamační případ.
          </p>
        )}
        <Button size={compact ? "md" : undefined} type="submit" variant="primary">
          {pending ? "Odesílání…" : "Odeslat dotaz"}
        </Button>
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
