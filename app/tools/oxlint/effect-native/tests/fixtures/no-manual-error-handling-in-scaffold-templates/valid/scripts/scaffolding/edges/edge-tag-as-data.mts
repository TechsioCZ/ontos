/** Every shape the audit blesses, emitted verbatim: tags as contract data, `Effect.catchTag(s)`,
 *  exhaustive `Match`, `Layer.orDie` at the startup root, `JSON.stringify` for a body, native
 *  array operations, a non-branching promise `.catch`, and `instanceof Error` at the single outer
 *  adapter seam where an external library throws an untyped value. */
export const renderModule = (stem: string): string => `
export const ${stem}Problem = Schema.Struct({
  _tag: Schema.Literal('${stem}Problem'),
  status: Schema.Number,
});
export const literal = { _tag: '${stem}Problem' as const, status: 422 };

const { _tag } = problemLiteral;
const kind = problemLiteral['_tag'];

const program = read().pipe(
  Effect.catchTag('ReadUnavailable', () => Effect.fail(unavailableProblem())),
  Effect.catchTags({ ReadPermissionDenied: () => Effect.fail(forbiddenProblem()) }),
  Effect.catchCause((cause) => Effect.fail(internalProblem(Cause.pretty(cause)))),
);

export const problemFor = Match.type<ReadCoreError>().pipe(
  Match.tag('ReadUnavailable', () => unavailableProblem()),
  Match.exhaustive,
);

const runtimeLayer = Layer.orDie(ApplicationLive);
const body = JSON.stringify({ ok: true, kind, _tag });
const ids = rows.map((row) => row.id).filter((id) => id.length > 0);

export const report = () => send(body).catch((err) => {
  logger.error(err);
  return null;
});

export const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
`;
