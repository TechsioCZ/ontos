// expect-count: 1
export function classify(error: { readonly _tag: "Missing" | "Other" }, record: () => void) {
  switch ((record(), error._tag)) {
    case "Missing": return 404;
    default: return 500;
  }
}
