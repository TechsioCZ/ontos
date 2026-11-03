import { makeProblemDetailsSchema } from "@app/shared-contracts/problem-details";
import { Effect, Schema, flow } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

/** Customer fields only: identity, destination, title and subject belong to the server. */
const InquirySchema = Schema.Struct({
  email: Schema.Trim.check(
    Schema.isMaxLength(254),
    Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u),
  ),
  locale: Schema.Literals(["cs", "en"]),
  message: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1500)),
  name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  phone: Schema.Trim.check(Schema.isMaxLength(40)),
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

export class InquiryFailure extends Schema.TaggedError<InquiryFailure>()("InquiryFailure", {
  reason: Schema.Literals(["invalid", "forbidden", "unavailable", "unconfirmed", "conflict"]),
}) {}

/** Untrusted form data is decoded at the browser/framework channel boundary. */
export const decodeInquiry = flow(
  Schema.decodeUnknownEffect(InquirySchema),
  Effect.mapError(() => new InquiryFailure({ reason: "invalid" })),
);
