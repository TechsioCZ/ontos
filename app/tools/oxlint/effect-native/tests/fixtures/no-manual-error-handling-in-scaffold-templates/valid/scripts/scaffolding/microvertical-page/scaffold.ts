/** Emitted text that never discriminates a failure by hand. */
export const renderPageLoader = (route: string): string => `
  export const load = () =>
    client.read({ route: '${route}' }).pipe(
      Effect.catchTag('ReadUnavailable', () => Effect.succeed(fallback())),
      Effect.catch((error) => Effect.fail(toProblem(error))),
      Effect.withSpan('${route}.load'),
    );

  export const problemFor = Match.type<ReadCoreError>().pipe(
    Match.tag('ReadUnavailable', () => unavailableProblem()),
    Match.exhaustive,
  );
`;

/** A tag emitted as contract *data* is the target shape, not a comparison. */
export const renderProblemSchema = (stem: string): string => `
  export const ${stem}Problem = Schema.Struct({
    _tag: Schema.Literal('${stem}Problem'),
    status: Schema.Number,
  });
  export const literal = { _tag: '${stem}Problem' as const, status: 422 };
`;
