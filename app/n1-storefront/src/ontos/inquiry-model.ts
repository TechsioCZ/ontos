import { SubmitStorefrontInquiryPayloadSchema } from "@app/work-tasks/contracts/submit-storefront-inquiry";
import type { SubmitStorefrontInquiryPayload } from "@app/work-tasks/contracts/submit-storefront-inquiry";
import { Effect, Schema } from "effect";
import { getDictionary } from "../i18n";
import type { ProductDetailModel } from "./catalog-model";
import type { Inquiry, InquiryProduct, InquiryProductContext } from "./inquiry";
import {
  InquiryFailure,
  InquiryProductSchema,
  inquiryMessageMaximum,
  inquiryVariantDescription,
} from "./inquiry";

export { decodeInquiry, InquiryFailure } from "./inquiry";

/** Only the already market-scoped public reader supplies canonical names and active variants. */
export const resolveInquiryProduct = (
  selector: InquiryProduct,
  products: readonly ProductDetailModel[],
): Effect.Effect<InquiryProductContext, InquiryFailure> => {
  if (!Schema.is(InquiryProductSchema)(selector)) {
    return Effect.fail(new InquiryFailure({ reason: "invalid" }));
  }
  const product = products.find((item) => item.id === selector.productId);
  const [variantId] = selector.variantIds;
  const variant = product?.variants.find((item) => item.id === variantId);
  if (product === undefined || (variantId !== undefined && variant === undefined)) {
    return Effect.fail(new InquiryFailure({ reason: "invalid" }));
  }
  const context: InquiryProductContext = {
    productId: product.id,
    productName: product.name,
    productSlug: product.slug,
  };
  if (variant !== undefined) {
    return Effect.succeed({
      ...context,
      variant: { id: variant.id, name: variant.name, sku: variant.sku },
    });
  }
  return Effect.succeed(context);
};

/**
 * The complete `work.tasks.submit-storefront-inquiry` payload: task text plus the inquiry, nothing else (the owner
 * refuses every other field). A text beyond the owner's limits is invalid input; nothing is clipped.
 */
export const makeInquiryPayload = (inquiry: Inquiry, context?: InquiryProductContext) => {
  if (
    (inquiry.product === undefined) !== (context === undefined) ||
    (inquiry.product !== undefined &&
      (inquiry.product.productId !== context?.productId ||
        inquiry.product.variantIds[0] !== context?.variant?.id)) ||
    inquiry.message.length > inquiryMessageMaximum(context, inquiry.locale)
  ) {
    return Effect.fail(new InquiryFailure({ reason: "invalid" }));
  }
  let subject = getDictionary(inquiry.locale).contact.productQuestionSubject;
  if (context === undefined) {
    subject = inquiry.locale === "en" ? "N1 contact inquiry" : "Kontaktní dotaz N1";
  }
  const customerInquiry = {
    email: inquiry.email,
    kind: context === undefined ? "CONTACT" : "PRODUCT_QUESTION",
    message: inquiry.message,
    name: inquiry.name,
    requestId: inquiry.requestId,
    subject,
  };
  const storefrontInquiry =
    context === undefined
      ? customerInquiry
      : {
          ...customerInquiry,
          productId: context.productId,
          productName: context.productName,
          productSlug: context.productSlug,
        };
  return Schema.decodeUnknownEffect(SubmitStorefrontInquiryPayloadSchema)({
    description: [
      `Kontakt: ${inquiry.name} <${inquiry.email}>`,
      ...(inquiry.phone ? [`Telefon: ${inquiry.phone}`] : []),
      ...inquiryVariantDescription(context, inquiry.locale),
      "",
      inquiry.message,
    ].join("\n"),
    storefrontInquiry,
    title: subject,
  }).pipe(Effect.mapError(() => new InquiryFailure({ reason: "invalid" })));
};

/** The key of a submission's first write. The inquiry request id, not this key, is what prevents a second task. */
export const inquiryIdempotencyKey = (requestId: string) => `n1-inquiry-${requestId}`;

/**
 * One write, and at most one resend under a new idempotency key for the two refusals that call for it: the key has
 * already committed (`committed`: the owner then answers the task this request id created) or two first tasks of a
 * company raced (`conflict`). The request id never changes, so no resend can create a second task. Every other
 * refusal and every unknown outcome is terminal.
 */
export const sendInquiry = <R>(
  inquiry: Inquiry,
  owner: {
    readonly product?: (
      selector: InquiryProduct,
    ) => Effect.Effect<InquiryProductContext, InquiryFailure, R>;
    readonly submit: (
      payload: SubmitStorefrontInquiryPayload,
      idempotencyKey: string,
    ) => Effect.Effect<string, InquiryFailure, R>;
  },
): Effect.Effect<{ taskId: string }, InquiryFailure, R> =>
  Effect.gen(function* sendInquiryProgram() {
    const context =
      inquiry.product === undefined
        ? undefined
        : yield* owner.product === undefined
            ? Effect.fail(new InquiryFailure({ reason: "invalid" }))
            : owner.product(inquiry.product);
    // Validate the complete payload before reaching the task owner.
    const payload = yield* makeInquiryPayload(inquiry, context);
    const key = inquiryIdempotencyKey(inquiry.requestId);
    const taskId = yield* owner.submit(payload, key).pipe(
      Effect.catch((error) => {
        if (error.reason !== "committed" && error.reason !== "conflict") {
          return Effect.fail(error);
        }
        const saved = error.reason === "committed";
        return owner.submit(payload, `${key}-${crypto.randomUUID()}`).pipe(
          Effect.mapError((resent) => {
            // A committed key means a saved task: a failed read-back must never read as "not sent".
            if (saved || resent.reason === "committed") {
              return new InquiryFailure({ reason: "unconfirmed" });
            }
            // Both writes were definitely refused; the customer may send the form again.
            return resent.reason === "conflict"
              ? new InquiryFailure({ reason: "unavailable" })
              : resent;
          }),
        );
      }),
    );
    return { taskId };
  });

/** A successful transport response alone is insufficient evidence of this customer's saved task. */
export const confirmInquiryTask = (
  result: {
    readonly requestId?: string;
    readonly taskRef?: { readonly resourceId: string; readonly tenantId: string };
  },
  tenantId: string,
  requestId: string,
) =>
  result.taskRef !== undefined &&
  result.taskRef.resourceId.length > 0 &&
  result.taskRef.tenantId === tenantId &&
  result.requestId === requestId
    ? Effect.succeed(result.taskRef.resourceId)
    : Effect.fail(new InquiryFailure({ reason: "unconfirmed" }));

/** Compare complete origins; neither an alternate port nor a protocol downgrade is accepted. */
export const isInquiryOrigin = (origin: string | undefined, requestUrl: string) =>
  origin !== undefined &&
  URL.canParse(origin) &&
  URL.canParse(requestUrl) &&
  new URL(origin).origin === new URL(requestUrl).origin;
