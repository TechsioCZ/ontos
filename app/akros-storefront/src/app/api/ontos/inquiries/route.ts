import "server-only";
import { getBrand } from "@/brand";
import { randomUUID } from "node:crypto";
import { readProducts } from "@/ontos/catalog-server";
import { callAction, OntosError } from "@/ontos/gateway";
import { guard, jsonBody, problem, RequestError, requestDictionary } from "@/ontos/http";
import {
  inquiryActionPayload,
  parseInquirySubmission,
  type InquiryActionPayload,
  type InquiryProduct,
} from "@/ontos/inquiry-model";

/**
 * Work Tasks refusals that are answered by sending the same inquiry once more under a new idempotency key:
 * the key already committed (the owner then answers the task this request id created), or two first tasks of
 * a company raced. The request id stays the same, so the owner can never create a second task.
 */
const ALREADY_COMMITTED = "action_already_committed";
const RESENT_ONCE = new Set([ALREADY_COMMITTED, "work_revision_conflict"]);
const refusal = (error: unknown) =>
  OntosError.is(error) && error.status === 409 ? error.code : undefined;

/** The only Work Tasks surface a storefront key is admitted on: no records read, no caller revision. */
const fileInquiry = async (payload: InquiryActionPayload): Promise<unknown> => {
  const key = `sf-inquiry-${payload.storefrontInquiry.requestId}`;
  const send = (idempotencyKey: string) =>
    callAction("work-tasks", "submit-storefront-inquiry", payload, idempotencyKey);
  try {
    return await send(key);
  } catch (first) {
    const code = refusal(first);
    // Every other refusal, and every unknown outcome, is final for this request.
    if (code === undefined || !RESENT_ONCE.has(code)) throw first;
    try {
      return await send(`${key}-${randomUUID()}`);
    } catch (second) {
      // A committed key means a saved task: a failed read-back must never read as "not sent".
      if (code === ALREADY_COMMITTED || refusal(second) === ALREADY_COMMITTED)
        throw new Error("Inquiry task was saved but its reference was not confirmed");
      throw second;
    }
  }
};

export async function POST(request: Request) {
  const t = requestDictionary(request);
  try {
    guard(request, t);
    const inquiry = parseInquirySubmission(await jsonBody(request, t));
    if (inquiry === null) throw new RequestError(400, t.server.inquiry.invalid);
    // Resolve product identity now: a stale browser label or a caller-supplied URL is never persisted.
    let product: InquiryProduct | undefined;
    if (inquiry.productId !== undefined) {
      const page = await readProducts(
        { productIds: [inquiry.productId], pageSize: 1 },
        "card",
        true,
      );
      const record = page.products.find((item) => item.id === inquiry.productId);
      if (record === undefined) throw new RequestError(404, t.server.inquiry.productGone);
      product = { productId: record.id, productSlug: record.slug, productName: record.name };
    }
    // The owner refuses a text beyond its limits; ask the customer to shorten it instead of clipping it.
    const payload = inquiryActionPayload(inquiry, product);
    if (payload === null) throw new RequestError(400, t.server.inquiry.invalid);
    const result = (await fileInquiry(payload)) as {
      requestId?: unknown;
      taskRef?: { resourceId?: unknown };
    } | null;
    const taskId = result?.taskRef?.resourceId;
    if (result?.requestId !== inquiry.requestId || typeof taskId !== "string" || taskId === "")
      throw new Error("Task persistence was not confirmed");
    return Response.json({ taskId }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (OntosError.is(error) && error.status === 403) {
      console.error("[AKROS] Inquiry owner authorization denied");
      const { contact } = getBrand();
      return Response.json(
        { message: t.server.inquiry.formUnavailable(contact.email, contact.phone?.display) },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    return problem(error, t.server.inquiry.unconfirmed);
  }
}
