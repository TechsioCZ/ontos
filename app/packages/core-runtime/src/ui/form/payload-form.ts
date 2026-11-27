import { FormBuilder } from '@lucas-barake/effect-form-react';
import type { Field } from '@lucas-barake/effect-form-react';
import { Result, Schema } from 'effect';

type PayloadFields = Record<string, Schema.Top>;

/** One effect-form field per payload property, keyed and validated by the payload's own Schema. */
export type PayloadFormFields<Fields extends PayloadFields> = {
  readonly [Key in keyof Fields & string]: Field.FieldDef<Key, Fields[Key]>;
};

/**
 * The form of an Action payload: every field and every check comes from the payload Schema, so a
 * field is never described twice. Each property becomes a field with its own schema, and checks on
 * the payload as a whole (such as two fields that must match) validate the decoded values, reported
 * on the field path they name or at the form root. Narrow a payload to the fields a form edits with
 * `Payload.mapFields(Struct.pick([...]))`; the rest of the payload is the submit handler's.
 */
export function fromPayload<Fields extends PayloadFields>(
  payload: Schema.Struct<Fields>,
): FormBuilder.FormBuilder<PayloadFormFields<Fields>, Schema.Codec.DecodingServices<Fields[keyof Fields]>>;
export function fromPayload(
  payload: Schema.Struct<PayloadFields>,
): FormBuilder.FormBuilder<Field.FieldsRecord, unknown> {
  let builder: FormBuilder.FormBuilder<Field.FieldsRecord, unknown> = FormBuilder.empty;
  for (const [key, schema] of Object.entries(payload.fields)) {
    builder = builder.addField(key, schema);
  }
  if (payload.ast.checks === undefined) {
    return builder;
  }
  const validate = Schema.decodeUnknownResult(Schema.toType(payload));
  return builder.refine((values) =>
    Result.match(validate(values), { onFailure: (error) => error.issue, onSuccess: () => true }),
  );
}
