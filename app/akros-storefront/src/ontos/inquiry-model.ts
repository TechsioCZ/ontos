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
/** Identity of the product the owner resolved for a product question. Never taken from the browser. */
export interface InquiryProduct {
  productId: string;
  productName: string;
  productSlug: string;
}
/** Payload of the Work Tasks action `work.tasks.submit-storefront-inquiry`. The owner refuses any other field. */
export interface InquiryActionPayload {
  title: string;
  description: string;
  storefrontInquiry: InquirySubmission & Partial<InquiryProduct>;
}
// A versioned RFC UUID, as the task owner requires for the request id that deduplicates a submission.
const uuid = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu;
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
      (typeof item.productId !== "string" ||
        item.productId.trim().length === 0 ||
        item.productId.length > 300)) ||
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
  return `${label}: ${inquiry.subject}`;
}

const within = (value: string, min: number, max: number) =>
  value.length >= min && value.length <= max;

/**
 * The complete action payload, or null when a text would exceed the owner's limit (title 200, description 2000,
 * product labels 300). Nothing is clipped: the customer is asked to shorten the input instead.
 */
export function inquiryActionPayload(
  inquiry: InquirySubmission,
  owned?: InquiryProduct,
): InquiryActionPayload | null {
  if ((inquiry.productId === undefined) !== (owned === undefined)) return null;
  const product =
    owned === undefined
      ? undefined
      : {
          productId: owned.productId,
          productName: owned.productName.trim(),
          productSlug: owned.productSlug.trim(),
        };
  const title = inquiryTaskTitle(inquiry);
  const description = [
    `Kontakt: ${inquiry.name} <${inquiry.email}>`,
    ...(product ? [`Produkt: ${product.productName}`] : []),
    "",
    inquiry.message,
  ].join("\n");
  if (
    !within(title, 1, 200) ||
    !within(description, 1, 2000) ||
    (product !== undefined &&
      !(
        within(product.productId, 1, 300) &&
        within(product.productName, 1, 300) &&
        within(product.productSlug, 1, 300)
      ))
  )
    return null;
  return {
    title,
    description,
    storefrontInquiry: {
      requestId: inquiry.requestId,
      kind: inquiry.kind,
      name: inquiry.name,
      email: inquiry.email,
      subject: inquiry.subject,
      message: inquiry.message,
      ...product,
    },
  };
}
