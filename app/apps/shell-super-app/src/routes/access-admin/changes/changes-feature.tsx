import { Effect } from 'effect';
import { useRef, useState } from 'react';

import { createAccessAdministrationIdempotencyKey } from '../../../api/auth-client.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { ChangesClientFailure, changesFailureNotice } from './changes-client.ts';
import type { ChangesClient, ChangesListView } from './changes-client.ts';
import { canConfirmPreview, canPreviewDecision, isBatchEligible, previewMatchesSelection } from './changes-model.ts';
import type { ChangeDecision, ChangePreviewView, ChangeReceiptView, ChangesNotice } from './changes-model.ts';
import { ChangesView } from './changes-view.tsx';

export const ChangesFeature = ({
  client,
  initial,
  initialNotice,
}: {
  readonly client: ChangesClient;
  readonly initial: ChangesListView;
  readonly initialNotice: ChangesNotice | null;
}) => {
  const [list, setList] = useState(initial);
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [preview, setPreview] = useState<ChangePreviewView>();
  const [confirmedItemIds, setConfirmedItemIds] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState(initialNotice);
  const [receipt, setReceipt] = useState<ChangeReceiptView>();
  const [requiresRefresh, setRequiresRefresh] = useState(initialNotice === 'stalePreview');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const commandKey = useRef<string | null>(null);

  const clearPreview = () => {
    setPreview(undefined);
    setConfirmedItemIds([]);
    commandKey.current = null;
  };
  const run = <A,>(operation: Effect.Effect<A, ChangesClientFailure>, onSuccess: (value: A) => void) => {
    if (pending.current) {
      return;
    }
    pending.current = true;
    setBusy(true);
    setNotice(null);
    setReceipt(undefined);
    void browserRuntime.runPromise(
      operation.pipe(
        Effect.timeout('30 seconds'),
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              clearPreview();
              const failureNotice = changesFailureNotice(error);
              if (failureNotice !== 'unavailable') {
                setSelectedIds([]);
              }
              setNotice(failureNotice);
              setRequiresRefresh(true);
              if (failureNotice === 'unauthenticated' || failureNotice === 'forbidden') {
                setList({ items: [], nextCursor: null });
              }
            }),
          onSuccess: (value) => Effect.sync(() => onSuccess(value)),
        }),
        Effect.ensuring(
          Effect.sync(() => {
            pending.current = false;
            setBusy(false);
          }),
        ),
      ),
    );
  };
  const refresh = () => {
    if (pending.current) {
      return;
    }
    clearPreview();
    setSelectedIds([]);
    run(client.list(), (result) => {
      setList(result);
      setRequiresRefresh(false);
    });
  };
  const requestPreview = (ids: readonly string[], decision: ChangeDecision) => {
    if (pending.current || requiresRefresh) {
      return;
    }
    const selection = new Set(ids);
    const selected = list.items.filter((item) => selection.has(item.id));
    clearPreview();
    if (selected.length !== ids.length || !canPreviewDecision(selected, decision)) {
      return;
    }
    run(
      client.preview(selected, decision).pipe(
        Effect.flatMap((result) =>
          createAccessAdministrationIdempotencyKey().pipe(
            Effect.map((key) => ({ key, result })),
            Effect.mapError((cause) => new ChangesClientFailure({ cause, reason: 'unavailable' })),
          ),
        ),
      ),
      ({ key, result }) => {
        if (!previewMatchesSelection(result, selected, decision)) {
          setNotice('stalePreview');
          return;
        }
        commandKey.current = key;
        setPreview(result);
      },
    );
  };
  const confirm = () => {
    if (
      pending.current ||
      requiresRefresh ||
      list.writeAvailability?.available !== true ||
      preview === undefined ||
      commandKey.current === null ||
      !canConfirmPreview(preview, confirmedItemIds)
    ) {
      return;
    }
    const operation = client.decide(preview, commandKey.current);
    clearPreview();
    run(
      operation.pipe(
        Effect.tap((result) => Effect.sync(() => setReceipt(result))),
        Effect.andThen(() => client.list()),
      ),
      (result) => {
        setList(result);
        setSelectedIds([]);
        setNotice('saved');
      },
    );
  };
  return (
    <ChangesView
      busy={busy}
      confirmedItemIds={confirmedItemIds}
      hasMore={list.nextCursor !== null}
      items={list.items}
      notice={notice}
      onCancel={clearPreview}
      onConfirm={confirm}
      onConfirmEffect={(id, confirmed) => {
        if (pending.current) {
          return;
        }
        setConfirmedItemIds((current) =>
          confirmed ? [...new Set([...current, id])] : current.filter((value) => value !== id),
        );
      }}
      onLoadMore={() => {
        if (pending.current || list.nextCursor === null) {
          return;
        }
        clearPreview();
        setSelectedIds([]);
        const loaded = new Set(list.items.map((item) => item.id));
        run(client.list(list.nextCursor), (result) => {
          const additional = result.items.filter((item) => !loaded.has(item.id));
          setList({ ...result, items: [...list.items, ...additional] });
        });
      }}
      onPreview={requestPreview}
      onRefresh={refresh}
      onSelect={(id, selected) => {
        if (pending.current || !list.items.some((item) => item.id === id && isBatchEligible(item))) {
          return;
        }
        clearPreview();
        setSelectedIds((current) =>
          selected ? [...new Set([...current, id])] : current.filter((value) => value !== id),
        );
      }}
      preview={preview}
      receipt={receipt}
      requiresRefresh={requiresRefresh}
      selectedIds={selectedIds}
      writesAvailable={list.writeAvailability?.available === true}
    />
  );
};
