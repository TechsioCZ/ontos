import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SiteHeader } from "@/components/site-header";
import { CartProvider } from "@/features/cart/cart-provider";

const { push } = vi.hoisted(() => ({ push: vi.fn<(href: string) => void>() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

describe("SiteHeader search", () => {
  beforeEach(() => {
    push.mockReset();
  });

  it("submits a trimmed query through an accessible icon button", async () => {
    const user = userEvent.setup();

    render(
      <CartProvider storage={null}>
        <SiteHeader />
      </CartProvider>,
    );

    const submit = screen.getByRole("button", { name: "Hledat" });
    expect(submit.textContent).toBe("");

    await user.type(screen.getByRole("searchbox", { name: "Vyhledat v katalogu" }), "  M8 A4  ");
    await user.click(submit);

    expect(push).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith("/vyhledavani?q=M8%20A4");
  });
});
