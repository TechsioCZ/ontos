// The bindings handed to FormReact.make through a namespace import, and an inline type-only form-status import.
import * as Forms from '@app/core-runtime/ui/form';
import { type useFormStatus } from 'react-dom';
import { Effect, Schema } from 'effect';

export type FormStatus = ReturnType<typeof useFormStatus>;

const form = Forms.FormReact.make(Forms.fromPayload(Schema.Struct({ name: Schema.String })), {
  fields: { name: Forms.TextField },
  onSubmit: () => Effect.void,
});

export const NamespaceForm = () => (
  <Forms.FormRoot defaultValues={{ name: '' }} form={form} translateMessage={(message) => message}>
    <form.name label="Name" />
  </Forms.FormRoot>
);
