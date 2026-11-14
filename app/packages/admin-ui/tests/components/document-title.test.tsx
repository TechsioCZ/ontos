import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'effect-rstest';
import type { ReactNode } from 'react';

import { DocumentTitle, useDocumentTitle } from '../../src/document-title.tsx';

const copy = { first: 'first-record', second: 'second-record', shell: 'shell-destination' } as const;

/** The Shell's frame as it uses the slot. */
const Frame = ({ children }: { readonly children: ReactNode }) => {
  const title = useDocumentTitle();
  return (
    <>
      <span data-testid="title">{title ?? copy.shell}</span>
      {children}
    </>
  );
};

const shownTitle = () => document.querySelector('[data-testid="title"]')?.textContent;

afterEach(() => {
  cleanup();
});

describe('DocumentTitle', () => {
  it('gives the frame the record name and takes it back when the page is left', () => {
    const { rerender } = render(
      <Frame>
        <DocumentTitle title={copy.first} />
      </Frame>,
    );
    expect(shownTitle()).toBe(copy.first);
    rerender(<Frame>{null}</Frame>);
    expect(shownTitle()).toBe(copy.shell);
  });

  it('ignores a missing or blank name', () => {
    render(
      <Frame>
        <DocumentTitle title={undefined} />
        <DocumentTitle title="  " />
      </Frame>,
    );
    expect(shownTitle()).toBe(copy.shell);
  });

  it('keeps the newer record when the older one leaves after it', () => {
    const { rerender } = render(
      <Frame>
        <DocumentTitle key="a" title={copy.first} />
      </Frame>,
    );
    rerender(
      <Frame>
        <DocumentTitle key="a" title={copy.first} />
        <DocumentTitle key="b" title={copy.second} />
      </Frame>,
    );
    expect(shownTitle()).toBe(copy.second);
    act(() => {
      rerender(
        <Frame>
          <DocumentTitle key="b" title={copy.second} />
        </Frame>,
      );
    });
    expect(shownTitle()).toBe(copy.second);
  });

  it('renders nothing of its own', () => {
    const { container } = render(<DocumentTitle title={copy.first} />);
    expect(container.childElementCount).toBe(0);
  });
});
