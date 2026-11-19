import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { FaqExplorer } from "@/components/faq-explorer";
import { faqCopy } from "@/content/editorial";

afterEach(cleanup);

it("searches across FAQ categories without case or accent sensitivity and recovers from no results", async () => {
  const user = userEvent.setup();
  render(<FaqExplorer faq={faqCopy.cs("support@example.test")} />);
  const categories = screen.getByRole("navigation", { name: "Kategorie často kladených otázek" });
  const shipping = within(categories).getByRole("button", { name: /Doprava a doručení/ });
  await user.click(shipping);
  expect(shipping.getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("button", { name: /Jaké dopravce mohu využít/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Jak dlouho trvá vyřízení objednávky/ })).toBeNull();
  const search = screen.getByRole("searchbox", { name: "Hledat v často kladených otázkách" });
  await user.type(search, "vyrizeni");
  expect(screen.getByRole("button", { name: /Jak dlouho trvá vyřízení objednávky/ })).toBeTruthy();
  expect(shipping.getAttribute("aria-current")).toBeNull();
  await user.clear(search);
  await user.type(search, "VYŘÍZENÍ");
  expect(screen.getByRole("button", { name: /Jak dlouho trvá vyřízení objednávky/ })).toBeTruthy();
  await user.clear(search);
  await user.type(search, "no-such-answer-zz");
  expect(screen.getByText("Pro zadaný výraz jsme nenašli žádnou odpověď.")).toBeTruthy();
  await user.click(shipping);
  expect(search).toHaveProperty("value", "");
  expect(screen.getByRole("button", { name: /Jaké dopravce mohu využít/ })).toBeTruthy();
});
