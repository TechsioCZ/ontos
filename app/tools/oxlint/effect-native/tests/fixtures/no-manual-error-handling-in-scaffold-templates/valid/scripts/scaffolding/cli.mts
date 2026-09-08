/**
 * The generator's OWN control flow, not emitted text. Script-level throws and native error
 * narrowing are owned by `no-throw-in-scripts` / `no-native-error-construction`; this rule only
 * looks inside template literals.
 */
type ScaffoldFailure =
  | { readonly _tag: "TemplateMissing"; readonly name: string }
  | { readonly _tag: "WriteRefused"; readonly path: string };

export const describeFailure = (failure: ScaffoldFailure): string => {
  switch (failure._tag) {
    case "TemplateMissing":
      return `missing template ${failure.name}`;
    default:
      return `refused ${failure.path}`;
  }
};

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : "Unknown scaffolding failure";

export const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

export const write = async (path: string): Promise<string> =>
  writeFile(path).catch((error) => {
    if (messageOf(error).includes("EEXIST")) {
      return "exists";
    }
    return "failed";
  });

declare function writeFile(path: string): Promise<string>;
