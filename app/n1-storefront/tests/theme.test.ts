import { Effect } from "effect";
import { describe, expect, it } from "effect-rstest";
import snapshot from "../src/tokens/figma/n1.json";
import { decodeCanonicalTheme, renderCanonicalTheme } from "../scripts/figma-theme.ts";

type RawEntry = readonly [string, "COLOR" | "FLOAT" | "STRING", string | null, string | number];
const render = (entries: readonly RawEntry[]) =>
  decodeCanonicalTheme({ ...snapshot, entries }).pipe(
    Effect.orDie,
    Effect.flatMap((decoded) => renderCanonicalTheme(decoded, JSON.stringify(entries))),
  );

describe("canonical N1 theme contract", () => {
  it.effect("renders the library export without storefront overlays", () =>
    Effect.gen(function* testCanonicalTheme() {
      const decoded = yield* decodeCanonicalTheme(snapshot);
      const { count, css } = yield* renderCanonicalTheme(decoded, JSON.stringify(snapshot));
      expect(count).toBe(snapshot.entries.length);
      expect(css).toContain('[data-theme="n1"]');
      expect(css).toContain("--color-bg-primary-base: var(--color-primary-500);");
      expect(css).toContain("--color-fg-on-primary-solid-neo: var(--color-neutral-950);");
      expect(css).not.toContain("--color-search-suggestions-");
    }),
  );
  it.effect("preserves units and CSS string values", () =>
    Effect.gen(function* testTokenUnits() {
      const { css } = yield* render([
        ["opacity/disabled", "FLOAT", null, 0.6],
        ["font-weight/extra light", "FLOAT", null, 200],
        ["duration/slow", "FLOAT", null, 3],
        ["brightness/100", "FLOAT", null, 100],
        ["dimension/16", "FLOAT", null, 16],
        ["aspect/landscape", "STRING", null, "4 / 3"],
        ["shadow/sm", "STRING", null, "0 1px 2px rgba(0, 0, 0, 0.05)"],
      ]);
      for (const declaration of [
        "--opacity-disabled: 0.6;",
        "--font-weight-extra-light: 200;",
        "--duration-slow: 3s;",
        "--brightness-100: 100%;",
        "--dimension-16: 16px;",
        "--aspect-landscape: 4 / 3;",
        "--shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);",
      ]) {
        expect(css).toContain(declaration);
      }
    }),
  );
  it.effect("rejects a different file and extra overlays", () =>
    Effect.gen(function* testCanonicalSource() {
      const wrongFile = yield* Effect.flip(
        decodeCanonicalTheme({ ...snapshot, file: "gIHtMwCCl2OXhMAW9s9LIn" }),
      );
      const overlay = yield* Effect.flip(decodeCanonicalTheme({ ...snapshot, overrides: [] }));
      expect(wrongFile.message).toContain("file");
      expect(overlay.message).toContain("overrides");
    }),
  );
  it.effect("rejects missing and cyclic aliases", () =>
    Effect.gen(function* testInvalidAliases() {
      const missing = yield* Effect.flip(
        render([["color/a", "COLOR", "color/missing", "#ffffff"]]),
      );
      const cycle = yield* Effect.flip(
        render([
          ["color/a", "COLOR", "color/b", "#ffffff"],
          ["color/b", "COLOR", "color/a", "#ffffff"],
        ]),
      );
      expect(missing.reason).toBe("alias");
      expect(cycle.reason).toBe("cycle");
    }),
  );
  it.effect("rejects duplicate normalized names", () =>
    Effect.gen(function* testDuplicateNames() {
      const duplicate = yield* Effect.flip(
        render([
          ["font-weight/extra light", "FLOAT", null, 200],
          ["font-weight/extra-light", "FLOAT", null, 200],
        ]),
      );
      expect(duplicate.reason).toBe("duplicate");
    }),
  );
});
