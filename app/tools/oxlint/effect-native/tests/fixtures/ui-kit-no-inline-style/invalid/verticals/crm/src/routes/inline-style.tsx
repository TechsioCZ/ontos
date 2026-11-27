// expect-count: 3
import { Button } from '@techsio/ui-kit/atoms/button';

export const InlineStyle = ({ width }: { width: number }) => (
  <section style={{ padding: 12 }}>
    <Button style={{ width }}>Save</Button>
    <div {...{ style: { color: 'inherit' } }} />
  </section>
);
