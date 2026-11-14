import { describe, expect, it } from 'effect-rstest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SelectTemplate } from '../../src/select-template.tsx';

const ownerId = 'ec45f76f-2063-5946-b700-bf3ea3da3189';

describe('SelectTemplate', () => {
  it('writes the item label, not the item ID, into the hidden native option', () => {
    const markup = renderToStaticMarkup(
      <SelectTemplate
        items={[
          { label: 'Všichni', value: 'all' },
          { label: 'Eva Nová', value: ownerId },
        ]}
        name="owner"
        value={['all']}
      />,
    );
    expect(markup).toContain(`<option value="${ownerId}">Eva Nová</option>`);
    expect(markup).not.toContain(`>${ownerId}<`);
  });
});
