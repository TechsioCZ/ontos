import { constVoid } from 'effect/Function';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

export interface ScrollRegionProps {
  /** Marks the region busy while its content is still loading. */
  readonly busy?: boolean;
  readonly children?: ReactNode;
  readonly className?: string;
  /** Accessible name of the region, announced when keyboard focus reaches it. */
  readonly label: string;
  /** Viewport styling. Defaults to horizontal scrolling within the available width. */
  readonly style?: CSSProperties;
}

const horizontalViewport: CSSProperties = { maxWidth: '100%', minWidth: 0, overflowX: 'auto' };

const overflows = (viewport: HTMLElement) =>
  viewport.scrollWidth > viewport.clientWidth || viewport.scrollHeight > viewport.clientHeight;

/**
 * A named viewport for content wider or taller than its column, such as a static table or a document preview.
 * While its content overflows, the region joins the tab order so keyboard users can focus it and scroll it with the
 * arrow keys (WCAG 2.1.1). Content that fits adds no empty tab stop.
 */
export const ScrollRegion = ({ busy, children, className, label, style = horizontalViewport }: ScrollRegionProps) => {
  const viewport = useRef<HTMLElement>(null);
  const [scrollable, setScrollable] = useState(false);

  useEffect(() => {
    const node = viewport.current;
    if (node === null) {
      return constVoid;
    }
    const update = () => setScrollable(overflows(node));
    // The viewport's own size changes with the layout; its content changes as rows and text arrive.
    const resize = new ResizeObserver(update);
    const content = new MutationObserver(update);
    resize.observe(node);
    content.observe(node, { characterData: true, childList: true, subtree: true });
    return () => {
      content.disconnect();
      resize.disconnect();
    };
  }, []);

  return (
    <section
      aria-busy={busy}
      aria-label={label}
      className={className}
      ref={viewport}
      style={style}
      tabIndex={scrollable ? 0 : undefined}
    >
      {children}
    </section>
  );
};
