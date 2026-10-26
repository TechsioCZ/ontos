export interface CustomerNewsletterConsent {
  readonly decision: "ABSENT" | "GRANTED" | "WITHDRAWN";
  readonly revision: number;
  readonly notice: {
    readonly language: string;
    readonly noticeVersionId: string;
    readonly wording: string;
  };
}
const uuid = (input: unknown): input is string =>
  typeof input === "string" &&
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(input);
const record = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input);
const version = (input: unknown): input is string =>
  typeof input === "string" && input.length > 0 && input.length <= 100;
const revision = (input: unknown): input is number =>
  typeof input === "number" && Number.isSafeInteger(input) && input >= 0;
export const isCustomerNewsletterConsent = (input: unknown): input is CustomerNewsletterConsent => {
  if (!record(input) || !record(input.notice)) return false;
  return (
    ["ABSENT", "GRANTED", "WITHDRAWN"].includes(String(input.decision)) &&
    revision(input.revision) &&
    version(input.notice.noticeVersionId) &&
    typeof input.notice.language === "string" &&
    input.notice.language.length > 0 &&
    typeof input.notice.wording === "string" &&
    input.notice.wording.trim().length > 0
  );
};
export const customerConsentInput = (input: unknown) => {
  if (
    !record(input) ||
    (input.decision !== "GRANTED" && input.decision !== "WITHDRAWN") ||
    typeof input.noticeAcknowledged !== "boolean" ||
    (input.decision === "GRANTED" && !input.noticeAcknowledged) ||
    !uuid(input.requestId) ||
    !version(input.noticeVersionId) ||
    !revision(input.expectedRevision)
  )
    return null;
  // Identity and scope always come from the admitted customer, never the browser.
  return {
    decision: input.decision,
    expectedRevision: input.expectedRevision,
    noticeAcknowledged: input.noticeAcknowledged,
    noticeVersionId: input.noticeVersionId,
    requestId: input.requestId,
  };
};
