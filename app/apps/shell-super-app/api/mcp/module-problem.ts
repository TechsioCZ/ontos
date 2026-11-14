/** Failed module responses: decode RFC 9457 text fields without inspecting an opaque Action result. */
import { Data, Option, Schema } from 'effect';

const ProblemText = Schema.String.check(Schema.isPattern(/\S/u));
const ProblemDocument = Schema.Struct({
  code: Schema.optionalKey(Schema.Json),
  detail: Schema.optionalKey(Schema.Json),
  title: Schema.optionalKey(Schema.Json),
});

export class ModuleProblem extends Data.TaggedError('ModuleProblem')<{
  /** The original opaque module response, retained even when no problem text can be decoded. */
  readonly cause: Schema.Json;
  readonly code: string | undefined;
  readonly detail: string | undefined;
  readonly status: number;
  readonly title: string | undefined;
}> {
  override get message(): string {
    const code = this.code === undefined ? '' : ` ${this.code}`;
    return `module answered HTTP ${this.status}${code}`;
  }
}

export const problemOf = (status: number, body: Schema.Json): ModuleProblem => {
  const document = Option.getOrElse(Schema.decodeUnknownOption(ProblemDocument)(body), () => ({
    code: null,
    detail: null,
    title: null,
  }));
  const decodeText = Schema.decodeUnknownOption(ProblemText);
  return new ModuleProblem({
    cause: body,
    code: Option.getOrUndefined(decodeText(document.code)),
    detail: Option.getOrUndefined(decodeText(document.detail)),
    status,
    title: Option.getOrUndefined(decodeText(document.title)),
  });
};
