import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ContactForm } from "@/components/contact-form";

afterEach(cleanup);
it("prefills a product inquiry from its resolved owner name", () => {
  render(
    <ContactForm kind="PRODUCT_QUESTION" productId="p1" productName="Kotevní šrouby AN 9003/A4" />,
  );
  expect(screen.getByText("Kotevní šrouby AN 9003/A4")).not.toBeNull();
  expect((screen.getByRole("textbox", { name: "Předmět" }) as HTMLInputElement).value).toBe(
    "Dotaz na produkt: Kotevní šrouby AN 9003/A4",
  );
});
