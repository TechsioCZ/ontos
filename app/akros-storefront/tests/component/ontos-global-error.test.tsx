import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import GlobalError from "@/app/global-error";

vi.mock("next/navigation", () => ({ usePathname: () => "/cs" }));
afterEach(cleanup);

it("does not index an unavailable catalog and lets the customer retry the real render", async () => {
  const reset = vi.fn<() => void>();
  const { container } = render(<GlobalError reset={reset} />, {
    container: document,
  });
  expect(container.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe(
    "noindex, nofollow, noarchive",
  );
  expect(
    within(document.body).getByRole("heading", { name: "Katalog je dočasně nedostupný" }),
  ).toBeTruthy();
  await userEvent
    .setup()
    .click(within(document.body).getByRole("button", { name: "Zkusit znovu" }));
  expect(reset).toHaveBeenCalledOnce();
});
