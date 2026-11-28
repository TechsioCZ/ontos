import { Button } from '@techsio/ui-kit/atoms/button';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';

export const KitControls = () => (
  <form>
    <fieldset>
      <legend>Owner</legend>
      <FormInput id="name" label="Name" />
    </fieldset>
    <Button type="submit">Save</Button>
    <Dialog.Content />
    <my-button />
  </form>
);
