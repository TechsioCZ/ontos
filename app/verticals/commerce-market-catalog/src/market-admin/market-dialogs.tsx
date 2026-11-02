// Market detail actions (DESIGN 4): Upravit (new definition revision with a reason), Aktivovat / Pozastavit, and
// Vyřadit (impact summary, type-the-code confirmation, durable retirement intent).
import { executeMarketAffectedUseAssessment } from '@app/customer-market-retirement-contracts/market-affected-use-assessment/client';
import { MarketAffectedUseAssessmentRequestSchema } from '@app/customer-market-retirement-contracts/market-affected-use-assessment';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { DateTime, Effect, Fiber, Schema } from 'effect';
import { useEffect, useState } from 'react';
import { ActivateMarketPayloadSchema } from '../../shared/actions/activate-market.ts';
import { RetireMarketPayloadSchema } from '../../shared/actions/retire-market.ts';
import { ReviseMarketDefinitionPayloadSchema } from '../../shared/actions/revise-market-definition.ts';
import { SuspendMarketPayloadSchema } from '../../shared/actions/suspend-market.ts';
import type { MarketAdministrationState } from '../../shared/apis/market-administration.ts';
import type { MarketRetirementOutcome } from '../../shared/domain/market-retirement-intent.ts';
import { executeActivateMarket } from '../api/activate-market-action-client.ts';
import { executeRetireMarket } from '../api/retire-market-action-client.ts';
import { executeReviseMarketDefinition } from '../api/revise-market-definition-action-client.ts';
import { executeSuspendMarket } from '../api/suspend-market-action-client.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import type { CurrentMarket } from './eshops-model.ts';
import { DefinitionFields, ReasonField } from './market-fields.tsx';
import { definitionFormOf, definitionIssues, reasonValid, reviseMarketInput } from './market-form.ts';
import type { MarketDefinitionForm } from './market-form.ts';
import { confirmsMarketCode, retirementImpactOf } from './market-detail-model.ts';
import type { RetirementImpact } from './market-detail-model.ts';
import { DialogFrame } from './dialog-frame.tsx';
import { failureText, useMarketText } from './market-ui.tsx';
import { requestId, runMarketAction, writeFailure } from './page-data.ts';
import type { WriteFailure } from './page-data.ts';

interface MarketDialogProps {
  readonly market: CurrentMarket;
  readonly onClose: () => void;
  readonly onDone: (message: string) => void;
}

