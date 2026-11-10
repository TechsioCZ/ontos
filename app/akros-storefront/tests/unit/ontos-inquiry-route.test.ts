import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/ontos/inquiries/route";
import { readProducts } from "@/ontos/catalog-server";
import { callAction, OntosError, readRecords } from "@/ontos/gateway";

vi.mock("@/ontos/catalog-server", () => ({ readProducts: vi.fn<typeof readProducts>() }));
vi.mock("@/ontos/gateway", async (original) => ({
  ...(await original<typeof import("@/ontos/gateway")>()),
  callAction: vi.fn<typeof callAction>(),
  readRecords: vi.fn<typeof readRecords>(),
}));
const inquiry = {
  requestId: "a1234567-1234-4234-8234-123456789abc",
  kind: "CONTACT",
  name: "Zákazník",
  email: "customer@example.test",
  subject: "Dostupnost materiálu",
  message: "Prosím o ověření dostupnosti.",
};
const firstKey = `sf-inquiry-${inquiry.requestId}`;
const accepted = (resourceId = "persisted-task", requestId = inquiry.requestId) => ({
  requestId,
  taskRef: {
    moduleId: "work.tasks",
    resourceId,
    resourceType: "work.tasks.task",
    tenantId: "tenant",
  },
});
const submit = (body: object = inquiry) =>
  POST(
    new Request("http://localhost:3070/api/ontos/inquiries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(callAction).mockResolvedValue(accepted());
});
describe("persisted storefront inquiries", () => {
  it("files the inquiry through the narrow Work Tasks action with exactly its payload", async () => {
    const response = await submit({ ...inquiry, name: "  Zákazník ", priority: "URGENT" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ taskId: "persisted-task" });
    expect(vi.mocked(callAction).mock.calls).toEqual([
      [
        "work-tasks",
        "submit-storefront-inquiry",
        {
          title: "Kontaktní dotaz: Dostupnost materiálu",
          description: "Kontakt: Zákazník <customer@example.test>\n\nProsím o ověření dostupnosti.",
          storefrontInquiry: inquiry,
        },
        firstKey,
      ],
    ]);
    // The storefront key is admitted on this one action only: no Work Tasks read precedes it.
    expect(readRecords).not.toHaveBeenCalled();
  });
  it("shows the unavailable form after an authorization denial, without another attempt", async () => {
    vi.mocked(callAction).mockRejectedValue(
      new OntosError("Denied", 403, "action_permission_denied"),
    );
    const response = await submit();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).message).toContain(
      "Kontaktní formulář je dočasně nedostupný. Dotaz nebyl odeslán.",
    );
    expect(callAction).toHaveBeenCalledTimes(1);
  });
  it("never replays an unknown action outcome or claims definite non-delivery", async () => {
    vi.mocked(callAction).mockRejectedValue(new OntosError("Timeout", 503));
    const response = await submit();
    expect(response.status).toBe(503);
    expect((await response.json()).message).toContain("nepodařilo potvrdit");
    expect(callAction).toHaveBeenCalledTimes(1);
  });
  it("does not resend a request id that already belongs to another submission", async () => {
    vi.mocked(callAction).mockRejectedValue(
      new OntosError("Conflict", 409, "work_lifecycle_conflict"),
    );
    const response = await submit();
    expect(response.status).toBe(503);
    expect((await response.json()).message).toContain("nepodařilo potvrdit");
    expect(callAction).toHaveBeenCalledTimes(1);
  });
  it.each(["action_already_committed", "work_revision_conflict"])(
    "resends %s once under a new idempotency key with the same request id",
    async (code) => {
      vi.mocked(callAction)
        .mockRejectedValueOnce(new OntosError("Conflict", 409, code))
        .mockResolvedValueOnce(accepted("existing-task"));
      const response = await submit();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ taskId: "existing-task" });
      const [first, second] = vi.mocked(callAction).mock.calls;
      expect(callAction).toHaveBeenCalledTimes(2);
      expect(first?.[3]).toBe(firstKey);
      expect(second?.[3]).toMatch(new RegExp(`^${firstKey}-[\\da-f-]{36}$`, "u"));
      expect(second?.slice(0, 3)).toEqual(first?.slice(0, 3));
      expect(second?.[2]).toMatchObject({ storefrontInquiry: { requestId: inquiry.requestId } });
    },
  );
  it("stops after the one resend instead of looping", async () => {
    vi.mocked(callAction).mockRejectedValue(
      new OntosError("Conflict", 409, "action_already_committed"),
    );
    const response = await submit();
    expect(response.status).toBe(503);
    expect((await response.json()).message).toContain("nepodařilo potvrdit");
    expect(callAction).toHaveBeenCalledTimes(2);
  });
  it("never claims non-delivery when the resend of a committed key is refused", async () => {
    vi.mocked(callAction)
      .mockRejectedValueOnce(new OntosError("Conflict", 409, "action_already_committed"))
      .mockRejectedValueOnce(new OntosError("Denied", 403, "action_permission_denied"));
    const response = await submit();
    expect(response.status).toBe(503);
    const { message } = await response.json();
    expect(message).toContain("nepodařilo potvrdit");
    expect(message).not.toContain("nebyl odeslán");
    expect(callAction).toHaveBeenCalledTimes(2);
  });
  it("shows the unavailable form when the resend after a revision race is denied", async () => {
    vi.mocked(callAction)
      .mockRejectedValueOnce(new OntosError("Conflict", 409, "work_revision_conflict"))
      .mockRejectedValueOnce(new OntosError("Denied", 403, "action_permission_denied"));
    const response = await submit();
    expect(response.status).toBe(503);
    expect((await response.json()).message).toContain("Dotaz nebyl odeslán");
    expect(callAction).toHaveBeenCalledTimes(2);
  });
  it.each([
    ["no task reference", { requestId: inquiry.requestId }],
    ["an empty task id", accepted("")],
    ["another request id", accepted("persisted-task", "b1234567-1234-4234-8234-123456789abc")],
    ["the old apply-command shape", { task: { ref: { resourceId: "persisted-task" } } }],
  ])("does not confirm an acknowledgement with %s", async (_label, result) => {
    vi.mocked(callAction).mockResolvedValue(result);
    const response = await submit();
    expect(response.status).toBe(503);
    expect((await response.json()).message).toContain("nepodařilo potvrdit");
  });
  it("uses fresh owner product identity instead of caller labels", async () => {
    vi.mocked(readProducts).mockResolvedValue({
      products: [{ id: "p1", slug: "owner-slug", name: "Owner product" }],
      total: 1,
    } as Awaited<ReturnType<typeof readProducts>>);
    const response = await submit({
      ...inquiry,
      kind: "PRODUCT_QUESTION",
      productId: "p1",
      productName: "Forged",
    });
    expect(response.status).toBe(200);
    expect(readProducts).toHaveBeenCalledWith({ productIds: ["p1"], pageSize: 1 }, "card", true);
    expect(vi.mocked(callAction).mock.calls[0]?.[2]).toEqual({
      title: "Dotaz na produkt: Dostupnost materiálu",
      description:
        "Kontakt: Zákazník <customer@example.test>\nProdukt: Owner product\n\nProsím o ověření dostupnosti.",
      storefrontInquiry: {
        ...inquiry,
        kind: "PRODUCT_QUESTION",
        productId: "p1",
        productName: "Owner product",
        productSlug: "owner-slug",
      },
    });
  });
  it("refuses a task text beyond the owner's limit as invalid input instead of clipping it", async () => {
    vi.mocked(readProducts).mockResolvedValue({
      products: [{ id: "p1", slug: "owner-slug", name: "P".repeat(200) }],
      total: 1,
    } as Awaited<ReturnType<typeof readProducts>>);
    const response = await submit({
      ...inquiry,
      kind: "PRODUCT_QUESTION",
      productId: "p1",
      name: "N".repeat(120),
      email: `${"e".repeat(242)}@example.cz`,
      message: "m".repeat(1500),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: "Zkontrolujte jméno, e-mail, předmět a zprávu (nejvýše 1 500 znaků).",
    });
    expect(callAction).not.toHaveBeenCalled();
  });
});

