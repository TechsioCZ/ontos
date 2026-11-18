import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type FormEvent } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AddressFields } from "@/features/checkout/address-fields";
import type { CheckoutAddress } from "@/features/checkout/checkout-state";
import { AddressAutocomplete } from "@/features/checkout/address-autocomplete";

// jsdom cannot scroll an option into view; the real combobox still handles selection.
const scrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {},
  });
});
afterAll(() => {
  if (scrollIntoView === undefined) {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  } else {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollIntoView);
  }
});

function AddressField({ country = "CZ" }: { country?: string }) {
  const [street, setStreet] = useState("");
  return (
    <AddressAutocomplete
      id="billing-street"
      value={street}
      country={country}
      onInput={setStreet}
      onSelect={(parts) => setStreet(parts.street ?? street)}
    />
  );
}

describe("checkout address suggestions", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("selects the requested address from multiple suggestions", async () => {
    // jsdom has no layout observer; use the real kit without inventing geometry.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              suggestions: [1, 2].map((number) => ({
                id: `address-${number}`,
                displayLabel: `Bakalovo nábřeží ${number}, Brno`,
                address: {
                  street: "Bakalovo nábřeží",
                  houseNumber: String(number),
                  city: "Brno",
                  countryCode: "CZ",
                },
              })),
            }),
          ),
      ),
    );
    render(<AddressField />);
    const user = userEvent.setup();
    await user.type(screen.getByRole("combobox"), "Bakalovo");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    await user.click(screen.getByRole("option", { name: "Bakalovo nábřeží 2, Brno" }));
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("Bakalovo nábřeží 2");
  });

  it("keeps manual entry without contacting the provider for an uncovered address country", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    render(<AddressField country="SK" />);
    const user = userEvent.setup();
    expect(screen.queryByRole("combobox")).toBeNull();
    await user.type(screen.getByRole("textbox", { name: /Ulice/ }), "Obchodná 10");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect((screen.getByRole("textbox", { name: /Ulice/ }) as HTMLInputElement).value).toBe(
      "Obchodná 10",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});

const address: CheckoutAddress = {
  firstName: "Jan",
  lastName: "Test",
  street: "Old street 1",
  city: "Praha",
  postalCode: "110 00",
  country: "CZ",
  phone: "+420777123456",
};
function AddressPair() {
  const [billing, setBilling] = useState(address);
  const [delivery, setDelivery] = useState({ ...address, street: "Delivery street 2" });
  return (
    <>
      <section aria-label="Billing">
        <AddressFields address={billing} prefix="billing" errors={{}} onChange={setBilling} />
      </section>
      <section aria-label="Delivery">
        <AddressFields address={delivery} prefix="delivery" errors={{}} onChange={setDelivery} />
      </section>
    </>
  );
}

const suggestion = {
  id: "brno",
  displayLabel: "Brno",
  address: { city: "Brno", countryCode: "CZ" },
};

// These cover the module-specific behavior formerly buried in the obsolete account/checkout browser sweep.
describe("address completion behavior", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  it("applies partial suggestions to billing only, preserving entered fields and delivery", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockImplementation(async () => Response.json({ suggestions: [suggestion] })),
    );
    render(<AddressPair />);
    const user = userEvent.setup();
    const billing = within(screen.getByRole("region", { name: "Billing" }));
    const delivery = within(screen.getByRole("region", { name: "Delivery" }));
    await user.clear(billing.getByRole("combobox", { name: /Ulice/ }));
    await user.type(billing.getByRole("combobox", { name: /Ulice/ }), "Brno");
    await user.click(await screen.findByRole("option", { name: "Brno" }));
    expect(billing.getByLabelText(/Město/)).toHaveProperty("value", "Brno");
    expect(billing.getByLabelText(/PSČ/)).toHaveProperty("value", "110 00");
    expect(billing.getByLabelText(/Jméno/)).toHaveProperty("value", "Jan");
    expect(delivery.getByRole("combobox", { name: /Ulice/ })).toHaveProperty(
      "value",
      "Delivery street 2",
    );
    expect(delivery.getByLabelText(/Město/)).toHaveProperty("value", "Praha");
  });
  it("keeps manual input on outage and retries without submitting the surrounding form", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response("offline", { status: 503 }))
        .mockImplementation(async () => Response.json({ suggestions: [suggestion] })),
    );
    const submit = vi.fn<(event: FormEvent) => void>((event) => event.preventDefault());
    render(
      <form onSubmit={submit}>
        <AddressField />
      </form>,
    );
    const user = userEvent.setup();
    const input = screen.getByRole("combobox");
    await user.type(input, "Manual street 1");
    const retry = await screen.findByRole("button", { name: "Zkusit znovu" });
    expect(input).toHaveProperty("value", "Manual street 1");
    await user.click(retry);
    expect(await screen.findByRole("option", { name: "Brno" })).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
  });
  it("does not replace newer empty results with a late response to an old query", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    let resolveOld: (response: Response) => void = () => {
      throw new Error("Old request not started");
    };
    const old = new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(old)
      .mockResolvedValue(Response.json({ suggestions: [] }));
    vi.stubGlobal("fetch", fetcher);
    render(<AddressField />);
    const user = userEvent.setup();
    const input = screen.getByRole("combobox");
    await user.type(input, "Old street");
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await user.clear(input);
    await user.type(input, "New street");
    await screen.findByText("Služba nenašla návrhy. Adresu můžete zadat ručně.");
    await act(async () => {
      resolveOld(Response.json({ suggestions: [suggestion] }));
      await old;
    });
    expect(input).toHaveProperty("value", "New street");
    expect(screen.queryByRole("option")).toBeNull();
  });
});
