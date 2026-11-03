import { Effect, Exit, ManagedRuntime, Match } from "effect";
import type { Fiber } from "effect";
import type { HttpClient } from "effect/http";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { InquiryApi } from "./inquiry";
import type { Inquiry, InquiryOutcome } from "./inquiry";

/** Browser composition root: one lifecycle for its generated channel client. */
export const inquiryRuntime = ManagedRuntime.make(FetchHttpClient.layer);
export const submitInquiry = (input: Inquiry) =>
  HttpApiClient.make(InquiryApi).pipe(
    Effect.flatMap((client) => client.inquiry.submit({ payload: input })),
    Effect.match({
      onFailure: (error): InquiryOutcome =>
        Match.value(error).pipe(
          Match.tag("InquiryForbidden", () => ({ state: "forbidden" as const })),
          Match.tag("InquiryInvalid", () => ({ state: "invalid" as const })),
          Match.tag("InquiryUnavailable", () => ({ state: "unavailable" as const })),
          Match.orElse(() => ({ state: "unconfirmed" as const })),
        ),
      onSuccess: (receipt): InquiryOutcome => ({ state: "sent", taskId: receipt.taskId }),
    }),
  );

export interface InquirySubmissionRef {
  current: Fiber.Fiber<InquiryOutcome> | null;
}

/** Register completion after storing the fiber, including effects that complete synchronously. */
export const startInquirySubmission = (
  active: InquirySubmissionRef,
  onOutcome: (outcome: InquiryOutcome) => void,
  program: Effect.Effect<InquiryOutcome, never, HttpClient.HttpClient>,
) => {
  const fiber = inquiryRuntime.runFork(program);
  active.current = fiber;
  fiber.addObserver((exit) => {
    if (active.current !== fiber) {
      return;
    }
    active.current = null;
    onOutcome(Exit.isSuccess(exit) ? exit.value : { state: "unconfirmed" });
  });
};
