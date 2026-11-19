import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { afterEach, expect, it, vi } from "vitest";
import GlobalError from "@/app/global-error";

afterEach(cleanup);

it("does not index an unavailable catalog and lets the customer retry the real render", async () => {
  const reset = vi.fn<() => void>();
  // Next's real usePathname reads the router's pathname context; the failed request was for a Czech page.
  const { container } = render(
    <PathnameContext.Provider value="/cs">
      <GlobalError reset={reset} />
    </PathnameContext.Provider>,
    { container: document },
  );
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
