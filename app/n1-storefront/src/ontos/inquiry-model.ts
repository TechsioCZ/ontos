import { ApplyCommandPayloadSchema } from "@app/work-tasks/contracts/apply-command";
import type { ApplyCommandPayload } from "@app/work-tasks/contracts/apply-command";
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

export const makeInquiryCommand = (
  inquiry: Inquiry,
  revision: number,
  context?: InquiryProductContext,
) => {
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
  return Schema.decodeUnknownEffect(ApplyCommandPayloadSchema)({
    command: {
      _tag: "CreateTask",
      description: [
        `Kontakt: ${inquiry.name} <${inquiry.email}>`,
        ...(inquiry.phone ? [`Telefon: ${inquiry.phone}`] : []),
        ...inquiryVariantDescription(context, inquiry.locale),
        "",
        inquiry.message,
      ].join("\n"),
      priority: "NORMAL",
      storefrontInquiry,
      title: subject,
    },
    expectedRevision: revision,
  }).pipe(Effect.mapError(() => new InquiryFailure({ reason: "invalid" })));
};

/** An unknown write outcome is terminal; only an explicit optimistic-lock refusal can be repeated. */
export const sendInquiry = <R>(
  inquiry: Inquiry,
  owner: {
    readonly apply: (payload: ApplyCommandPayload) => Effect.Effect<string, InquiryFailure, R>;
    readonly product?: (
      selector: InquiryProduct,
    ) => Effect.Effect<InquiryProductContext, InquiryFailure, R>;
    readonly revision: Effect.Effect<number, InquiryFailure, R>;
  },
  attempt = 0,
): Effect.Effect<{ taskId: string }, InquiryFailure, R> =>
  Effect.gen(function* sendInquiryProgram() {
    const context =
      inquiry.product === undefined
        ? undefined
        : yield* owner.product === undefined
            ? Effect.fail(new InquiryFailure({ reason: "invalid" }))
            : owner.product(inquiry.product);
    // Validate the complete command before even reading the task owner's revision.
    const validated = yield* makeInquiryCommand(inquiry, 0, context);
    const revision = yield* owner.revision;
    const payload = { ...validated, expectedRevision: revision };
    return yield* owner.apply(payload).pipe(
      Effect.map((taskId) => ({ taskId })),
      Effect.catch((error) =>
        error.reason === "conflict" && attempt < 2
          ? sendInquiry(inquiry, owner, attempt + 1)
          : Effect.fail(
              error.reason === "conflict" ? new InquiryFailure({ reason: "unavailable" }) : error,
            ),
      ),
    );
  });

/** A successful transport response alone is insufficient evidence of this customer's saved task. */
export const confirmInquiryTask = (
  result: {
    readonly task?: {
      readonly ref: { readonly resourceId: string; readonly tenantId: string };
      readonly storefrontInquiry?: { readonly requestId: string };
    };
  },
  tenantId: string,
  requestId: string,
) =>
  result.task !== undefined &&
  result.task.ref.resourceId.length > 0 &&
  result.task.ref.tenantId === tenantId &&
  result.task.storefrontInquiry?.requestId === requestId
    ? Effect.succeed(result.task.ref.resourceId)
    : Effect.fail(new InquiryFailure({ reason: "unconfirmed" }));

/** Compare complete origins; neither an alternate port nor a protocol downgrade is accepted. */
export const isInquiryOrigin = (origin: string | undefined, requestUrl: string) =>
  origin !== undefined &&
  URL.canParse(origin) &&
  URL.canParse(requestUrl) &&
  new URL(origin).origin === new URL(requestUrl).origin;
