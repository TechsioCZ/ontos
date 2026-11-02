import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddressAutocomplete } from "@/features/checkout/address-autocomplete";

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

  it("renders and selects one of multiple suggestions with unique option values", async () => {
    // jsdom has no layout observer; popup geometry is covered in the browser suite.
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
    const options = screen.getAllByRole("option");
    expect(new Set(options.map((option) => option.getAttribute("data-value")))).toEqual(
      new Set(["address-1", "address-2"]),
    );
    expect(new Set(options.map((option) => option.id)).size).toBe(2);
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
