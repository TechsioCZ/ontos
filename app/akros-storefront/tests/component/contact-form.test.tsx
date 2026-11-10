import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ContactForm } from "@/components/contact-form";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const fill = (message = "Prosím o ověření dostupnosti.") => {
  for (const [id, value] of [
    ["contact-name", "Zákazník"],
    ["contact-email", "customer@example.test"],
    ["contact-message", message],
  ])
    fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const form = () => document.querySelector("form") as HTMLFormElement;
type Fetch = typeof globalThis.fetch;
const sentRequestIds = (calls: readonly Parameters<Fetch>[]) =>
  calls.map(([, init]) => (JSON.parse(String(init?.body)) as { requestId: string }).requestId);
const unconfirmed = () =>
  Response.json({ message: "Přijetí dotazu se nepodařilo potvrdit." }, { status: 503 });

it("sends one request for a double submit of the same form", async () => {
  let answer: (response: Response) => void = () => {};
  const fetch = vi.fn<Fetch>(
    () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetch);
  render(<ContactForm />);
  fill();
  // The second submit arrives while the first request is still unanswered.
  fireEvent.submit(form());
  fireEvent.submit(form());
  expect(fetch).toHaveBeenCalledTimes(1);
  answer(Response.json({ taskId: "persisted-task" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("persisted-task"));
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("keeps the request id of an unchanged submission and renews it for changed content", async () => {
  const fetch = vi.fn<Fetch>(async () => unconfirmed());
  vi.stubGlobal("fetch", fetch);
  render(<ContactForm />);
  fill();
  fireEvent.submit(form());
  await waitFor(() => expect(screen.getByRole("alert")).not.toBeNull());
  // The same text again is the same submission: the owner answers its existing task, never a second one.
  fireEvent.submit(form());
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByRole("alert")).not.toBeNull());
  fill("Jiný dotaz.");
  fireEvent.submit(form());
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  const [first, second, third] = sentRequestIds(fetch.mock.calls);
  expect(first).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u);
  expect(second).toBe(first);
  expect(third).not.toBe(first);
});

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
