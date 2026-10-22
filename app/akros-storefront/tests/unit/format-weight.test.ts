import { describe, expect, it } from "vitest";
import { formatWeight } from "@/lib/format";

describe("formatWeight", () => {
  it("preserves the source precision and explicitly states kilograms", () => {
    expect(formatWeight(0.0034)).toBe("0,0034 kg");
    expect(formatWeight(0.00691)).toBe("0,00691 kg");
    expect(formatWeight(0.00003)).toBe("0,00003 kg");
    expect(formatWeight(0.204)).toBe("0,204 kg");
  });

  it("does not turn unknown or invalid weights into a zero weight", () => {
    for (const weight of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatWeight(weight)).toBeNull();
    }
  });
});
