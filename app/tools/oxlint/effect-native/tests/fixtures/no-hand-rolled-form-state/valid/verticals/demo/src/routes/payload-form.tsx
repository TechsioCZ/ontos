// A form driven from its Action payload through the form module: the one form model.
import { FormReact, FormRoot, SubmitButton, TextField, fromPayload } from '@app/core-runtime/ui/form';
import type { FieldChoice } from '@app/core-runtime/ui/form';
import { SearchForm } from '@techsio/ui-kit/molecules/search-form';
import type { SelectItem } from '@techsio/ui-kit/molecules/select';
import { Effect, Schema } from 'effect';

const Payload = Schema.Struct({ name: Schema.String });
const form = FormReact.make(fromPayload(Payload), { fields: { name: TextField }, onSubmit: () => Effect.void });

export const choices: readonly FieldChoice[] = [];
export const items: readonly SelectItem[] = [];

export const PayloadForm = () => (
  <>
    <FormRoot defaultValues={{ name: '' }} form={form} translateMessage={(message) => message}>
      <form.name label="Name" />
      <SubmitButton>Save</SubmitButton>
    </FormRoot>
    <SearchForm />
  </>
);
