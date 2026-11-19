// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/ontos/order-emails/route";
import { serveHttp } from "../support/http";
import { nextRequest } from "../support/next-request";

let dispatcher: Awaited<ReturnType<typeof serveHttp>>;
let storefront: Awaited<ReturnType<typeof serveHttp>>;
let dispatcherClosed = false;

beforeEach(async () => {
  dispatcher = await serveHttp(() =>
    Response.json({
      deliveries: [
        {
          event: "ORDER_CREATED",
          eventLabel: "Přijetí objednávky",
          status: "SENT",
          sentAt: "2026-10-21T08:41:00.000Z",
          subjectId: "x",
          recipient: "leak@x.cz",
        },
      ],
    }),
  );
  dispatcherClosed = false;
  vi.stubEnv("ONTOS_SHELL_URL", dispatcher.origin);
  storefront = await serveHttp(async (request) => {
    const context = nextRequest(request.url, { headers: request.headers });
    try {
      return await context.run(() => GET(context.request));
    } finally {
      await context.close();
    }
  });
});

afterEach(async () => {
  try {
    await storefront.close();
    if (!dispatcherClosed) await dispatcher.close();
  } finally {
    vi.unstubAllEnvs();
  }
});

function get(
  orderNumber: string,
  email: string | null = "pavel@zakaznik.example",
  locale?: string,
) {
  const query = new URLSearchParams({ orderNumber });
  if (email !== null) query.set("email", email);
  return fetch(`${storefront.origin}/api/ontos/order-emails?${query.toString()}`, {
    headers: locale === undefined ? {} : { "x-akros-market-locale": locale },
  });
}

async function disconnectDispatcher() {
  await dispatcher.close();
  dispatcherClosed = true;
}

describe("order e-mail status route", () => {
  it("returns only the allowed receipt fields from the dispatcher", async () => {
    const response = await get("OBJ-2026-0026");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      deliveries: [
        {
          event: "ORDER_CREATED",
          eventLabel: "Přijetí objednávky",
          status: "SENT",
          sentAt: "2026-10-21T08:41:00.000Z",
        },
      ],
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    await dispatcher.idle();
    expect(dispatcher.requests.map((request) => request.url)).toContain(
      `${dispatcher.origin}/shell-super-app-api/email/deliveries?source=akros-order&subjectNumber=OBJ-2026-0026&recipient=pavel%40zakaznik.example`,
    );
  });

  it("rejects malformed order numbers without calling the dispatcher", async () => {
    const response = await get("x");
    expect(response.status).toBe(400);
    await response.json();
    await storefront.idle();
    await dispatcher.idle();
    expect(dispatcher.requests).toHaveLength(0);
  });

  it("requires the buyer's e-mail so order numbers cannot be enumerated", async () => {
    for (const email of [null, "", "neni-email"]) {
      const response = await get("OBJ-2026-0026", email);
      expect(response.status).toBe(400);
      await response.json();
    }
    await storefront.idle();
    await dispatcher.idle();
    expect(dispatcher.requests).toHaveLength(0);
  });

  it("answers 503 with a Czech message when the dispatcher is unreachable", async () => {
    await disconnectDispatcher();
    const response = await get("OBJ-2026-0026");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: "Stav e-mailů se nepodařilo ověřit." });
  });
});

describe("order e-mail status messages follow the market language", () => {
  const getIn = (
    locale: string | undefined,
    orderNumber: string,
    email = "pavel@zakaznik.example",
  ) => get(orderNumber, email, locale);

  it.each([
    [undefined, "Neplatné číslo objednávky."],
    ["sk", "Neplatné číslo objednávky."],
    ["en", "Invalid order number."],
  ])("rejects a malformed number for locale %s", async (locale, message) => {
    const response = await getIn(locale, "x");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message });
  });

  it.each([
    [undefined, "Stav e-mailů se nepodařilo ověřit."],
    ["sk", "Stav e-mailov sa nepodarilo overiť."],
    ["en", "The e-mail status could not be verified."],
  ])("answers an outage for locale %s", async (locale, message) => {
    await disconnectDispatcher();
    const response = await getIn(locale, "OBJ-2026-0026");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message });
  });
});
