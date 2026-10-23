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
const submit = (body = inquiry) =>
  POST(
    new Request("http://localhost:3070/api/ontos/inquiries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readRecords).mockResolvedValue({ revision: 7 });
  vi.mocked(callAction).mockResolvedValue({ task: { ref: { resourceId: "persisted-task" } } });
});
describe("persisted storefront inquiries", () => {
  it("confirms success only after task creation", async () => {
    const response = await submit();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ taskId: "persisted-task" });
    expect(callAction).toHaveBeenCalledWith(
      "work-tasks",
      "apply-command",
      expect.objectContaining({ expectedRevision: 7 }),
      expect.stringContaining(inquiry.requestId),
    );
  });
  it("does not issue a command or retry after definite read authorization denial", async () => {
    vi.mocked(readRecords).mockRejectedValue(new OntosError("Denied", 403));
    const response = await submit();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).message).toContain("Dotaz nebyl odeslán");
    expect(readRecords).toHaveBeenCalledTimes(1);
    expect(callAction).not.toHaveBeenCalled();
  });
  it("never replays an unknown action outcome or claims definite non-delivery", async () => {
    vi.mocked(callAction).mockRejectedValue(new OntosError("Timeout", 503));
    const response = await submit();
    expect(response.status).toBe(503);
    expect((await response.json()).message).toContain("nepodařilo potvrdit");
    expect(callAction).toHaveBeenCalledTimes(1);
  });
  it("rereads revision only after a definite revision conflict", async () => {
    vi.mocked(readRecords)
      .mockResolvedValueOnce({ revision: 7 })
      .mockResolvedValueOnce({ revision: 8 });
    vi.mocked(callAction)
      .mockRejectedValueOnce(new OntosError("Conflict", 409, "work_revision_conflict"))
      .mockResolvedValueOnce({ task: { ref: { resourceId: "persisted-task" } } });
    expect((await submit()).status).toBe(200);
    expect(readRecords).toHaveBeenCalledTimes(2);
    expect(vi.mocked(callAction).mock.calls[1]?.[2]).toMatchObject({ expectedRevision: 8 });
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
    } as typeof inquiry);
    expect(response.status).toBe(200);
    expect(readProducts).toHaveBeenCalledWith({ productIds: ["p1"], pageSize: 1 }, "card", true);
    expect(vi.mocked(callAction).mock.calls[0]?.[2]).toMatchObject({
      command: {
        storefrontInquiry: {
          productId: "p1",
          productName: "Owner product",
          productSlug: "owner-slug",
        },
      },
    });
  });
});
