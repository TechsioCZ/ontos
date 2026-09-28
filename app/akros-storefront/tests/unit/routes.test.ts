import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";

describe("public storefront rewrites", () => {
  it("maps public category shortcuts to categories that exist in the feed", async () => {
    const rewrites = await nextConfig.rewrites?.();

    expect(rewrites).toEqual(
      expect.arrayContaining([
        {
          source: "/zavitove-tyce",
          destination: "/kategorie/zavitove-tyce-a-svorniky",
        },
        {
          source: "/kotevni-technika",
          destination: "/kategorie/kotevni-technikalepidla",
        },
        {
          source: "/retezy-a-lana",
          destination: "/kategorie/lanaretezypantyjachtdopln",
        },
      ]),
    );
  });
});
