"use client";

import { useRef, useState, type FormEvent } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { FormInput } from "@techsio/ui-kit/molecules/form-input";
import { FormTextarea } from "@techsio/ui-kit/molecules/form-textarea";
import { useBrand } from "@/brand/brand-context";
import type { InquiryKind } from "@/ontos/inquiry-model";
import { useDictionary } from "@/ontos/market-context";
import { marketRequestHeaders } from "@/ontos/market-locale";

const isError = (value: unknown): value is Error =>
  value !== null && value !== undefined && Error.prototype.isPrototypeOf(value);

export function ContactForm({
  compact = false,
  kind = "CONTACT",
  productId,
  productName,
  defaultMessage,
}: {
  compact?: boolean;
  kind?: InquiryKind;
  productId?: string;
  productName?: string;
  /** Prefilled message, e.g. the product and variants a product-question link selected. */
  defaultMessage?: string;
}) {
  const brand = useBrand();
  const copy = useDictionary().contact.form;
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
          ? copy.complaintSubject
          : kind === "PRODUCT_QUESTION"
            ? copy.productSubject
            : copy.defaultSubject),
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
        headers: { "content-type": "application/json", ...marketRequestHeaders() },
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
            : copy.responseUnconfirmed,
        );
      if (
        typeof body !== "object" ||
        body === null ||
        !("taskId" in body) ||
        typeof body.taskId !== "string"
      )
        throw new Error(copy.notConfirmed);
      setTaskId(body.taskId);
    } catch (cause) {
      setError(isError(cause) ? cause.message : copy.connectionFailed);
    } finally {
      setPending(false);
    }
  };
  if (taskId !== null)
    return <output className="sf-form-success">{copy.success(brand.name, taskId)}</output>;
  return (
    <form
      className="sf-contact-form"
      action="/api/ontos/inquiries"
      method="post"
      onSubmit={submit}
      aria-busy={pending}
    >
      <fieldset disabled={pending} className="grid gap-4 border-0 p-0">
        <legend className="sr-only">
          {kind === "COMPLAINT" ? copy.complaintSubject : copy.contactLegend}
        </legend>
        <div className="sf-form-grid">
          <FormInput
            autoComplete="name"
            id={compact ? "faq-name" : "contact-name"}
            label={copy.name}
            name="name"
            maxLength={120}
            required
            size={compact ? "sm" : "md"}
          />
          <FormInput
            autoComplete="email"
            id={compact ? "faq-email" : "contact-email"}
            inputMode="email"
            label={copy.email}
            name="email"
            maxLength={254}
            required
            size={compact ? "sm" : "md"}
            type="email"
          />
        </div>
        {productName && (
          <p>
            {copy.productQuestion} <strong>{productName}</strong>
          </p>
        )}
        {!compact && (
          <FormInput
            id="contact-subject"
            label={copy.subject}
            name="subject"
            defaultValue={productName ? copy.productSubjectValue(productName).slice(0, 160) : ""}
            maxLength={160}
            placeholder={copy.subjectPlaceholder}
            size="md"
          />
        )}
        <FormTextarea
          id={compact ? "faq-message" : "contact-message"}
          label={copy.message}
          name="message"
          defaultValue={defaultMessage?.slice(0, 1500)}
          maxLength={1500}
          placeholder={kind === "COMPLAINT" ? copy.complaintPlaceholder : copy.messagePlaceholder}
          required
          rows={compact ? 4 : 6}
          size={compact ? "sm" : "md"}
        />
        <p>{copy.privacyNote(brand.name)}</p>
        {kind === "COMPLAINT" && <p>{copy.complaintNote}</p>}
        <Button size={compact ? "md" : undefined} type="submit" variant="primary">
          {pending ? copy.sending : copy.submit}
        </Button>
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
