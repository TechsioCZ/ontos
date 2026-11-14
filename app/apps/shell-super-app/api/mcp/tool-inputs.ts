/** Native contracts for the generic MCP operations; Action inputs remain owned by their catalog schemas. */
import { Data, Effect, Iterable, Result, Schema } from 'effect';

export class InvalidToolArguments extends Data.TaggedError('InvalidToolArguments')<{
  readonly cause: Error;
  readonly message: string;
}> {}

export const CallerIntentKeySchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[!-~]+$/u),
)
  .pipe(Schema.brand('CallerIntentKey'))
  .annotate({
    description:
      'Povinný klíč této změny od volajícího. Při opakování zachovej přesně stejný klíč i celý vstup; nová změna potřebuje nový klíč.',
  });
export type CallerIntentKey = typeof CallerIntentKeySchema.Type;

/** JSON Schema bounds count Unicode code points, not JavaScript's UTF-16 code units. */
const boundedText = (maximum: number, minimum = 0) =>
  Schema.String.check(
    Schema.makeFilter(
      (value: string) => {
        const length = Iterable.size(value);
        return length >= minimum && length <= maximum;
      },
      {
        expected: `text containing ${minimum}–${maximum} Unicode characters`,
        toJsonSchema: () => ({ maxLength: maximum, minLength: minimum }),
      },
    ),
  );

const RunId = boundedText(300, 1).annotate({
  description: 'Původní id běhu agenta (volitelné). Není to klíč idempotence; při opakování ho neměň.',
});
const ToolId = boundedText(300, 1);
const Reason = boundedText(2000).annotate({
  description: 'Proč změnu děláš (uvidí schvalovatel).',
});

export const CapabilitiesInput = Schema.Struct({
  id: Schema.optionalKey(boundedText(300)),
  moduleId: Schema.optionalKey(boundedText(120)),
  query: Schema.optionalKey(boundedText(200)),
});
export const ExecuteInput = Schema.Struct({
  id: ToolId,
  idempotencyKey: CallerIntentKeySchema,
  input: Schema.optionalKey(Schema.JsonObject),
  reason: Schema.optionalKey(Reason),
  runId: Schema.optionalKey(RunId),
});
export const ProposalChange = Schema.Struct({
  id: ToolId,
  input: Schema.optionalKey(Schema.JsonObject),
  reason: boundedText(2000, 1),
  summary: Schema.optionalKey(boundedText(300)),
  targetLabel: Schema.optionalKey(boundedText(300)),
});
export const ProposeInput = Schema.Struct({
  changes: Schema.Array(ProposalChange).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  idempotencyKey: CallerIntentKeySchema,
  instruction: boundedText(4000, 1),
  runId: Schema.optionalKey(RunId),
});
export const ReadInput = Schema.Struct({
  id: ToolId,
  input: Schema.optionalKey(Schema.JsonObject),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(500))),
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  path: Schema.optionalKey(boundedText(300)),
});
/** An empty Struct accepts non-nullish values; a never-valued record requires an object with no fields. */
export const EmptyInput = Schema.Record(Schema.String, Schema.Never);

/** Only transport extras absent from the Action contract are added or removed. */
export const TypedWriteIntent = Schema.Struct({
  idempotencyKey: CallerIntentKeySchema,
  reason: Schema.optionalKey(Reason),
  runId: Schema.optionalKey(RunId),
});

export const toolInputSchema = (schema: Schema.Constraint): Schema.JsonObject => {
  const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: 'error' });
  // Schema generation is a construction-time invariant, outside a running tool's Effect.
  // Keep the original SchemaError if a generated document is not JSON; never replace it with an empty schema.
  return Schema.decodeUnknownResult(Schema.JsonObject)({
    ...document.schema,
    $defs: document.definitions,
  }).pipe(Result.getOrThrow);
};

export const decodeToolInput = <A>(schema: Schema.Decoder<A>, input: Schema.JsonObject) =>
  Schema.decodeEffect(schema, { onExcessProperty: 'error' })(input).pipe(
    Effect.mapError(
      (cause) => new InvalidToolArguments({ cause, message: `Neplatné argumenty nástroje: ${cause.message}` }),
    ),
  );
