// expect-count: 5
// Form state in React state, read with Schema.fromFormData and rendered with kit controls and native elements.
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Select } from '@techsio/ui-kit/molecules/select';
import { Schema } from 'effect';
import { useState } from 'react';

const Draft = Schema.fromFormData(Schema.Struct({ name: Schema.String }));

export const HandRolledForm = () => {
  const [name, setName] = useState('');
  return (
    <form action={(data: FormData) => Schema.decodeUnknownOption(Draft)(data)}>
      <FormInput id="name" label="Name" onChange={(event) => setName(event.currentTarget.value)} value={name} />
      <Select items={[]} />
      <input name="hidden" type="hidden" />
    </form>
  );
};
