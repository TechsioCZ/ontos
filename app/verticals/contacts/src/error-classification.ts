/**
 * The presentation layer classifies failures only by their stable discriminants.
 * Keeping that projection explicit lets tests exercise the closed vocabulary without
 * fabricating transport- and schema-library implementation details.
 */
export type ErrorClassificationInput<Failure> = Failure extends {
  readonly _tag: infer Tag extends string;
}
  ? { readonly _tag: Tag } & (Failure extends { readonly code: infer Code }
      ? { readonly code?: Code }
      : unknown) &
      (Failure extends { readonly reason: { readonly _tag: string } }
        ? { readonly reason: { readonly _tag: string } }
        : unknown)
  : never;
