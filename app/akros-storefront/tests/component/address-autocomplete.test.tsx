import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddressAutocomplete } from "@/features/checkout/address-autocomplete";

function AddressField() {
  const [street, setStreet] = useState("");
  return (
    <AddressAutocomplete
      id="billing-street"
      value={street}
      country="CZ"
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

  it("renders and selects multiple suggestions without React list-key warnings", async () => {
    // jsdom has no layout observer; popup geometry is covered in the browser suite.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const consoleError = vi.spyOn(console, "error");
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
    expect(
      consoleError.mock.calls.filter((args) =>
        args.some((arg) => typeof arg === "string" && arg.includes('unique "key"')),
      ),
    ).toEqual([]);
  });
});
