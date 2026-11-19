import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ContactForm } from "@/components/contact-form";
import { browserAt, serveHttp } from "../support/http";
import { renderStorefront as render } from "../support/storefront";

afterEach(cleanup);
const fill = (message = "Prosím o ověření dostupnosti.") => {
  for (const [label, value] of [
    ["Jméno", "Zákazník"],
    ["E-mail", "customer@example.test"],
    ["Zpráva", message],
  ])
    fireEvent.change(screen.getByRole("textbox", { name: new RegExp(`^${label}`, "u") }), {
      target: { value },
    });
};
const form = () => {
  const element = screen.getByRole("textbox", { name: "Předmět" }).closest("form");
  if (!element) throw new Error("Missing contact form");
  return element;
};
const sentRequestIds = (requests: readonly Request[]) =>
  Promise.all(
    requests.map(async (request) => {
      const body: unknown = await request.json();
      if (
        typeof body !== "object" ||
        body === null ||
        !("requestId" in body) ||
        typeof body.requestId !== "string"
      )
        throw new Error("Inquiry request must contain a requestId");
      return body.requestId;
    }),
  );
const unconfirmed = () =>
  Response.json({ message: "Přijetí dotazu se nepodařilo potvrdit." }, { status: 503 });

it("sends one request for a double submit of the same form", async () => {
  const arrived = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<Response>();
  const network = await serveHttp((request) => {
    if (new URL(request.url).pathname !== "/api/ontos/inquiries" || request.method !== "POST")
      return new Response("Unknown endpoint", { status: 404 });
    arrived.resolve();
    return answer.promise;
  });
  browserAt(network.origin);
  try {
    render(<ContactForm />);
    fill();
    // The second submit arrives while the first request is still unanswered.
    fireEvent.submit(form());
    fireEvent.submit(form());
    await arrived.promise;
    expect(network.requests).toHaveLength(1);
    answer.resolve(Response.json({ taskId: "persisted-task" }));
    expect((await screen.findByRole("status")).textContent).toContain("persisted-task");
    await network.idle();
    expect(network.requests).toHaveLength(1);
  } finally {
    answer.resolve(Response.json({ taskId: "persisted-task" }));
    cleanup();
    await network.idle();
    await network.close();
  }
});

it("keeps the request id of an unchanged submission and renews it for changed content", async () => {
  const network = await serveHttp((request) => {
    if (new URL(request.url).pathname !== "/api/ontos/inquiries" || request.method !== "POST")
      return new Response("Unknown endpoint", { status: 404 });
    return unconfirmed();
  });
  browserAt(network.origin);
  try {
    render(<ContactForm />);
    fill();
    fireEvent.submit(form());
    expect(await screen.findByRole("alert")).not.toBeNull();
    // The same text again is the same submission: the owner answers its existing task, never a second one.
    fireEvent.submit(form());
    expect(await screen.findByRole("alert")).not.toBeNull();
    await network.idle();
    expect(network.requests).toHaveLength(2);
    fill("Jiný dotaz.");
    fireEvent.submit(form());
    expect(await screen.findByRole("alert")).not.toBeNull();
    await network.idle();
    expect(network.requests).toHaveLength(3);
    const [first, second, third] = await sentRequestIds(network.requests);
    expect(first).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u);
    expect(second).toBe(first);
    expect(third).not.toBe(first);
  } finally {
    cleanup();
    await network.idle();
    await network.close();
  }
});

it("prefills a product inquiry from its resolved owner name", () => {
  render(
    <ContactForm kind="PRODUCT_QUESTION" productId="p1" productName="Kotevní šrouby AN 9003/A4" />,
  );
  expect(screen.getByText("Kotevní šrouby AN 9003/A4")).not.toBeNull();
  expect(screen.getByRole("textbox", { name: "Předmět" })).toHaveProperty(
    "value",
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
  expect(screen.getByRole("textbox", { name: /^Zpráva/u })).toHaveProperty("value", defaultMessage);
});
