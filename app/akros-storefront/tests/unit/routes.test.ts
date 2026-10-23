import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";

it("records storefront Worker invocations without enabling traces", () => {
  const config = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../wrangler.jsonc"), "utf8").replace(
      /,(\s*[}\]])/gu,
      "$1",
    ),
  ) as { observability: unknown };
  expect(config.observability).toEqual({
    logs: { enabled: true, invocation_logs: true },
    traces: { enabled: false },
  });
});

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

  it("maps the public M8 nut shortcut to its source family and purchasing variant", async () => {
    const rewrites = await nextConfig.rewrites?.();

    expect(rewrites).toContainEqual({
      source: "/matice-sestihranna-m8-din-934-a2",
      destination: "/produkt/matice-sestihranne-0-8-d-din-934-a2?variant=10093400080000",
    });
  });
});
