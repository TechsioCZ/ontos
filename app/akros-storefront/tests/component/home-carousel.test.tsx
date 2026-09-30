import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HomeCarousel } from "@/components/home-carousel";
import { homeCarouselSlides } from "@/mock-storefront/fixtures/home-carousel";

const originalScrollTo = Element.prototype.scrollTo;
const originalScrollBy = Element.prototype.scrollBy;

describe("HomeCarousel", () => {
  beforeEach(() => {
    Element.prototype.scrollTo = vi.fn<() => void>();
    Element.prototype.scrollBy = vi.fn<() => void>();
    // jsdom has no layout; supply the measured banner geometry for Zag snap points.
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(933);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(260);
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.getAttribute("data-part") === "item-group" ? 933 * 6 : 933;
      },
    );
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(260);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        const index = Number(this.getAttribute("data-index") ?? 0);
        return new DOMRect(index * 933, 0, 933, 260);
      },
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Element.prototype.scrollTo = originalScrollTo;
    Element.prototype.scrollBy = originalScrollBy;
  });

  it("renders six original local banners without duplicate promotional text", () => {
    const { container } = render(<HomeCarousel />);
    const images = screen.getAllByRole("img", { hidden: true });

    expect(images).toHaveLength(6);
    expect(screen.getAllByRole("button", { name: /Zobrazit banner/ })).toHaveLength(6);
    homeCarouselSlides.forEach((slide, index) => {
      expect(images[index].getAttribute("alt")).toBe(slide.alt);
      expect(images[index].getAttribute("src")).toContain(encodeURIComponent(slide.src));
      expect(images[index].getAttribute("width")).toBe("933");
      expect(images[index].getAttribute("height")).toBe("260");
      expect(images[index].getAttribute("loading")).toBe(index === 0 ? "eager" : "lazy");
    });
    expect(images[0].getAttribute("fetchpriority")).toBe("high");
    expect(container.querySelectorAll("[data-part=item]")).toHaveLength(6);
    expect(screen.queryByText("Partnerský program")).toBeNull();
    expect(screen.queryByRole("button", { name: "VSTOUPIT" })).toBeNull();
  });

  it("preserves local destinations and the original external banner links", () => {
    const { container } = render(<HomeCarousel />);
    const links = Array.from(container.querySelectorAll("a"));

    expect(links.map((link) => link.getAttribute("href"))).toEqual(
      homeCarouselSlides.flatMap((slide) => (slide.href ? [slide.href] : [])),
    );
    expect(links.every((link) => link.tabIndex === -1)).toBe(true);
  });

  it("selects banners through indicators and keeps only the active link tabbable", async () => {
    const user = userEvent.setup();
    const { container } = render(<HomeCarousel />);
    const indicator = screen.getByRole("button", { name: "Zobrazit banner 2" });

    await user.click(indicator);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Zobrazit banner 2" }).hasAttribute("data-current"),
      ).toBe(true),
    );
    const links = Array.from(container.querySelectorAll("a"));
    expect(links[0].tabIndex).toBe(0);
    expect(links.slice(1).every((link) => link.tabIndex === -1)).toBe(true);

    await user.keyboard("{ArrowRight}");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Zobrazit banner 3" }).hasAttribute("data-current"),
      ).toBe(true),
    );
    expect(links[0].tabIndex).toBe(-1);
    expect(links[1].tabIndex).toBe(0);
  });

  it("switches banners in both directions and wraps using the arrow controls", async () => {
    const user = userEvent.setup();
    render(<HomeCarousel />);

    await user.click(screen.getByRole("button", { name: "Další banner" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Zobrazit banner 2" }).hasAttribute("data-current"),
      ).toBe(true),
    );

    await user.click(screen.getByRole("button", { name: "Předchozí banner" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Zobrazit banner 1" }).hasAttribute("data-current"),
      ).toBe(true),
    );

    await user.click(screen.getByRole("button", { name: "Předchozí banner" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Zobrazit banner 6" }).hasAttribute("data-current"),
      ).toBe(true),
    );

    await user.click(screen.getByRole("button", { name: "Další banner" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Zobrazit banner 1" }).hasAttribute("data-current"),
      ).toBe(true),
    );
  });

  it("does not follow a banner link after a mouse drag", async () => {
    const user = userEvent.setup();
    const { container } = render(<HomeCarousel />);
    await user.click(screen.getByRole("button", { name: "Zobrazit banner 2" }));
    const link = container.querySelector("a");
    const image = screen.getByAltText(homeCarouselSlides[1].alt);
    const group = container.querySelector("[data-part=item-group]");

    fireEvent.mouseDown(image, { button: 0 });
    await waitFor(() => expect(group?.hasAttribute("data-dragging")).toBe(true));
    fireEvent(
      document,
      new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 100, buttons: 1 }),
    );
    await waitFor(() => expect(Element.prototype.scrollBy).toHaveBeenCalled());
    fireEvent(document, new MouseEvent("pointerup", { bubbles: true }));
    await waitFor(() => expect(group?.hasAttribute("data-dragging")).toBe(false));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });

    if (!link) throw new Error("Partner banner link is missing");
    fireEvent(link, click);
    expect(click.defaultPrevented).toBe(true);

    let preventedAtDocument: boolean | undefined;
    document.addEventListener(
      "click",
      (event) => {
        preventedAtDocument = event.defaultPrevented;
        event.preventDefault(); // Do not let jsdom attempt an actual navigation.
      },
      { once: true },
    );
    fireEvent(link, new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    expect(preventedAtDocument).toBe(false);
  });
});
