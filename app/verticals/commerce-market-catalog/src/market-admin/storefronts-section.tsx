// "E-shopy" section of the market detail: the e-shops the market sells in, and associate / revise / remove.
import { SectionCard } from '@app/admin-ui';
import type { StorefrontApplicationSummary } from '@app/storefront-registry/api/storefront-applications';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { DateTime, Effect, Schema } from 'effect';
import { useState } from 'react';
import { AssociateStorefrontPayloadSchema } from '../../shared/actions/associate-storefront.ts';
import { RemoveStorefrontAssociationPayloadSchema } from '../../shared/actions/remove-storefront-association.ts';
import { ReviseStorefrontAssociationPayloadSchema } from '../../shared/actions/revise-storefront-association.ts';
import { executeAssociateStorefront } from '../api/associate-storefront-action-client.ts';
import { executeRemoveStorefrontAssociation } from '../api/remove-storefront-association-action-client.ts';
import { executeReviseStorefrontAssociation } from '../api/revise-storefront-association-action-client.ts';
import { newUuid } from './browser-crypto.ts';
import type { CurrentAssociation, CurrentMarket, MarketChannel } from './eshops-model.ts';
import { storefrontName } from './eshops-model.ts';
import { storefrontChoices } from './market-detail-model.ts';
import type { StorefrontChoice } from './market-detail-model.ts';
import { dateOf, effectivePeriodOf } from './market-form.ts';
import { DialogFrame } from './dialog-frame.tsx';
import { formatDay } from './definition-text.ts';
import { useMarketText } from './market-ui.tsx';
import { runMarketAction } from './page-data.ts';
import type { WriteFailure, WriteOutcome } from './page-data.ts';

const item = (value: string, label: string) => ({ displayValue: label, label, value });

interface AssociationDialogProps {
  /** Present when an existing association is revised. */
  readonly association?: CurrentAssociation;
  readonly choices: readonly StorefrontChoice[];
  readonly market: CurrentMarket;
  readonly nameOf: (appId: string) => string;
  readonly onClose: () => void;
  readonly onDone: (message: string) => void;
}