describe("inquiry messages follow the market language", () => {
  const submitIn = (locale: string | undefined, body: object = inquiry) =>
    POST(
      new Request("http://localhost:3070/api/ontos/inquiries", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(locale === undefined ? {} : { "x-akros-market-locale": locale }),
        },
        body: JSON.stringify(body),
      }),
    );
  it.each([
    [undefined, "Zkontrolujte jméno, e-mail, předmět a zprávu (nejvýše 1 500 znaků)."],
    ["sk", "Skontrolujte meno, e-mail, predmet a správu (najviac 1 500 znakov)."],
    ["en", "Check your name, e-mail, subject and message (at most 1,500 characters)."],
  ])("refuses an invalid inquiry for locale %s", async (locale, message) => {
    const response = await submitIn(locale, { ...inquiry, email: "nope" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message });
    expect(callAction).not.toHaveBeenCalled();
  });
  it.each([
    ["sk", "Dopyt nebol odoslaný"],
    ["en", "Your enquiry was not sent"],
  ])("words the unavailable form for locale %s", async (locale, text) => {
    vi.mocked(callAction).mockRejectedValue(
      new OntosError("Denied", 403, "action_permission_denied"),
    );
    const response = await submitIn(locale);
    expect(response.status).toBe(503);
    expect((await response.json()).message).toContain(text);
  });
  it.each([
    ["sk", "Prijatie dopytu sa nepodarilo potvrdiť."],
    ["en", "We could not confirm that your enquiry was received."],
  ])("words an unconfirmed outcome for locale %s", async (locale, text) => {
    vi.mocked(callAction).mockRejectedValue(new OntosError("Timeout", 503));
    const response = await submitIn(locale);
    expect(response.status).toBe(503);
    expect((await response.json()).message).toContain(text);
  });
});
