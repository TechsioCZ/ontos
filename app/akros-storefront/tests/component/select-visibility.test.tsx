import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Select } from "@techsio/ui-kit/molecules/select";

afterEach(cleanup);

it.each([
  ["__all__", "Všechny stavy"],
  ["NEW", "Nová"],
  ["SHIPPED", "Předáno dopravci"],
])(
  "keeps the native select for %s clipped without relying on sr-only CSS",
  async (value, label) => {
    const { container } = render(
      <Select items={[{ value, label }]} name="order-status" value={[value]}>
        <Select.Control>
          <Select.Trigger aria-label="Stav objednávky">
            <Select.ValueText />
          </Select.Trigger>
        </Select.Control>
      </Select>,
    );
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Stav objednávky" }).textContent).toContain(
        label,
      ),
    );
    const native = container.querySelector("select");
    expect(native?.getAttribute("aria-hidden")).toBe("true");
    expect(native?.tabIndex).toBe(-1);
    expect(native?.value).toBe(value);
    expect(native?.textContent).toBe(value);
    expect(native?.style.position).toBe("absolute");
    expect(native?.style.width).toBe("1px");
    expect(native?.style.height).toBe("1px");
    expect(native?.style.overflow).toBe("hidden");
    expect(native?.style.clip).toMatch(/^rect\(0(?:px)?(?:[, ]+0(?:px)?){0,3}\)$/);
  },
);
