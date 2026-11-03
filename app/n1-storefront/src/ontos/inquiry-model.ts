import { ApplyCommandPayloadSchema } from "@app/work-tasks/contracts/apply-command";
import type { ApplyCommandPayload } from "@app/work-tasks/contracts/apply-command";
import { Effect, Schema } from "effect";
import type { Inquiry } from "./inquiry";
import { InquiryFailure } from "./inquiry";

export { decodeInquiry, InquiryFailure } from "./inquiry";

export const makeInquiryCommand = (inquiry: Inquiry, revision: number) =>
  Schema.decodeUnknownEffect(ApplyCommandPayloadSchema)({
    command: {
      _tag: "CreateTask",
      description: [
        `Kontakt: ${inquiry.name} <${inquiry.email}>`,
        ...(inquiry.phone ? [`Telefon: ${inquiry.phone}`] : []),
        "",
        inquiry.message,
      ].join("\n"),
      priority: "NORMAL",
      storefrontInquiry: {
        email: inquiry.email,
        kind: "CONTACT",
        message: inquiry.message,
        name: inquiry.name,
        requestId: inquiry.requestId,
        subject: inquiry.locale === "en" ? "N1 contact inquiry" : "Kontaktní dotaz N1",
      },
      title: inquiry.locale === "en" ? "N1 contact inquiry" : "Kontaktní dotaz N1",
    },
    expectedRevision: revision,
  }).pipe(Effect.mapError(() => new InquiryFailure({ reason: "invalid" })));

/** An unknown write outcome is terminal; only an explicit optimistic-lock refusal can be repeated. */
export const sendInquiry = <R>(
  inquiry: Inquiry,
  owner: {
    readonly apply: (payload: ApplyCommandPayload) => Effect.Effect<string, InquiryFailure, R>;
    readonly revision: Effect.Effect<number, InquiryFailure, R>;
  },
  attempt = 0,
): Effect.Effect<{ taskId: string }, InquiryFailure, R> =>
  Effect.gen(function* sendInquiryProgram() {
    const revision = yield* owner.revision;
    const payload = yield* makeInquiryCommand(inquiry, revision);
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
