import { Button } from '@techsio/ui-kit/atoms/button';

const props = { type: 'button' as const };

export const KitProps = () => (
  <section className="grid gap-200">
    <Button size="sm" {...props}>
      Save
    </Button>
  </section>
);
