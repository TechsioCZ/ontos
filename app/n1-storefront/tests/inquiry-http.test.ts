import { expect, it } from "effect-rstest";
import { INGRESS_BYTES } from "@ontos/storefront-runtime";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { SubmitStorefrontInquiryPayloadSchema } from "@app/work-tasks/contracts/submit-storefront-inquiry";
import { POST } from "../src/app/api/inquiries/route";
import { ownerServer } from "./support/owner-server";

const inquiry = {
  email: "shopper@example.test",
  locale: "cs",
  message: "Delivery question",
  name: "Shopper",
  phone: "",
  requestId: "71000000-0000-4000-8000-000000000099",
};
const tenantId = "71000000-0000-4000-8000-000000000098";
const inquiryOwner = () => {
  let mints = 0;
  const writes: (typeof SubmitStorefrontInquiryPayloadSchema.Type)[] = [];
  const mint = HttpRouter.add(
    "POST",
    "/shell-super-app-api/auth/api-key/gateway-context",
    Effect.sync(() => {
      mints += 1;
      return HttpServerResponse.jsonUnsafe({
        apiBaseUrl: "/shell-super-app-api/gateway",
        compositionRevision: "a".repeat(64),
        expiresAt: 9_999_999_999,
        token: "inquiry-test-assertion",
      });
    }),
  );
  const action = HttpRouter.add(
    "POST",
    "/shell-super-app-api/gateway/work-tasks/actions/submit-storefront-inquiry",
    Effect.gen(function* submitNativeInquiry() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const payload = yield* Schema.decodeUnknownEffect(SubmitStorefrontInquiryPayloadSchema)(
        yield* request.json,
      );
      writes.push(payload);
      expect(request.headers.authorization).toBe("Bearer inquiry-test-assertion");
      expect(request.headers["idempotency-key"]).toBe(`n1-inquiry-${inquiry.requestId}`);
      return HttpServerResponse.jsonUnsafe({
        requestId: payload.storefrontInquiry.requestId,
        taskRef: {
          moduleId: "work.tasks",
          resourceId: "saved-task",
          resourceType: "work.tasks.task",
          tenantId,
        },
      });
    }).pipe(Effect.orDie),
  );
  return {
    layer: ownerServer(Layer.merge(mint, action), {
      ONTOS_N1_STOREFRONT_API_KEY: "inquiry-test-key",
      ONTOS_STOREFRONT_LEGAL_ENTITY_ID: "71000000-0000-4000-8000-000000000099",
      ONTOS_STOREFRONT_TENANT_ID: tenantId,
    }),
    mints: () => mints,
    writes,
  };
};

const chunkedRequest = (bytes: Uint8Array) => {
  let offset = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      cancel() {
        cancelled = true;
      },
      pull(controller) {
        if (offset === bytes.length) {
          controller.close();
          return;
        }
        const end = Math.min(offset + 10_000, bytes.length);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
    },
    { highWaterMark: 0 },
  );
  const init: RequestInit & { duplex: "half" } = {
    body,
    duplex: "half",
    headers: {
      "content-type": "application/json",
      host: "n1.example",
      origin: "https://n1.example",
    },
    method: "POST",
  };
  return {
    cancelled: () => cancelled,
    request: new Request("https://n1.example/api/inquiries", init),
  };
};

it.live(
  "rejects chunked UTF-8 ingress overflow before native owner admission or Action dispatch",
  () => {
    const owner = inquiryOwner();
    return Effect.gen(function* rejectChunkedOverflow() {
      const base = JSON.stringify({ ...inquiry, name: "ž" });
      const body = base.replace("ž", `${" ".repeat(INGRESS_BYTES - base.length)}ž`);
      const bytes = new TextEncoder().encode(body);
      expect(body.length).toBe(INGRESS_BYTES);
      expect(bytes.byteLength).toBe(INGRESS_BYTES + 1);
      const incoming = chunkedRequest(bytes);
      expect(incoming.request.headers.has("content-length")).toBe(false);
      const response = yield* Effect.promise(() => POST(incoming.request));
      expect(response.status).toBe(413);
      expect(incoming.cancelled()).toBe(true);
      expect(owner.mints()).toBe(0);
      expect(owner.writes).toEqual([]);
    }).pipe(Effect.provide(owner.layer));
  },
);

it.live("accepts exactly the ingress byte limit and confirms the one native inquiry Action", () => {
  const owner = inquiryOwner();
  return Effect.gen(function* exactChunkedLimit() {
    const base = JSON.stringify(inquiry);
    const incoming = chunkedRequest(
      new TextEncoder().encode(`${base}${" ".repeat(INGRESS_BYTES - base.length)}`),
    );
    const response = yield* Effect.promise(() => POST(incoming.request));
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.json())).toEqual({ taskId: "saved-task" });
    expect(owner.mints()).toBe(1);
    expect(owner.writes).toEqual([
      {
        description: `Kontakt: ${inquiry.name} <${inquiry.email}>\n\n${inquiry.message}`,
        storefrontInquiry: {
          email: inquiry.email,
          kind: "CONTACT",
          message: inquiry.message,
          name: inquiry.name,
          requestId: inquiry.requestId,
          subject: "Kontaktní dotaz N1",
        },
        title: "Kontaktní dotaz N1",
      },
    ]);
  }).pipe(Effect.provide(owner.layer));
});
