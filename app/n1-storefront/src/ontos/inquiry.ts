import { makeProblemDetailsSchema } from "@app/shared-contracts/problem-details";
import { Effect, Schema, flow } from "effect";
import { getDictionary } from "../i18n";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

/** N1 currently selects a single variant. Never silently truncate a plural/foreign selection. */
export const InquiryProductSchema = Schema.Struct({
  productId: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  variantIds: Schema.Array(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300))).check(
    Schema.isMaxLength(1),
  ),
});
export type InquiryProduct = typeof InquiryProductSchema.Type;

const InquiryProductQuerySchema = Schema.Struct({
  productId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
  variantIds: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
});

/** Repeated IDs, selectors without a product, and unsupported plural selections fail closed. */
export interface InquiryProductQueryInput {
  readonly productId?: string | readonly string[];
  readonly variantIds?: string | readonly string[];
}
export const parseInquiryProductQuery = (
  query: InquiryProductQueryInput,
): { state: "none" } | { state: "invalid" } | { selector: InquiryProduct; state: "product" } => {
  if (!Schema.is(InquiryProductQuerySchema)(query)) {
    return { state: "invalid" };
  }
  if (query.productId === undefined && query.variantIds === undefined) {
    return { state: "none" };
  }
  const selector = {
    productId: query.productId,
    variantIds: query.variantIds === undefined ? [] : query.variantIds.split(","),
  };
  return Schema.is(InquiryProductSchema)(selector)
    ? { selector, state: "product" }
    : { state: "invalid" };
};

/** Customer fields and selectors only: canonical product data and destination belong to the server. */
const InquirySchema = Schema.Struct({
  email: Schema.Trim.check(
    Schema.isMaxLength(254),
    Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u),
  ),
  locale: Schema.Literals(["cs", "en"]),
  message: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1500)),
  name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  phone: Schema.Trim.check(Schema.isMaxLength(40)),
  product: Schema.optionalKey(InquiryProductSchema),
  requestId: Schema.String.check(Schema.isUUID()),
});
export type Inquiry = typeof InquirySchema.Type;
const InquiryReceiptSchema = Schema.Struct({
  taskId: Schema.String.check(Schema.isMinLength(1)),
});
export const InquiryInvalid = makeProblemDetailsSchema("InquiryInvalid", 400);
export const InquiryForbidden = makeProblemDetailsSchema("InquiryForbidden", 403);
export const InquiryUnavailable = makeProblemDetailsSchema("InquiryUnavailable", 503);
export const InquiryUnconfirmed = makeProblemDetailsSchema("InquiryUnconfirmed", 503);

/** Thin framework channel contract; work.tasks remains the business and persistence owner. */
export const InquiryApi = HttpApi.make("N1Inquiry").add(
  HttpApiGroup.make("inquiry").add(
    HttpApiEndpoint.post("submit", "/api/inquiries", {
      error: [InquiryInvalid, InquiryForbidden, InquiryUnavailable, InquiryUnconfirmed],
      payload: InquirySchema,
      success: InquiryReceiptSchema,
    }),
  ),
);

export type InquiryOutcome =
  | { readonly state: "sent"; readonly taskId: string }
  | { readonly state: "invalid" | "forbidden" | "unavailable" | "unconfirmed" };

/**
 * `conflict` and `committed` are the two owner refusals answered by one resend (see `sendInquiry`); they never
 * reach the customer.
 */
export class InquiryFailure extends Schema.TaggedError<InquiryFailure>()("InquiryFailure", {
  reason: Schema.Literals([
    "invalid",
    "forbidden",
    "unavailable",
    "unconfirmed",
    "conflict",
    "committed",
  ]),
}) {}

/** Untrusted form data is decoded at the browser/framework channel boundary. */
export const decodeInquiry = flow(
  Schema.decodeUnknownEffect(InquirySchema),
  Effect.mapError(() => new InquiryFailure({ reason: "invalid" })),
);

export interface InquiryProductContext {
  readonly productId: string;
  readonly productName: string;
  readonly productSlug: string;
  readonly variant?: { readonly id: string; readonly name: string; readonly sku: string };
}

export const inquiryVariantDescription = (
  context: InquiryProductContext | undefined,
  locale: string,
) => {
  const variant = context?.variant;
  return variant === undefined
    ? []
    : [
        `${getDictionary(locale)
          .contact.variantLine.replace("{name}", () => variant.name)
          .replace("{sku}", () => variant.sku)} [${variant.id}]`,
      ];
};

/** Reserve the actual owner description budget for maximum-length contact fields and canonical variant. */
export const inquiryMessageMaximum = (
  context: InquiryProductContext | undefined,
  locale: string,
) => {
  const prefix = [
    "Kontakt: ".length + 120 + " <".length + 254 + ">".length,
    "Telefon: ".length + 40,
    ...inquiryVariantDescription(context, locale).map((line) => line.length),
    0,
  ].reduce((total, length) => total + length + 1, 0);
  return Math.max(0, Math.min(1500, 2000 - prefix));
};
