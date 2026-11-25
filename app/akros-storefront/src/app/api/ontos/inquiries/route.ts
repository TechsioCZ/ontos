import { Effect } from "effect";
import { createOperation } from "@ontos/storefront-runtime";
import type { OperationOptions } from "@ontos/storefront-runtime";
import "server-only";
import { randomUUID } from "node:crypto";
import { getBrand } from "@/brand";
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
 * One dispatch per explicit submission. Work Tasks deduplicates unchanged customer fields by requestId;
 * a fresh Action key lets a deliberate resend recover its receipt after a committed response was lost.
 */
const fileInquiry = (payload: InquiryActionPayload, options: OperationOptions): Promise<unknown> =>
  callAction(
    "work-tasks",
    "submit-storefront-inquiry",
    payload,
    `sf-inquiry-${payload.storefrontInquiry.requestId}-${randomUUID()}`,
    options,
  );

export async function POST(request: Request) {
  const t = requestDictionary(request);
  const lifetime = Effect.runSync(createOperation({ signal: request.signal }));
  try {
    guard(request, t);
    const inquiry = parseInquirySubmission(await jsonBody(request, t, lifetime));
    if (inquiry === null) throw new RequestError(400, t.server.inquiry.invalid);
    // Resolve product identity now: a stale browser label or a caller-supplied URL is never persisted.
    let product: InquiryProduct | undefined;
    if (inquiry.productId !== undefined) {
      const page = await readProducts(
        { productIds: [inquiry.productId], pageSize: 1 },
        "card",
        true,
        { operation: lifetime },
      );
      const record = page.products.find((item) => item.id === inquiry.productId);
      if (record === undefined) throw new RequestError(404, t.server.inquiry.productGone);
      product = { productId: record.id, productSlug: record.slug, productName: record.name };
    }
    // The owner refuses a text beyond its limits; ask the customer to shorten it instead of clipping it.
    const payload = inquiryActionPayload(inquiry, product);
    if (payload === null) throw new RequestError(400, t.server.inquiry.invalid);
    const result = (await fileInquiry(payload, { operation: lifetime })) as {
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
  } finally {
    lifetime.dispose();
  }
}
