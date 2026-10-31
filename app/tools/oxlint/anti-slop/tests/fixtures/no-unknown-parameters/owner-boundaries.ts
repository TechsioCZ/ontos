// Frozen owner storage/error boundaries; raw values are consumed only by native decoders.
import { Option, Schema } from 'effect';

declare const initialClientsSlice: object;
declare const initialImportsSlice: object;
declare const initialVisitsSlice: object;

const StoredSlicesSchema = Schema.Struct({
  aiChanges: Schema.optionalKey(Schema.Unknown),
  clients: Schema.optionalKey(Schema.Unknown),
  customerInputs: Schema.optionalKey(Schema.Unknown),
  imports: Schema.optionalKey(Schema.Unknown),
  salespeople: Schema.optionalKey(Schema.Unknown),
  visits: Schema.optionalKey(Schema.Unknown),
});
const DefaultedSlicesSchema = Schema.Struct({
  aiChanges: Schema.optionalKey(Schema.Unknown),
  clients: Schema.Unknown,
  customerInputs: Schema.optionalKey(Schema.Unknown),
  imports: Schema.Unknown,
  salespeople: Schema.Unknown,
  visits: Schema.Unknown,
});
type DefaultedSlices = typeof DefaultedSlicesSchema.Type;

/** Fill slices missing from older persisted documents before decoding. */
export const withDefaultSlices = (raw: unknown): DefaultedSlices => {
  const value = Option.getOrElse(
    Schema.decodeUnknownOption(StoredSlicesSchema)(raw),
    (): typeof StoredSlicesSchema.Type => ({}),
  );
  const result: DefaultedSlices = {
    clients: value.clients ?? initialClientsSlice,
    imports: value.imports ?? initialImportsSlice,
    salespeople: value.salespeople ?? [],
    visits: value.visits ?? initialVisitsSlice,
  };
  if (value.aiChanges !== undefined) {
    Object.assign(result, { aiChanges: value.aiChanges });
  }
  if (value.customerInputs !== undefined) {
    Object.assign(result, { customerInputs: value.customerInputs });
  }
  return result;
};

const CommandProblemFieldsSchema = Schema.Struct({
  detail: Schema.optionalKey(Schema.Unknown),
  message: Schema.optionalKey(Schema.Unknown),
  reason: Schema.optionalKey(Schema.Unknown),
  title: Schema.optionalKey(Schema.Unknown),
});

/** Human-readable reason of a failed command (domain errors carry Czech reasons). */
export const commandErrorMessage = (error: unknown): string | undefined => {
  const problem = Schema.decodeUnknownOption(CommandProblemFieldsSchema)(error);
  if (Option.isSome(problem)) {
    for (const field of ['detail', 'reason', 'title', 'message'] as const) {
      const value = problem.value[field];
      if (Schema.is(Schema.String)(value) && value !== '') {
        return value;
      }
    }
  }
  return undefined;
};

const ErrorStatusSchema = Schema.Struct({ status: Schema.Finite });
const statusOf = (error: unknown): number | undefined => {
  const decoded = Schema.decodeUnknownOption(ErrorStatusSchema)(error);
  return Option.isSome(decoded) ? decoded.value.status : undefined;
};


const S = Schema;
const decodeStatus = S.decodeUnknownOption(ErrorStatusSchema);
export const statusViaNativeAlias = (input: unknown) => decodeStatus(input);
