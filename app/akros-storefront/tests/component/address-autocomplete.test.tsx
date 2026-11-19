// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type FormEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddressFields } from "@/features/checkout/address-fields";
import type { CheckoutAddress } from "@/features/checkout/checkout-state";
import { AddressAutocomplete } from "@/features/checkout/address-autocomplete";

/** happy-dom's own fetch seam (`IFetchInterceptor`): it may answer a request with a Response of the sending window. */
interface FetchInterceptor {
  readonly beforeAsyncRequest: (context: {
    readonly request: Request;
    readonly window: { readonly Response: typeof Response };
  }) => Promise<Response>;
}
declare global {
  interface Window {
    readonly happyDOM: {
      readonly settings: { readonly fetch: { interceptor: FetchInterceptor | null } };
    };
  }
}

// The same-origin suggestion route is answered in process through the browser's own request interceptor; the
// component, the UI kit and the browser's fetch are real.
const queries: string[] = [];
let answer: (query: string) => Promise<Response> = async () => Response.json({ suggestions: [] });
let previousInterceptor: typeof window.happyDOM.settings.fetch.interceptor;
beforeEach(() => {
  queries.length = 0;
  answer = async () => Response.json({ suggestions: [] });
  previousInterceptor = window.happyDOM.settings.fetch.interceptor;
  window.happyDOM.settings.fetch.interceptor = {
    beforeAsyncRequest: async ({ request, window }) => {
      const url = new URL(request.url);
      if (url.pathname !== "/api/address-suggestions") {
        throw new Error(`Unexpected request: ${request.url}`);
      }
      const query = url.searchParams.get("q") ?? "";
      queries.push(query);
      const response = await answer(query);
      return new window.Response(await response.arrayBuffer(), {
        headers: [...response.headers],
        status: response.status,
      });
    },
  };
});
afterEach(() => {
  cleanup();
  window.happyDOM.settings.fetch.interceptor = previousInterceptor;
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
  it("selects the requested address from multiple suggestions", async () => {
    answer = async () =>
      Response.json({
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
      });
    render(<AddressField />);
    const user = userEvent.setup();
    await user.type(screen.getByRole("combobox"), "Bakalovo");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    await user.click(screen.getByRole("option", { name: "Bakalovo nábřeží 2, Brno" }));
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("Bakalovo nábřeží 2");
  });

  it("keeps manual entry without contacting the provider for an uncovered address country", async () => {
    render(<AddressField country="SK" />);
    const user = userEvent.setup();
    expect(screen.queryByRole("combobox")).toBeNull();
    await user.type(screen.getByRole("textbox", { name: /Ulice/ }), "Obchodná 10");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect((screen.getByRole("textbox", { name: /Ulice/ }) as HTMLInputElement).value).toBe(
      "Obchodná 10",
    );
    expect(queries).toEqual([]);
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
  it("applies partial suggestions to billing only, preserving entered fields and delivery", async () => {
    answer = async () => Response.json({ suggestions: [suggestion] });
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
    answer = async () => {
      answer = async () => Response.json({ suggestions: [suggestion] });
      return new Response("offline", { status: 503 });
    };
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
    let resolveOld: (response: Response) => void = () => {
      throw new Error("Old request not started");
    };
    const old = new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });
    answer = async (query) => (query === "Old street" ? old : Response.json({ suggestions: [] }));
    render(<AddressField />);
    const user = userEvent.setup();
    const input = screen.getByRole("combobox");
    await user.type(input, "Old street");
    await waitFor(() => expect(queries).toEqual(["Old street"]));
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