export const EditMarketDialog = ({ market, onClose, onDone }: MarketDialogProps) => {
  const { text } = useMarketText();
  const [form, setForm] = useState<MarketDefinitionForm>(() => definitionFormOf(market));
  const [reason, setReason] = useState('');
  const [showIssues, setShowIssues] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const issues = definitionIssues(form);
  const submit = () => {
    if (issues.length > 0 || !reasonValid(reason)) {
      setShowIssues(true);
      return;
    }
    setBusy(true);
    setFailure(null);
    runMarketAction(
      DateTime.now.pipe(
        Effect.flatMap((now) =>
          Schema.decodeUnknownEffect(ReviseMarketDefinitionPayloadSchema)(
            reviseMarketInput({ current: market, form, now, reason }),
          ),
        ),
      ),
      executeReviseMarketDefinition,
      (outcome) => {
        setBusy(false);
        if (outcome.ok) {
          onDone(text('detail.editDialog.saved', { code: market.marketCode }));
          return;
        }
        setFailure(outcome.reason);
      },
    );
  };
  return (
    <DialogFrame
      busy={busy}
      confirmLabel={text('detail.editDialog.save')}
      confirmVariant="primary"
      description={text('detail.editDialog.description')}
      failure={failure}
      onClose={onClose}
      onConfirm={submit}
      title={text('detail.editDialog.title', { code: market.marketCode })}
    >
      <DefinitionFields
        codeEditable={false}
        form={form}
        issues={issues}
        onChange={setForm}
        prefix="edit-market"
        showIssues={showIssues}
      />
      <ReasonField
        id="edit-market-reason"
        label={text('form.reason')}
        onChange={setReason}
        showIssue={showIssues}
        value={reason}
      />
    </DialogFrame>
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

export const LifecycleDialog = ({ action, market, onClose, onDone, state }: LifecycleDialogProps) => {
  const { text } = useMarketText();
  const [reason, setReason] = useState(() => text(`detail.lifecycle.${action}Reason`));
  const [showIssues, setShowIssues] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const done = (outcome: { readonly ok: true } | { readonly ok: false; readonly reason: WriteFailure }) => {
    setBusy(false);
    if (outcome.ok) {
      onDone(
        text(action === 'activate' ? 'detail.lifecycle.activated' : 'detail.lifecycle.suspended', {
          code: market.marketCode,
        }),
      );
      return;
    }
    setFailure(outcome.reason);
  };
  const submit = () => {
    if (!reasonValid(reason)) {
      setShowIssues(true);
      return;
    }
    setBusy(true);
    setFailure(null);
    if (action === 'activate') {
      runMarketAction(
        DateTime.now.pipe(
          Effect.flatMap((now) =>
            Schema.decodeUnknownEffect(ActivateMarketPayloadSchema)(lifecycleInput(state, reason, now)),
          ),
        ),
        executeActivateMarket,
        done,
      );
      return;
    }
    runMarketAction(
      DateTime.now.pipe(
        Effect.flatMap((now) =>
          Schema.decodeUnknownEffect(SuspendMarketPayloadSchema)(lifecycleInput(state, reason, now)),
        ),
      ),
      executeSuspendMarket,
      done,
    );
  };
  return (
    <DialogFrame
      busy={busy}
      confirmLabel={text(`detail.lifecycle.${action}Confirm`)}
      confirmVariant={action === 'suspend' ? 'danger' : 'primary'}
      description={text(`detail.lifecycle.${action}Description`)}
      failure={failure}
      onClose={onClose}
      onConfirm={submit}
      title={text(`detail.lifecycle.${action}Title`, { code: market.marketCode })}
    >
      <ReasonField
        id={`${action}-market-reason`}
        label={text('form.reason')}
        onChange={setReason}
        showIssue={showIssues}
        value={reason}
      />
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

interface RetireDialogProps extends MarketDialogProps {
  /** The Action's durable outcome: the screen polls the intent until it completes. */
  readonly onRequested: (outcome: MarketRetirementOutcome) => void;
  readonly state: MarketAdministrationState;
}

export const RetireDialog = ({ market, onClose, onRequested, state }: RetireDialogProps) => {
  const { text } = useMarketText();
  const [impact, setImpact] = useState<ImpactState>({ kind: 'loading' });
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [showIssues, setShowIssues] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  useEffect(() => {
    const fiber = browserRuntime.runFork(loadImpact(state).pipe(Effect.map(setImpact)));
    return () => {
      browserRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, [state]);
  const confirmed = confirmsMarketCode(typed, market.marketCode);
  const submit = () => {
    if (!confirmed || !reasonValid(reason)) {
      setShowIssues(true);
      return;
    }
    setBusy(true);
    setFailure(null);
    runMarketAction(
      DateTime.now.pipe(
        Effect.flatMap((now) =>
          Schema.decodeUnknownEffect(RetireMarketPayloadSchema)(lifecycleInput(state, reason, now)),
        ),
      ),
      executeRetireMarket,
      (outcome) => {
        setBusy(false);
        if (outcome.ok) {
          onRequested(outcome.value);
          return;
        }
        setFailure(outcome.reason);
      },
    );
  };
  return (
    <DialogFrame
      busy={busy}
      confirmLabel={text('detail.retire.confirm')}
      confirmVariant="danger"
      description={text('detail.retire.description')}
      failure={failure}
      onClose={onClose}
      onConfirm={submit}
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
      <FormInput
        autoComplete="off"
        id="retire-market-code"
        label={text('detail.retire.typeCode', { code: market.marketCode })}
        name="confirmMarketCode"
        onChange={(event) => setTyped(event.target.value)}
        value={typed}
        {...(showIssues && !confirmed ? { validateStatus: 'error' as const } : {})}
      />
      <ReasonField
        id="retire-market-reason"
        label={text('detail.retire.reason')}
        onChange={setReason}
        showIssue={showIssues}
        value={reason}
      />
    </DialogFrame>
  );
};
