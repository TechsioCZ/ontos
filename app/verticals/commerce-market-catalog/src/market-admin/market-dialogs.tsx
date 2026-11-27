// Market detail actions (DESIGN 4): Upravit (new definition revision with a reason), Aktivovat / Pozastavit, and
// Vyřadit (impact summary, type-the-code confirmation, durable retirement intent).
import { executeMarketAffectedUseAssessment } from '@app/customer-market-retirement-contracts/market-affected-use-assessment/client';
import { MarketAffectedUseAssessmentRequestSchema } from '@app/customer-market-retirement-contracts/market-affected-use-assessment';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { useDraftSave, useUnsavedChangesGuard } from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import {
  FormBuilder,
  FormReact,
  FormRoot,
  FormRootError,
  TextField,
  fromPayload,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { DateTime, Effect, Fiber, Option, Schema } from 'effect';
import { AsyncResult, Atom } from 'effect/reactivity';
import { useEffect, useState } from 'react';
import type { MarketLifecycleResult } from '../../shared/action-contracts.ts';
import { ActivateMarketPayloadSchema } from '../../shared/actions/activate-market.ts';
import { RetireMarketPayloadSchema } from '../../shared/actions/retire-market.ts';
import { ReviseMarketDefinitionPayloadSchema } from '../../shared/actions/revise-market-definition.ts';
import { SuspendMarketPayloadSchema } from '../../shared/actions/suspend-market.ts';
import type { MarketAdministrationState } from '../../shared/apis/market-administration.ts';
import { executeActivateMarket } from '../api/activate-market-action-client.ts';
import { executeRetireMarket } from '../api/retire-market-action-client.ts';
import { executeReviseMarketDefinition } from '../api/revise-market-definition-action-client.ts';
import { executeSuspendMarket } from '../api/suspend-market-action-client.ts';
import { browserAtomRuntime, browserRuntime } from '../runtime/browser-effect-runtime.ts';
import type { CurrentMarket } from './eshops-model.ts';
import {
  DefinitionFields,
  LiveChecks,
  definitionControls,
  definitionFields,
  useOpenedValues,
} from './market-fields.tsx';
import { ReasonInputSchema, definitionFormOf, reasonValid, reviseMarketInput } from './market-form.ts';
import { confirmsMarketCode, retirementImpactOf } from './market-detail-model.ts';
import type { RetirementImpact } from './market-detail-model.ts';
import { DialogFrame, FormDialogFrame } from './dialog-frame.tsx';
import { failureText, useMarketText } from './market-ui.tsx';
import { marketActionEffect, requestId, writeFailure, WriteFailureSchema } from './page-data.ts';
import type { WriteFailure } from './page-data.ts';

const isProposal = Schema.is(ActionProposalAcceptedSchema);

/** The Action refused the change, or could not be reached: nothing changed, the dialog names why. */
class MarketChangeRefused extends Schema.TaggedError<MarketChangeRefused>()('MarketChangeRefused', {
  reason: WriteFailureSchema,
}) {}

/** The refusal is the dialog's own error, under its fields. */
const refusalErrors = ({ reason }: MarketChangeRefused) => [{ message: `failures.${reason}`, path: '' as const }];

/** Sends one Market Action under a fresh idempotency key; a refusal fails the form's submit. */
const sendMarketAction = <P, A, E extends { readonly _tag: string }, D extends { readonly _tag: string }>(
  payload: Effect.Effect<P, D>,
  execute: Parameters<typeof marketActionEffect<P, A, E, D>>[1],
) =>
  marketActionEffect(payload, execute).pipe(
    Effect.flatMap((outcome) =>
      outcome.ok ? Effect.succeed(outcome.value) : Effect.fail(new MarketChangeRefused({ reason: outcome.reason })),
    ),
  );

/** The dialog the open form belongs to; a module-level form reads it when it submits. */
const openTarget = <Target,>(target: Atom.Atom<Option.Option<Target>>, get: Atom.FnContext) =>
  Option.match(get(target), {
    onNone: () => Effect.die('The market dialog submitted before it was opened.'),
    onSome: Effect.succeed,
  });

interface MarketDialogProps {
  readonly market: CurrentMarket;
  /** The change was parked for approval: nothing changed yet. */
  readonly onAwaitingApproval: () => void;
  readonly onClose: () => void;
  readonly onDone: (message: string) => void;
}

/**
 * The edit form: the definition as the form shows it, and the reason the revision is written with. Typing changes only
 * the form; the dialog's Uložit sends it through the save bar, so the form itself is never submitted.
 */
const editMarketForm = FormReact.make(definitionFields.addField('reason', ReasonInputSchema), {
  fields: { ...definitionControls, reason: TextField },
  onSubmit: () => Effect.void,
  runtime: browserAtomRuntime,
});

type EditMarketValues = typeof editMarketForm.schema.Encoded;

const isRevisable = Schema.is(editMarketForm.schema);

/**
 * Edits the definition of a market in a new revision. Typing changes only the dialog's draft; its one Save sends the
 * revision once, and leaving with unsaved input asks first.
 */
export const EditMarketDialog = ({ market, onAwaitingApproval, onClose, onDone }: MarketDialogProps) => {
  const { text } = useMarketText();
  const opened: EditMarketValues = { ...definitionFormOf(market), reason: '' };
  const { ready, values } = useOpenedValues(editMarketForm.values, opened);
  const setValues = useAtomSet(editMarketForm.setValues);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const record = useDraftSave<EditMarketValues, never>({
    isValid: isRevisable,
    runtime: browserRuntime,
    save: (value) =>
      marketActionEffect(
        DateTime.now.pipe(
          Effect.flatMap((now) =>
            Schema.decodeUnknownEffect(ReviseMarketDefinitionPayloadSchema)(
              reviseMarketInput({ current: market, form: value, now, reason: value.reason }),
            ),
          ),
        ),
        executeReviseMarketDefinition,
      ).pipe(
        Effect.map((outcome): SaveOutcome => {
          if (!outcome.ok) {
            setFailure(outcome.reason);
            return 'failed';
          }
          if (isProposal(outcome.value)) {
            onAwaitingApproval();
            return 'proposed';
          }
          onDone(text('detail.editDialog.saved', { code: market.marketCode }));
          return 'saved';
        }),
      ),
    value: values,
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({
    draft: record,
    navigation: blocker,
    onDiscard: () => setValues(record.confirmed),
  });
  const handleSave = record.save;
  return (
    <FormDialogFrame
      description={text('detail.editDialog.description')}
      error={failure === null ? null : failureText(text, failure)}
      guard={guard}
      onClose={onClose}
      onSave={handleSave}
      status={record.status}
      title={text('detail.editDialog.title', { code: market.marketCode })}
    >
      <FormRoot
        className="flex flex-col gap-200"
        defaultValues={opened}
        form={editMarketForm}
        translateMessage={(message) => text(message)}
      >
        {ready}
        {/* Validation messages appear once the draft is invalid. */}
        <LiveChecks checking={record.status === 'invalid'} form={editMarketForm} />
        <DefinitionFields codeEditable={false} form={editMarketForm} prefix="edit-market" />
        <editMarketForm.reason id="edit-market-reason" label={text('form.reason')} maxLength={500} name="reason" />
      </FormRoot>
    </FormDialogFrame>
  );
};

interface LifecycleDialogProps extends MarketDialogProps {
  readonly action: 'activate' | 'suspend';
  readonly state: MarketAdministrationState;
}

/** The lifecycle payload over the observed aggregate revision and current definition. */
const lifecycleInput = (state: MarketAdministrationState, reason: string, effectiveAt: DateTime.Utc) => ({
  effectiveAt: DateTime.formatIso(effectiveAt),
  expectedCurrentDefinitionRevisionRef: state.currentDefinitionRevisionRef,
  expectedRevision: state.revision,
  marketRef: state.marketRef,
  reason: reason.trim(),
});

/** The market the open Aktivovat / Pozastavit dialog changes, and which of the two it does. */
const lifecycleTarget = Atom.make(
  Option.none<{ readonly action: LifecycleDialogProps['action']; readonly state: MarketAdministrationState }>(),
).pipe(Atom.keepAlive);

const changeLifecycle = Effect.fn('LifecycleDialog.send')(function* changeLifecycle(
  reason: string,
  get: Atom.FnContext,
) {
  const { action, state } = yield* openTarget(lifecycleTarget, get);
  const now = yield* DateTime.now;
  if (action === 'activate') {
    return yield* sendMarketAction(
      Schema.decodeUnknownEffect(ActivateMarketPayloadSchema)(lifecycleInput(state, reason, now)),
      executeActivateMarket,
    );
  }
  return yield* sendMarketAction(
    Schema.decodeUnknownEffect(SuspendMarketPayloadSchema)(lifecycleInput(state, reason, now)),
    executeSuspendMarket,
  );
});

/** Aktivovat / Pozastavit: the reason the change is recorded with; the dialog's confirm button submits it. */
const lifecycleForm = FormReact.make(FormBuilder.empty.addField('reason', ReasonInputSchema), {
  fields: { reason: TextField },
  onSubmit: (_submit, { decoded, get }) => changeLifecycle(decoded.reason, get),
  runtime: browserAtomRuntime,
  submitErrors: refusalErrors,
});

export const LifecycleDialog = ({
  action,
  market,
  onAwaitingApproval,
  onClose,
  onDone,
  state,
}: LifecycleDialogProps) => {
  const { text } = useMarketText();
  const opened = { reason: text(`detail.lifecycle.${action}Reason`) };
  const setTarget = useAtomSet(lifecycleTarget);
  useEffect(() => {
    setTarget(Option.some({ action, state }));
  }, [action, setTarget, state]);
  const submit = useAtomSet(lifecycleForm.submit);
  const busy = useAtomValue(lifecycleForm.submit).waiting;
  useAtomSubscribe(
    lifecycleForm.submit,
    (result) => {
      if (!AsyncResult.isSuccess(result) || result.waiting) {
        return;
      }
      if (isProposal(result.value)) {
        onAwaitingApproval();
        return;
      }
      onDone(
        text(action === 'activate' ? 'detail.lifecycle.activated' : 'detail.lifecycle.suspended', {
          code: market.marketCode,
        }),
      );
    },
    { immediate: false },
  );
  return (
    <DialogFrame
      busy={busy}
      confirmLabel={text(`detail.lifecycle.${action}Confirm`)}
      confirmVariant={action === 'suspend' ? 'danger' : 'primary'}
      description={text(`detail.lifecycle.${action}Description`)}
      failure={null}
      onClose={onClose}
      onConfirm={() => submit()}
      title={text(`detail.lifecycle.${action}Title`, { code: market.marketCode })}
    >
      <FormRoot
        className="flex flex-col gap-200"
        defaultValues={opened}
        form={lifecycleForm}
        translateMessage={(message) => text(message)}
      >
        <lifecycleForm.reason
          id={`${action}-market-reason`}
          label={text('form.reason')}
          maxLength={500}
          name="reason"
        />
        <FormRootError form={lifecycleForm} />
      </FormRoot>
    </DialogFrame>
  );
};

type ImpactState =
  | { readonly kind: 'loading' }
  /** The owner did not verify the impact (`failure` absent) or could not be asked. */
  | { readonly failure?: WriteFailure; readonly kind: 'unavailable' }
  | ({ readonly kind: 'ready' } & RetirementImpact);

/** Asks the Customer Context owner which live uses would block the retirement, at the observed Market revision. */
const loadImpact = (state: MarketAdministrationState) =>
  Effect.all({ id: requestId, now: DateTime.now }, { concurrency: 1 }).pipe(
    Effect.flatMap(({ id, now }) =>
      Schema.decodeUnknownEffect(MarketAffectedUseAssessmentRequestSchema)({
        evaluatedAt: DateTime.formatIso(now),
        marketRef: state.marketRef,
        marketRevision: state.revision,
        tenantId: state.marketRef.tenantId,
      }).pipe(Effect.flatMap((request) => executeMarketAffectedUseAssessment(request, id))),
    ),
    Effect.match({
      onFailure: (error): ImpactState => ({ failure: writeFailure(error), kind: 'unavailable' }),
      onSuccess: (assessment): ImpactState => {
        const impact = retirementImpactOf(assessment);
        return impact === undefined ? { kind: 'unavailable' } : { kind: 'ready', ...impact };
      },
    }),
  );

/**
 * The retirement form: the market code typed as confirmation and the reason. `marketCode` is the code it must match;
 * it is never shown.
 */
const RetireInputSchema = Schema.Struct({
  confirmMarketCode: Schema.String,
  marketCode: Schema.String,
  reason: Schema.String,
}).check(
  Schema.makeFilter(
    (values: { readonly confirmMarketCode: string; readonly marketCode: string; readonly reason: string }) => {
      const issues = [
        ...(confirmsMarketCode(values.confirmMarketCode, values.marketCode)
          ? []
          : [{ issue: 'detail.retire.typeCode', path: ['confirmMarketCode'] }]),
        ...(reasonValid(values.reason) ? [] : [{ issue: 'form.reasonError', path: ['reason'] }]),
      ];
      return issues.length === 0 || issues;
    },
  ),
);

/** The market state the open Vyřadit dialog retires. */
const retireTarget = Atom.make(Option.none<MarketAdministrationState>()).pipe(Atom.keepAlive);

const retireMarket = Effect.fn('RetireDialog.send')(function* retireMarket(reason: string, get: Atom.FnContext) {
  const state = yield* openTarget(retireTarget, get);
  const now = yield* DateTime.now;
  return yield* sendMarketAction(
    Schema.decodeUnknownEffect(RetireMarketPayloadSchema)(lifecycleInput(state, reason, now)),
    executeRetireMarket,
  );
});

const retireForm = FormReact.make(fromPayload(RetireInputSchema), {
  fields: { confirmMarketCode: TextField, marketCode: TextField, reason: TextField },
  onSubmit: (_submit, { decoded, get }) => retireMarket(decoded.reason, get),
  runtime: browserAtomRuntime,
  submitErrors: refusalErrors,
});

interface RetireDialogProps extends MarketDialogProps {
  /** The native result the Action returned: the Market's new lifecycle state, or a committed settlement still pending. */
  readonly onRequested: (result: MarketLifecycleResult) => void;
  readonly state: MarketAdministrationState;
}

export const RetireDialog = ({ market, onAwaitingApproval, onClose, onRequested, state }: RetireDialogProps) => {
  const { text } = useMarketText();
  const [impact, setImpact] = useState<ImpactState>({ kind: 'loading' });
  const opened = { confirmMarketCode: '', marketCode: market.marketCode, reason: '' };
  useEffect(() => {
    const fiber = browserRuntime.runFork(loadImpact(state).pipe(Effect.map(setImpact)));
    return () => {
      browserRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, [state]);
  const setTarget = useAtomSet(retireTarget);
  useEffect(() => {
    setTarget(Option.some(state));
  }, [setTarget, state]);
  const submit = useAtomSet(retireForm.submit);
  const busy = useAtomValue(retireForm.submit).waiting;
  useAtomSubscribe(
    retireForm.submit,
    (result) => {
      if (!AsyncResult.isSuccess(result) || result.waiting) {
        return;
      }
      if (isProposal(result.value)) {
        // Parked for approval: no retirement intent exists until someone approves it.
        onAwaitingApproval();
        return;
      }
      onRequested(result.value);
    },
    { immediate: false },
  );
  return (
    <DialogFrame
      busy={busy}
      confirmLabel={text('detail.retire.confirm')}
      confirmVariant="danger"
      description={text('detail.retire.description')}
      failure={null}
      onClose={onClose}
      onConfirm={() => submit()}
      title={text('detail.retire.title', { code: market.marketCode })}
    >
      <StatusText showIcon status={impact.kind === 'ready' && impact.blocking > 0 ? 'warning' : 'default'}>
        {impact.kind === 'loading' && text('detail.retire.impactLoading')}
        {impact.kind === 'unavailable' &&
          [
            text('detail.retire.impactUnavailable'),
            impact.failure === undefined ? '' : failureText(text, impact.failure),
          ]
            .filter((part) => part !== '')
            .join(' ')}
        {impact.kind === 'ready' &&
          (impact.blocking > 0
            ? text('detail.retire.impactBlocked', { blocking: impact.blocking })
            : text('detail.retire.impactClear', { retained: impact.retained }))}
      </StatusText>
      <FormRoot
        className="flex flex-col gap-200"
        defaultValues={opened}
        form={retireForm}
        // The confirmation message names the code to type.
        translateMessage={(message) => text(message, { code: market.marketCode })}
      >
        <retireForm.confirmMarketCode
          autoComplete="off"
          id="retire-market-code"
          label={text('detail.retire.typeCode', { code: market.marketCode })}
          name="confirmMarketCode"
        />
        <retireForm.reason
          id="retire-market-reason"
          label={text('detail.retire.reason')}
          maxLength={500}
          name="reason"
        />
        <FormRootError form={retireForm} />
      </FormRoot>
    </DialogFrame>
  );
};
