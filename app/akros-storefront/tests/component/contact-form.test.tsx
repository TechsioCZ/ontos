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

it("prefills the message with the product and the selected variants", () => {
  const defaultMessage =
    "Produkt: Šrouby\nKód produktu: S-1\nVarianta: S-1-20 — M 6 × 20\n\nMůj dotaz:\n";
  render(
    <ContactForm
      kind="PRODUCT_QUESTION"
      productId="p1"
      productName="Šrouby"
      defaultMessage={defaultMessage}
    />,
  );
  expect((document.getElementById("contact-message") as HTMLTextAreaElement).value).toBe(
    defaultMessage,
  );
});
