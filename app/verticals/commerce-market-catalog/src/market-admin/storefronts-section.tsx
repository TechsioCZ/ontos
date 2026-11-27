// "E-shopy" section of the market detail: the e-shops the market sells in, and associate / revise / remove.
import { SectionCard, useDraftSave, useUnsavedChangesGuard } from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import type { StorefrontApplicationSummary } from '@app/storefront-registry/api/storefront-applications';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import {
  ChoiceField,
  FormBuilder,
  FormReact,
  FormRoot,
  TextField,
  useAtomSet,
  useAtomSubscribe,
} from '@app/core-runtime/ui/form';
import { DateTime, Effect, Option, Schema } from 'effect';
import { Atom } from 'effect/reactivity';
import { useState } from 'react';
import { MarketChannelSchema } from '../../shared/market-contracts.ts';
import { AssociateStorefrontPayloadSchema } from '../../shared/actions/associate-storefront.ts';
import { RemoveStorefrontAssociationPayloadSchema } from '../../shared/actions/remove-storefront-association.ts';
import { ReviseStorefrontAssociationPayloadSchema } from '../../shared/actions/revise-storefront-association.ts';
import { executeAssociateStorefront } from '../api/associate-storefront-action-client.ts';
import { executeRemoveStorefrontAssociation } from '../api/remove-storefront-association-action-client.ts';
import { executeReviseStorefrontAssociation } from '../api/revise-storefront-association-action-client.ts';
import { browserAtomRuntime, browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { newUuid } from './browser-crypto.ts';
import type { CurrentAssociation, CurrentMarket, MarketChannel } from './eshops-model.ts';
import { storefrontName } from './eshops-model.ts';
import { storefrontChoices } from './market-detail-model.ts';
import type { StorefrontChoice } from './market-detail-model.ts';
import { dateOf, effectivePeriodOf } from './market-form.ts';
import { DialogFrame, FormDialogFrame } from './dialog-frame.tsx';
import { useOpenedValues } from './market-fields.tsx';
import { formatDay } from './definition-text.ts';
import { failureText, useMarketText } from './market-ui.tsx';
import { marketActionEffect, runMarketAction } from './page-data.ts';
import type { WriteFailure, WriteOutcome } from './page-data.ts';

const isProposal = Schema.is(ActionProposalAcceptedSchema);

const isChannel = Schema.is(MarketChannelSchema);

/**
 * The associate / revise form: the e-shop, its channel (`""` while the e-shop offers none) and the validity dates.
 * Picking changes only the form; the dialog's Uložit sends it through the save bar, so the form is never submitted.
 */
const associationForm = FormReact.make(
  FormBuilder.empty
    .addField('appId', Schema.String)
    .addField('channel', Schema.String)
    .addField('validFrom', Schema.String)
    .addField('validTo', Schema.String),
  {
    fields: { appId: ChoiceField, channel: ChoiceField, validFrom: TextField, validTo: TextField },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

type AssociationDraft = typeof associationForm.schema.Encoded;

const appIdField = associationForm.getFieldAtoms(associationForm.fields.appId);
const pickedAppId = appIdField.value.pipe(Atom.map(Option.getOrElse(() => '')));
const channelField = associationForm.getFieldAtoms(associationForm.fields.channel);

/** Another e-shop is sold to on its first channel; rendered inside the form, after it started. */
const FirstChannelOfPicked = ({ choices }: { readonly choices: readonly StorefrontChoice[] }) => {
  const setChannel = useAtomSet(channelField.setValue);
  useAtomSubscribe(
    pickedAppId,
    (appId) => {
      setChannel(choices.find((candidate) => candidate.appId === appId)?.channels[0] ?? '');
    },
    { immediate: false },
  );
  return null;
};

interface AssociationDialogProps {
  /** Present when an existing association is revised. */
  readonly association?: CurrentAssociation;
  readonly choices: readonly StorefrontChoice[];
  readonly market: CurrentMarket;
  readonly nameOf: (appId: string) => string;
  /** The change was parked for approval: nothing changed yet. */
  readonly onAwaitingApproval: () => void;
  readonly onClose: () => void;
  readonly onDone: (message: string) => void;
}

/** What the dialog opens with: the stored association, or the first e-shop and channel for a new one. */
const associationDraftOf = (
  association: CurrentAssociation | undefined,
  choices: readonly StorefrontChoice[],
): AssociationDraft => {
  const appId = association?.storefrontRef.appId ?? choices[0]?.appId ?? '';
  return {
    appId,
    channel: association?.channel ?? choices.find((candidate) => candidate.appId === appId)?.channels[0] ?? '',
    validFrom: association === undefined ? '' : dateOf(association.effectivePeriod.startsAt),
    validTo: association?.effectivePeriod.endsAt === undefined ? '' : dateOf(association.effectivePeriod.endsAt),
  };
};

const AssociationDialog = ({
  association,
  choices,
  market,
  nameOf,
  onAwaitingApproval,
  onClose,
  onDone,
}: AssociationDialogProps) => {
  const { text } = useMarketText();
  const opened = associationDraftOf(association, choices);
  const { ready, values: draft } = useOpenedValues(associationForm.values, opened);
  const setValues = useAtomSet(associationForm.setValues);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const choice = choices.find((candidate) => candidate.appId === draft.appId);
  const channelsOf = (selected: StorefrontChoice | undefined): readonly MarketChannel[] =>
    selected?.channels ?? (association === undefined ? [] : [association.channel]);
  const name = nameOf(draft.appId);
  const code = market.marketCode;
  const periodOf = (value: AssociationDraft, now: DateTime.Utc) => {
    const period = effectivePeriodOf({ validFrom: value.validFrom, validTo: value.validTo }, now);
    return association !== undefined && value.validFrom === dateOf(association.effectivePeriod.startsAt)
      ? { ...period, startsAt: DateTime.formatIso(association.effectivePeriod.startsAt) }
      : period;
  };
  const provenance = { kind: 'CONFIGURATION_ACTION' as const, reference: text('detail.storefronts.provenance') };
  /** Sends the association as the dialog's draft says; a new one gets its own id. */
  const send = (value: AssociationDraft, channel: MarketChannel): Effect.Effect<WriteOutcome<object>> => {
    const storefrontRef = { appId: value.appId, tenantId: market.marketRef.tenantId };
    if (association === undefined) {
      return marketActionEffect(
        Effect.all({ associationId: newUuid, now: DateTime.now }, { concurrency: 1 }).pipe(
          Effect.flatMap(({ associationId, now }) =>
            Schema.decodeUnknownEffect(AssociateStorefrontPayloadSchema)({
              associationId,
              channel,
              effectivePeriod: periodOf(value, now),
              expectedMarketDefinitionRevisionRef: market.definitionRevisionRef,
              marketRef: market.marketRef,
              provenance,
              reason: text('detail.storefronts.associateReason', { code, name: nameOf(value.appId) }),
              sellingLegalEntityRef: market.sellingLegalEntityRef,
              storefrontRef,
            }),
          ),
        ),
        executeAssociateStorefront,
      );
    }
    return marketActionEffect(
      DateTime.now.pipe(
        Effect.flatMap((now) =>
          Schema.decodeUnknownEffect(ReviseStorefrontAssociationPayloadSchema)({
            associationRef: association.associationRef,
            channel,
            effectivePeriod: periodOf(value, now),
            expectedRevision: association.revision,
            marketRef: market.marketRef,
            provenance,
            reason: text('detail.storefronts.reviseReason', { code, name: nameOf(value.appId) }),
            storefrontRef,
          }),
        ),
      ),
      executeReviseStorefrontAssociation,
    );
  };
  const record = useDraftSave<AssociationDraft, never>({
    // A new association exists nowhere yet: its confirmed version has no e-shop, so the pre-selected one is already
    // something Uložit can send.
    initial: association === undefined ? { ...opened, appId: '' } : undefined,
    isValid: (value) => value.appId !== '' && isChannel(value.channel),
    // Leaving asks only about what the user changed, not about the pre-selected defaults.
    opened,
    runtime: browserRuntime,
    save: (value) => {
      if (!isChannel(value.channel)) {
        return Effect.succeed<SaveOutcome>('failed');
      }
      return send(value, value.channel).pipe(
        Effect.map((outcome): SaveOutcome => {
          if (!outcome.ok) {
            setFailure(outcome.reason);
            return 'failed';
          }
          if (isProposal(outcome.value)) {
            onAwaitingApproval();
            return 'proposed';
          }
          onDone(
            text(association === undefined ? 'detail.storefronts.associated' : 'detail.storefronts.revised', {
              name: nameOf(value.appId),
            }),
          );
          return 'saved';
        }),
      );
    },
    value: draft,
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: () => setValues(opened) });
  const handleSave = record.save;
  return (
    <FormDialogFrame
      error={failure === null ? null : failureText(text, failure)}
      guard={guard}
      onClose={onClose}
      onSave={handleSave}
      status={record.status}
      title={
        association === undefined
          ? text('detail.storefronts.associateTitle', { code })
          : text('detail.storefronts.reviseTitle', { name })
      }
    >
      <FormRoot
        className="flex flex-col gap-200"
        defaultValues={opened}
        form={associationForm}
        translateMessage={(message) => text(message)}
      >
        {ready}
        <FirstChannelOfPicked choices={choices} />
        <associationForm.appId
          disabled={association !== undefined}
          items={choices.map((candidate) => ({ label: nameOf(candidate.appId), value: candidate.appId }))}
          label={text('detail.storefronts.storefront')}
        />
        <associationForm.channel
          items={channelsOf(choice).map((value) => ({ label: text(`form.channel${value}`), value }))}
          label={text('detail.storefronts.channel')}
        />
        <div className="grid grid-cols-2 gap-200">
          <associationForm.validFrom
            helpText={text('form.validFromHelp')}
            id="association-valid-from"
            label={text('form.validFrom')}
            name="validFrom"
            type="date"
          />
          <associationForm.validTo
            helpText={text('form.validToHelp')}
            id="association-valid-to"
            label={text('form.validTo')}
            name="validTo"
            type="date"
          />
        </div>
      </FormRoot>
    </FormDialogFrame>
  );
};

interface RemoveAssociationDialogProps {
  readonly association: CurrentAssociation;
  readonly market: CurrentMarket;
  readonly name: string;
  readonly onAwaitingApproval: () => void;
  readonly onClose: () => void;
  readonly onDone: (message: string) => void;
}

const RemoveAssociationDialog = ({
  association,
  market,
  name,
  onAwaitingApproval,
  onClose,
  onDone,
}: RemoveAssociationDialogProps) => {
  const { text } = useMarketText();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const submit = () => {
    setBusy(true);
    setFailure(null);
    runMarketAction(
      DateTime.now.pipe(
        Effect.flatMap((now) =>
          Schema.decodeUnknownEffect(RemoveStorefrontAssociationPayloadSchema)({
            associationRef: association.associationRef,
            effectiveAt: DateTime.formatIso(now),
            expectedRevision: association.revision,
            marketRef: market.marketRef,
            reason: text('detail.storefronts.removeReason', { code: market.marketCode, name }),
            storefrontRef: association.storefrontRef,
          }),
        ),
      ),
      executeRemoveStorefrontAssociation,
      (outcome) => {
        setBusy(false);
        if (outcome.ok && isProposal(outcome.value)) {
          onAwaitingApproval();
          return;
        }
        if (outcome.ok) {
          onDone(text('detail.storefronts.removed', { name }));
          return;
        }
        setFailure(outcome.reason);
      },
    );
  };
  return (
    <DialogFrame
      busy={busy}
      confirmLabel={text('detail.storefronts.remove')}
      confirmVariant="danger"
      description={text('detail.storefronts.removeDescription')}
      failure={failure}
      onClose={onClose}
      onConfirm={submit}
      title={text('detail.storefronts.removeTitle', { name })}
    />
  );
};

interface StorefrontsSectionProps {
  readonly associations: readonly CurrentAssociation[];
  readonly canAdminister: boolean;
  readonly market: CurrentMarket;
  /** A change was parked for approval: nothing changed yet. */
  readonly onAwaitingApproval: () => void;
  readonly onDone: (message: string) => void;
  readonly storefronts: readonly StorefrontApplicationSummary[];
}

type Editing =
  | { readonly kind: 'associate' }
  | { readonly association: CurrentAssociation; readonly kind: 'remove' }
  | { readonly association: CurrentAssociation; readonly kind: 'revise' };

export const StorefrontsSection = ({
  associations,
  canAdminister,
  market,
  onAwaitingApproval,
  onDone,
  storefronts,
}: StorefrontsSectionProps) => {
  const { text } = useMarketText();
  const [editing, setEditing] = useState<Editing | null>(null);
  const nameOf = (appId: string) => {
    const index = storefronts.findIndex((storefront) => storefront.storefrontAppId === appId);
    return storefrontName(appId, index === -1 ? storefronts.length + 1 : index + 1, (position) =>
      text('eshops.unnamed', { position }),
    );
  };
  const choices = storefrontChoices(storefronts, market);
  const editable = canAdminister && market.lifecycle !== 'RETIRED';
  const finish = (message: string) => {
    setEditing(null);
    onDone(message);
  };
  const awaitingApproval = () => {
    setEditing(null);
    onAwaitingApproval();
  };
  return (
    <SectionCard
      actions={
        editable && choices.length > 0 ? (
          <Button appearance="solid" onClick={() => setEditing({ kind: 'associate' })} severity="primary" size="sm">
            {text('detail.storefronts.associate')}
          </Button>
        ) : undefined
      }
      title={text('detail.storefronts.title')}
    >
      {associations.length === 0 ? (
        <p className="text-fg-secondary text-sm">
          {editable && choices.length === 0 ? text('detail.storefronts.noChoices') : text('detail.storefronts.empty')}
        </p>
      ) : (
        <ul className="divide-y divide-border-primary/60">
          {associations.map((association) => (
            <li
              className="flex flex-wrap items-center justify-between gap-150 py-150"
              key={association.associationRef.resourceId}
            >
              <div className="flex flex-col gap-50">
                <span className="font-medium">{nameOf(association.storefrontRef.appId)}</span>
                <span className="text-fg-secondary text-sm">
                  {association.channel} ·{' '}
                  {text('detail.storefronts.since', {
                    from: formatDay(association.effectivePeriod.startsAt, text('dateLocale')),
                  })}
                  {association.effectivePeriod.endsAt === undefined
                    ? ''
                    : ` ${text('detail.storefronts.until', { to: formatDay(association.effectivePeriod.endsAt, text('dateLocale')) })}`}
                </span>
              </div>
              {editable && (
                <div className="flex gap-100">
                  <Button
                    appearance="outline"
                    onClick={() => setEditing({ association, kind: 'revise' })}
                    severity="secondary"
                    size="sm"
                  >
                    {text('detail.storefronts.revise')}
                  </Button>
                  <Button
                    appearance="outline"
                    onClick={() => setEditing({ association, kind: 'remove' })}
                    severity="danger"
                    size="sm"
                  >
                    {text('detail.storefronts.remove')}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing?.kind === 'associate' && (
        <AssociationDialog
          choices={choices}
          market={market}
          nameOf={nameOf}
          onAwaitingApproval={awaitingApproval}
          onClose={() => setEditing(null)}
          onDone={finish}
        />
      )}
      {editing?.kind === 'revise' && (
        <AssociationDialog
          association={editing.association}
          choices={choices}
          market={market}
          nameOf={nameOf}
          onAwaitingApproval={awaitingApproval}
          onClose={() => setEditing(null)}
          onDone={finish}
        />
      )}
      {editing?.kind === 'remove' && (
        <RemoveAssociationDialog
          association={editing.association}
          market={market}
          name={nameOf(editing.association.storefrontRef.appId)}
          onAwaitingApproval={awaitingApproval}
          onClose={() => setEditing(null)}
          onDone={finish}
        />
      )}
    </SectionCard>
  );
};
