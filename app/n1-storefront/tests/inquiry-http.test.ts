import { beforeEach, expect, it, rs } from "@rstest/core";
import { INGRESS_BYTES } from "@ontos/storefront-runtime";
import { Effect } from "effect";
import { POST } from "../src/app/api/inquiries/route";
import { persistInquiry } from "../src/ontos/inquiry-server";

rs.mock("../src/ontos/inquiry-server", { spy: true });

const inquiry = {
  email: "shopper@example.test",
  locale: "cs",
  message: "Delivery question",
  name: "Shopper",
  phone: "",
  requestId: "71000000-0000-4000-8000-000000000099",
};
beforeEach(() => {
  rs.mocked(persistInquiry).mockReset();
  rs.mocked(persistInquiry).mockReturnValue(Effect.succeed({ taskId: "saved-task" }));
});

const chunkedRequest = (bytes: Uint8Array) => {
  let offset = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (offset === bytes.length) {
          controller.close();
          return;
        }
        const end = Math.min(offset + 10_000, bytes.length);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
      cancel() {
        cancelled = true;
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

it("rejects chunked UTF-8 ingress overflow before the generated inquiry handler", async () => {
  const base = JSON.stringify({ ...inquiry, name: "ž" });
  const body = base.replace("ž", `${" ".repeat(INGRESS_BYTES - base.length)}ž`);
  const bytes = new TextEncoder().encode(body);
  expect(body.length).toBe(INGRESS_BYTES);
  expect(bytes.byteLength).toBe(INGRESS_BYTES + 1);
  const incoming = chunkedRequest(bytes);
  expect(incoming.request.headers.has("content-length")).toBe(false);
  const response = await POST(incoming.request);
  expect(response.status).toBe(413);
  expect(incoming.cancelled()).toBe(true);
  expect(persistInquiry).not.toHaveBeenCalled();
});

it("accepts a chunked inquiry exactly at the ingress byte limit", async () => {
  const base = JSON.stringify(inquiry);
  const incoming = chunkedRequest(
    new TextEncoder().encode(`${base}${" ".repeat(INGRESS_BYTES - base.length)}`),
  );
  const response = await POST(incoming.request);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ taskId: "saved-task" });
  expect(persistInquiry).toHaveBeenCalledExactlyOnceWith(inquiry);
});
