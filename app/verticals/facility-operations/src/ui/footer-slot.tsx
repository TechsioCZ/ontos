// The footer slot of a side panel whose forms sit in the panel body: the form renders its Save button into the
// panel's footer, last, while its draft and leave question stay with the form.
import { createContext, use, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** `undefined`: no panel offers a slot, the footer renders where the form is; `null`: the slot is not on screen yet. */
const FooterSlotContext = createContext<HTMLElement | null | undefined>(undefined);

/** The slot of one panel: put `target` last in the panel's actions and wrap the panel body in `FooterSlotProvider`. */
export const useFooterSlot = () => {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return {
    slot,
    target: <div className="flex flex-wrap items-center justify-end gap-100" data-footer-slot="" ref={setSlot} />,
  };
};

export const FooterSlotProvider = ({
  children,
  slot,
}: {
  readonly children?: ReactNode;
  readonly slot: HTMLElement | null;
}) => <FooterSlotContext value={slot}>{children}</FooterSlotContext>;

/** Renders `children` in the enclosing panel's footer slot, or in place when there is none. */
export const InFooter = ({ children }: { readonly children: ReactNode }): ReactNode => {
  const slot = use(FooterSlotContext);
  if (slot === undefined) {
    return children;
  }
  return slot === null ? null : createPortal(children, slot);
};
