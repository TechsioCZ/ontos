import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EnrollmentProgress } from "@/components/enrollment-progress";

const router = vi.hoisted(() => ({ replace: vi.fn<(path: string) => void>() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/store-link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
const fetchProgress = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchProgress);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("recovers pending registration after a reload and resumes only on explicit request", async () => {
  fetchProgress.mockImplementation(async () =>
    Response.json({ state: "RECONCILIATION_REQUIRED", revision: 10 }),
  );
  const view = render(<EnrollmentProgress />);
  const resume = await screen.findByRole("button", { name: "Obnovit registraci" });
  expect(fetchProgress).toHaveBeenCalledOnce();
  expect(router.replace).not.toHaveBeenCalled();
  fireEvent.click(resume);
  await waitFor(() => expect(fetchProgress).toHaveBeenCalledTimes(2));
  expect(fetchProgress.mock.calls[1]![1]).toMatchObject({ method: "POST", body: "{}" });
  view.unmount();
  render(<EnrollmentProgress />);
  await screen.findByRole("button", { name: "Obnovit registraci" });
  expect(fetchProgress).toHaveBeenCalledTimes(3);
  expect(fetchProgress.mock.calls[2]![1]).toMatchObject({ method: "GET", cache: "no-store" });
});

it.each(["FAILED", "TERMINATED", "COMPLETE"])(
  "does not offer to replay a terminal native Attempt (%s)",
  async (state) => {
    fetchProgress.mockResolvedValue(Response.json({ state }));
    render(<EnrollmentProgress />);
    await screen.findByRole("button", { name: "Ověřit stav" });
    expect(screen.queryByRole("button", { name: "Obnovit registraci" })).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain(
      state === "COMPLETE" ? "přístup" : state === "FAILED" ? "nové přijetí" : "nelze ji obnovit",
    );
  },
);

it("opens the account only after real admission, not merely COMPLETE or SESSION_CREATED", async () => {
  fetchProgress.mockResolvedValue(Response.json({ state: "ADMITTED" }));
  render(<EnrollmentProgress />);
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/muj-ucet"));
});

it("shows owner authentication/outage refusals without automatic retry loops", async () => {
  fetchProgress.mockResolvedValue(
    Response.json({ message: "Přihlaste se ověřeným účtem." }, { status: 401 }),
  );
  render(<EnrollmentProgress />);
  expect((await screen.findByRole("alert")).textContent).toContain("Přihlaste se");
  expect(fetchProgress).toHaveBeenCalledOnce();
  expect(router.replace).not.toHaveBeenCalled();
});

it("starts a new enrollment only on explicit FAILED restart, never repeating signup or the old Attempt", async () => {
  fetchProgress.mockImplementation(async (_url, init) =>
    Response.json({ state: init?.method === "PUT" ? "IN_PROGRESS" : "FAILED", revision: 2 }),
  );
  render(<EnrollmentProgress />);
  const restart = await screen.findByRole("button", { name: "Zahájit nové přijetí účtu" });
  expect(fetchProgress).toHaveBeenCalledOnce();
  fireEvent.click(restart);
  await screen.findByRole("button", { name: "Obnovit registraci" });
  expect(fetchProgress.mock.calls[1]![1]).toMatchObject({ method: "PUT", body: "{}" });
  expect(screen.queryByRole("button", { name: "Zahájit nové přijetí účtu" })).toBeNull();
  expect(router.replace).not.toHaveBeenCalled();
});
