export type InquiryKind = "CONTACT" | "PRODUCT_QUESTION" | "COMPLAINT";
export interface InquirySubmission {
  requestId: string;
  kind: InquiryKind;
  name: string;
  email: string;
  subject: string;
  message: string;
  productId?: string;
}
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;
/** Only customer-authored fields cross this boundary. Tenant, task owner and product labels are server-owned. */
export function parseInquirySubmission(value: unknown): InquirySubmission | null {
  if (value === null || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const text = (key: string, max: number) =>
    typeof item[key] === "string" && item[key].trim().length > 0 && item[key].trim().length <= max
      ? item[key].trim()
      : null;
  const name = text("name", 120);
  const email = text("email", 254);
  const subject = text("subject", 160);
  const message = text("message", 1500);
  if (
    typeof item.requestId !== "string" ||
    !uuid.test(item.requestId) ||
    !["CONTACT", "PRODUCT_QUESTION", "COMPLAINT"].includes(String(item.kind)) ||
    name === null ||
    email === null ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ||
    subject === null ||
    message === null ||
    (item.productId !== undefined &&
      (typeof item.productId !== "string" || !uuid.test(item.productId))) ||
    (item.kind === "PRODUCT_QUESTION" && item.productId === undefined) ||
    (item.kind !== "PRODUCT_QUESTION" && item.productId !== undefined)
  )
    return null;
  return {
    requestId: item.requestId,
    kind: item.kind as InquiryKind,
    name,
    email,
    subject,
    message,
    ...(typeof item.productId === "string" ? { productId: item.productId } : {}),
  };
}

export function inquiryTaskTitle(inquiry: InquirySubmission): string {
  const label =
    inquiry.kind === "COMPLAINT"
      ? "Podnět k reklamaci"
      : inquiry.kind === "PRODUCT_QUESTION"
        ? "Dotaz na produkt"
        : "Kontaktní dotaz";
  return `${label}: ${inquiry.subject}`.slice(0, 200);
}