const AssociationDialog = ({ association, choices, market, nameOf, onClose, onDone }: AssociationDialogProps) => {
  const { text } = useMarketText();
  const [appId, setAppId] = useState(association?.storefrontRef.appId ?? choices[0]?.appId ?? '');
  const choice = choices.find((candidate) => candidate.appId === appId);
  const channelsOf = (selected: StorefrontChoice | undefined): readonly MarketChannel[] =>
    selected?.channels ?? (association === undefined ? [] : [association.channel]);
  const [channel, setChannel] = useState<MarketChannel | undefined>(association?.channel ?? choice?.channels[0]);
  const [validFrom, setValidFrom] = useState(
    association === undefined ? '' : dateOf(association.effectivePeriod.startsAt),
  );
  const [validTo, setValidTo] = useState(
    association?.effectivePeriod.endsAt === undefined ? '' : dateOf(association.effectivePeriod.endsAt),
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const name = nameOf(appId);
  const code = market.marketCode;
  const periodOf = (now: DateTime.Utc) => {
    const period = effectivePeriodOf({ validFrom, validTo }, now);
    return association !== undefined && validFrom === dateOf(association.effectivePeriod.startsAt)
      ? { ...period, startsAt: DateTime.formatIso(association.effectivePeriod.startsAt) }
      : period;
  };
  const provenance = { kind: 'CONFIGURATION_ACTION' as const, reference: text('detail.storefronts.provenance') };
  const done = (outcome: WriteOutcome<unknown>) => {
    setBusy(false);
    if (outcome.ok) {
      onDone(
        text(association === undefined ? 'detail.storefronts.associated' : 'detail.storefronts.revised', { name }),
      );
      return;
    }
    setFailure(outcome.reason);
  };
  const submit = () => {
    if (channel === undefined || appId === '') {
      setFailure('invalid');
      return;
    }
    setBusy(true);
    setFailure(null);
    const storefrontRef = { appId, tenantId: market.marketRef.tenantId };
    if (association === undefined) {
      runMarketAction(
        Effect.all({ associationId: newUuid, now: DateTime.now }, { concurrency: 1 }).pipe(
          Effect.flatMap(({ associationId, now }) =>
            Schema.decodeUnknownEffect(AssociateStorefrontPayloadSchema)({
              associationId,
              channel,
              effectivePeriod: periodOf(now),
              expectedMarketDefinitionRevisionRef: market.definitionRevisionRef,
              marketRef: market.marketRef,
              provenance,
              reason: text('detail.storefronts.associateReason', { code, name }),
              sellingLegalEntityRef: market.sellingLegalEntityRef,
              storefrontRef,
            }),
          ),
        ),
        executeAssociateStorefront,
        done,
      );
      return;
    }
    runMarketAction(
      DateTime.now.pipe(
        Effect.flatMap((now) =>
          Schema.decodeUnknownEffect(ReviseStorefrontAssociationPayloadSchema)({
            associationRef: association.associationRef,
            channel,
            effectivePeriod: periodOf(now),
            expectedRevision: association.revision,
            marketRef: market.marketRef,
            provenance,
            reason: text('detail.storefronts.reviseReason', { code, name }),
            storefrontRef,
          }),
        ),
      ),
      executeReviseStorefrontAssociation,
      done,
    );
  };
  return (
    <DialogFrame
      busy={busy}
      confirmLabel={text(association === undefined ? 'detail.storefronts.submit' : 'detail.storefronts.save')}
      confirmVariant="primary"
      failure={failure}
      onClose={onClose}
      onConfirm={submit}
      title={
        association === undefined
          ? text('detail.storefronts.associateTitle', { code })
          : text('detail.storefronts.reviseTitle', { name })
      }
    >
      <SelectTemplate
        disabled={association !== undefined}
        items={choices.map((candidate) => item(candidate.appId, nameOf(candidate.appId)))}
        label={text('detail.storefronts.storefront')}
        name="storefront"
        onValueChange={(details: { readonly value: readonly string[] }) => {
          const next = choices.find((candidate) => candidate.appId === details.value[0]);
          if (next !== undefined) {
            setAppId(next.appId);
            setChannel(next.channels[0]);
          }
        }}
        value={appId === '' ? [] : [appId]}
      />
      <SelectTemplate
        items={channelsOf(choice).map((value) => item(value, text(`form.channel${value}`)))}
        label={text('detail.storefronts.channel')}
        name="channel"
        onValueChange={(details: { readonly value: readonly string[] }) =>
          setChannel(channelsOf(choice).find((candidate) => candidate === details.value[0]))
        }
        value={channel === undefined ? [] : [channel]}
      />
      <div className="grid grid-cols-2 gap-200">
        <FormInput
          helpText={text('form.validFromHelp')}
          id="association-valid-from"
          label={text('form.validFrom')}
          name="validFrom"
          onChange={(event) => setValidFrom(event.target.value)}
          type="date"
          value={validFrom}
        />
        <FormInput
          helpText={text('form.validToHelp')}
          id="association-valid-to"
          label={text('form.validTo')}
          name="validTo"
          onChange={(event) => setValidTo(event.target.value)}
          type="date"
          value={validTo}
        />
      </div>
    </DialogFrame>
  );
};

interface RemoveAssociationDialogProps {
  readonly association: CurrentAssociation;
  readonly market: CurrentMarket;
  readonly name: string;
  readonly onClose: () => void;
  readonly onDone: (message: string) => void;
}

const RemoveAssociationDialog = ({ association, market, name, onClose, onDone }: RemoveAssociationDialogProps) => {
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
  return (
    <SectionCard
      actions={
        editable && choices.length > 0 ? (
          <Button onClick={() => setEditing({ kind: 'associate' })} size="sm" variant="secondary">
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
                    onClick={() => setEditing({ association, kind: 'revise' })}
                    size="sm"
                    theme="outlined"
                    variant="secondary"
                  >
                    {text('detail.storefronts.revise')}
                  </Button>
                  <Button
                    onClick={() => setEditing({ association, kind: 'remove' })}
                    size="sm"
                    theme="outlined"
                    variant="danger"
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
          onClose={() => setEditing(null)}
          onDone={finish}
        />
      )}
      {editing?.kind === 'remove' && (
        <RemoveAssociationDialog
          association={editing.association}
          market={market}
          name={nameOf(editing.association.storefrontRef.appId)}
          onClose={() => setEditing(null)}
          onDone={finish}
        />
      )}
    </SectionCard>
  );
};
