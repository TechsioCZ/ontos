export interface CustomerNewsletterConsent {
  readonly decision: "ABSENT" | "GRANTED" | "REFUSED" | "WITHDRAWN";
  readonly notice: {
    readonly language: string;
    readonly noticeVersionId: string;
    readonly purposeVersionId: string;
    readonly wording: string;
  };
}
const uuid = (input: unknown): input is string =>
  typeof input === "string" &&
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(input);
const record = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input);
export const isCustomerNewsletterConsent = (input: unknown): input is CustomerNewsletterConsent => {
  if (!record(input) || !record(input.notice)) return false;
  return (
    ["ABSENT", "GRANTED", "REFUSED", "WITHDRAWN"].includes(String(input.decision)) &&
    uuid(input.notice.noticeVersionId) &&
    uuid(input.notice.purposeVersionId) &&
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
    input.noticeAcknowledged !== true ||
    !uuid(input.requestId) ||
    !uuid(input.noticeVersionId) ||
    !uuid(input.purposeVersionId)
  )
    return null;
  // No browser-selected Party, tenant, scope, actor, session or proof survives the storefront boundary.
  return {
    decision: input.decision,
    noticeAcknowledged: true as const,
    noticeVersionId: input.noticeVersionId,
    purposeVersionId: input.purposeVersionId,
    requestId: input.requestId,
  };
};
