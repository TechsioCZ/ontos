import { useEffect, useRef } from 'react';

/**
 * Opens the contract a create form saved, once the form is gone, so leaving the page does not ask about a saved draft.
 * It opens it exactly once: afterwards the person may go back to the list or open another contract.
 * Returns what the create form calls with the saved contract, right before it closes.
 */
export const useOpenCreated = (
  formOpen: boolean,
  linkedResourceId: string | undefined,
  open: (resourceId: string) => void,
) => {
  const created = useRef<string | null>(null);
  useEffect(() => {
    const resourceId = created.current;
    if (formOpen || resourceId === null) {
      return;
    }
    created.current = null;
    if (resourceId !== linkedResourceId) {
      open(resourceId);
    }
  }, [formOpen, linkedResourceId, open]);
  return (resourceId: string) => {
    created.current = resourceId;
  };
};
