// Tests may render native elements and kit controls directly.
import { FormInput } from '@techsio/ui-kit/molecules/form-input';

export const Fixture = () => (
  <form>
    <FormInput id="name" label="Name" />
  </form>
);
