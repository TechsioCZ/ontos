import { Effect, Exit } from 'effect';
import { useEffect, useEffectEvent, useState } from 'react';

import { browserRuntime } from '../../../../../runtime/browser-effect-runtime.ts';
import type {
  PartyIdentityInput,
  PartyIdentityReadResult,
  PartyIdentityReadView,
  PartyIdentityReaders,
} from './party-identity-data.ts';
import { defaultPartyIdentityReaders, loadPartyIdentityWithReaders, partyIdentityKey } from './party-identity-data.ts';

interface ReadState {
  readonly key: string;
  readonly result: PartyIdentityReadResult;
}

export interface PartyIdentityRead {
  readonly retry: () => void;
  readonly view: PartyIdentityReadView;
}

const unavailableResult: PartyIdentityReadResult = {
  contacts: { status: 'unavailable' },
  identifiers: { status: 'unavailable' },
  identity: { status: 'unavailable' },
  status: 'identity',
};

const viewOf = (
  input: PartyIdentityInput,
  key: string | undefined,
  state: ReadState | undefined,
): PartyIdentityReadView => {
  if (input.status !== 'ready' || key === undefined || state?.key !== key) {
    return { status: 'loading' };
  }
  return state.result;
};

/**
 * One exact read per full scope and Party id. A new key clears the previous identity before the next
 * read starts, and a retry clears it before asking again, so a refused re-read never leaves old details
 * or their actions on screen.
 */
export const usePartyIdentityRead = (
  input: PartyIdentityInput,
  readers: PartyIdentityReaders = defaultPartyIdentityReaders,
): PartyIdentityRead => {
  const key = input.status === 'ready' ? partyIdentityKey(input.context, input.partyId) : undefined;
  const [state, setState] = useState<ReadState>();
  const [attempt, setAttempt] = useState(0);
  const [previousKey, setPreviousKey] = useState(key);
  if (previousKey !== key) {
    setPreviousKey(key);
    setState(undefined);
    setAttempt(0);
  }
  const ready = input.status === 'ready' ? input : undefined;
  const partyId = ready?.partyId;
  const tenantId = ready?.context.tenantId;
  const readKey = key === undefined ? undefined : `${key}|${attempt}`;
  const runRead = useEffectEvent((resourceId: string, scopedTenantId: string) =>
    loadPartyIdentityWithReaders(
      {
        moduleId: 'party.registry',
        resourceId,
        resourceType: 'party.registry.party',
        tenantId: scopedTenantId,
      },
      scopedTenantId,
      readers,
    ),
  );

  useEffect(() => {
    if (readKey === undefined || partyId === undefined || tenantId === undefined) {
      return;
    }
    let active = true;
    const fiber = browserRuntime.runFork(
      runRead(partyId, tenantId).pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          active
            ? Effect.sync(() => {
                setState({ key: readKey, result: Exit.isSuccess(exit) ? exit.value : unavailableResult });
              })
            : Effect.void,
        ),
      ),
    );
    return () => {
      active = false;
      fiber.interruptUnsafe();
    };
  }, [partyId, readKey, tenantId]);

  const view = viewOf(input, readKey, state);

  const retry = () => {
    setState(undefined);
    setAttempt((current) => current + 1);
  };

  return { retry, view };
};
