import { createHash } from "node:crypto";
import { Effect, Option, Schema } from "effect";

const VariableNameSchema = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9/ -]*$/u));
const TokenEntrySchema = Schema.Tuple([
  VariableNameSchema,
  Schema.Literals(["COLOR", "FLOAT", "STRING"]),
  Schema.OptionFromNullOr(VariableNameSchema),
  Schema.Union([Schema.String, Schema.Number]),
]);
const ThemeSnapshotSchema = Schema.Struct({
  collection: Schema.Literal("Theme"),
  collectionId: Schema.Literal("VariableCollectionId:38:341"),
  entries: Schema.Array(TokenEntrySchema),
  file: Schema.Literal("gi5GUSWwAeXknaKEeLqK5w"),
  mode: Schema.Literal("N1"),
  modeId: Schema.Literal("4082:0"),
  schemaVersion: Schema.Literal(2),
});
export type TokenEntry = typeof TokenEntrySchema.Type;
type ThemeSnapshot = typeof ThemeSnapshotSchema.Type;
export const decodeCanonicalTheme = Schema.decodeUnknownEffect(ThemeSnapshotSchema, {
  onExcessProperty: "error",
});
export const CanonicalThemeJsonSchema = Schema.fromJsonString(ThemeSnapshotSchema);

export class ThemeContractInvalid extends Schema.TaggedError<ThemeContractInvalid>()(
  "ThemeContractInvalid",
  {
    message: Schema.String,
    reason: Schema.Literals(["literal", "duplicate", "alias", "cycle", "stale"]),
  },
) {}

const variableName = (name: string): string => `--${name.replaceAll(/[ /]+/gu, "-")}`;
const literal = ([name, type, , value]: TokenEntry) =>
  Effect.gen(function* renderLiteral() {
    if (
      type === "COLOR" &&
      Schema.is(Schema.String)(value) &&
      /^(?:#[a-f0-9]{6}|rgba[(][0-9., ]+[)])$/iu.test(value)
    ) {
      return value;
    }
    if (type === "STRING" && Schema.is(Schema.String)(value) && !/[;{}]/u.test(value)) {
      return value;
    }
    if (type === "FLOAT" && Schema.is(Schema.Number)(value) && Number.isFinite(value)) {
      if (/^(?:opacity|font-weight)\//u.test(name)) {
        return String(value);
      }
      if (name.startsWith("duration/")) {
        return `${value}s`;
      }
      if (name.startsWith("brightness/")) {
        return `${value}%`;
      }
      return `${value}px`;
    }
    return yield* new ThemeContractInvalid({ message: name, reason: "literal" });
  });

/** Accept the decoded canonical contract, not an unparsed object or storefront overlay. */
export const renderCanonicalTheme = (snapshot: ThemeSnapshot, source: string) =>
  Effect.gen(function* renderTheme() {
    const entries = new Map<string, TokenEntry>();
    for (const entry of snapshot.entries) {
      const name = variableName(entry[0]);
      if (entries.has(name)) {
        return yield* new ThemeContractInvalid({ message: name, reason: "duplicate" });
      }
      entries.set(name, entry);
    }
    const resolve = (
      name: string,
      path: ReadonlySet<string>,
    ): Effect.Effect<string, ThemeContractInvalid> =>
      Effect.gen(function* resolveAlias() {
        if (path.has(name)) {
          return yield* new ThemeContractInvalid({ message: name, reason: "cycle" });
        }
        const entry = entries.get(name);
        if (!entry) {
          return yield* new ThemeContractInvalid({ message: name, reason: "alias" });
        }
        if (Option.isNone(entry[2])) {
          return yield* literal(entry);
        }
        return yield* resolve(variableName(entry[2].value), new Set([...path, name]));
      });
    const declarations: string[] = [];
    for (const [name, entry] of [...entries].toSorted(([left], [right]) =>
      left.localeCompare(right),
    )) {
      yield* resolve(name, new Set());
      const cssValue = Option.isNone(entry[2])
        ? yield* literal(entry)
        : `var(${variableName(entry[2].value)})`;
      declarations.push(`  ${name}: ${cssValue};`);
    }
    const digest = createHash("sha256").update(source).digest("hex");
    const css = `/* Generated from canonical New Design System / Theme / N1. Do not edit.
 * Source: ${snapshot.file}, collection ${snapshot.collectionId}, mode ${snapshot.modeId}.
 * Snapshot SHA-256: ${digest}
 * The UI kit already registers these token utilities through @theme static.
 * This unlayered brand scope activates their canonical values after kit defaults.
 */
[data-theme="n1"] {
${declarations.join("\n")}
}
`;
    return { count: entries.size, css };
  });
