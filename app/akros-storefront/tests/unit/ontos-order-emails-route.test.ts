import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/ontos/order-emails/route";

vi.mock("server-only", () => ({}));
vi.mock("@/ontos/config", () => ({
  isOntos: () => true,
  getConfig: () => ({ shellUrl: "https://ontos-stage.web-revolution.cz" }),
}));

const fetchMock = vi.fn();
function get(orderNumber: string, email: string | null = "pavel@zakaznik.example") {
  const query = new URLSearchParams({ orderNumber });
  if (email !== null) query.set("email", email);
  return GET(new Request(`http://localhost:3070/api/ontos/order-emails?${query.toString()}`));
}

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("order e-mail status route", () => {
  it("returns only the allowed receipt fields from the dispatcher", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
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
    expect(fetchMock).toHaveBeenCalledWith(
      "https://ontos-stage.web-revolution.cz/shell-super-app-api/email/deliveries?source=sf-order&subjectNumber=OBJ-2026-0026&recipient=pavel%40zakaznik.example",
      expect.anything(),
    );
  });

  it("rejects malformed order numbers without calling the dispatcher", async () => {
    vi.stubGlobal("fetch", fetchMock);
    const response = await get("x");
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires the buyer's e-mail so order numbers cannot be enumerated", async () => {
    vi.stubGlobal("fetch", fetchMock);
    for (const email of [null, "", "neni-email"]) {
      const response = await get("OBJ-2026-0026", email);
      expect(response.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 503 with a Czech message when the dispatcher is unreachable", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
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
  ) =>
    GET(
      new Request(
        `http://localhost:3070/api/ontos/order-emails?${new URLSearchParams({ orderNumber, email }).toString()}`,
        { headers: locale === undefined ? {} : { "x-akros-market-locale": locale } },
      ),
    );
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
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockRejectedValue(new Error("down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await getIn(locale, "OBJ-2026-0026");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message });
  });
});
