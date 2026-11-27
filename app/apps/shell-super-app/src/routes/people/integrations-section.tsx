// Správa oprávnění › Integrace: the Tenant's connector-partner integrations (Symmy, …) and their API keys. An
// integration is an `integration` Principal created for one connector partner (`CONNECTOR_PARTNERS`); its keys are
// tenant-managed and run through the same native, audited key Actions as an agent's, so issue, rotation, pause and
// revocation work alike. An issue or rotation may register a key value the partner already holds instead of a
// generated one; Better Auth stores it exactly like a key it generated.
import { dialogCloseLabel } from '@app/admin-ui';
import { FormInput } from '@app/admin-ui/form-controls';
import { CONNECTOR_PARTNERS, connectorPartnerKinds } from '@app/shared-contracts/integrations/connector-partners';
import type { ConnectorPartnerKind } from '@app/shared-contracts/integrations/connector-partners';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { Select } from '@techsio/ui-kit/molecules/select';
import { Effect, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { useEffect, useEffectEvent, useState, useSyncExternalStore } from 'react';

import { ShellPolicyConflictProblemSchema, ShellTargetForbiddenProblemSchema } from '../../../shared/browser-api.ts';
import type { ManagedApiKeyListResponse, ShellIntegrationComponent } from '../../../shared/browser-api.ts';
import { createNonHumanPrincipal, listManagedApiKeys } from '../../api/auth-client.ts';
import type { IdentityClientError } from '../../api/auth-client.ts';
import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import { ManagedKeyDetail } from './agent-api-keys.tsx';
import { IntegrationPartnerComponent } from './integration-partner-component.tsx';
import { integrationEntries } from './integrations-model.ts';
import type { IntegrationEntry } from './integrations-model.ts';
import { newRequestToken } from './people-client.ts';

const copyKey = 'shell.integrations';
const keysCopyKey = 'shell.integrations.keys';
const pageSize = 100;
const readTimeout = '30 seconds';

type ManagedItem = ManagedApiKeyListResponse['items'][number];

/** Every page of the tenant-managed list from `offset` on; integrations are few, so the section shows them all. */
const readManagedFrom = (
  offset: number,
  read: readonly ManagedItem[],
): Effect.Effect<readonly ManagedItem[], IdentityClientError> =>
  listManagedApiKeys({ limit: pageSize, offset, scope: 'tenant-managed' }).pipe(
    Effect.flatMap((page) =>
      page.nextOffset === null
        ? Effect.succeed([...read, ...page.items])
        : readManagedFrom(page.nextOffset, [...read, ...page.items]),
    ),
  );
const readIntegrations = readManagedFrom(0, []).pipe(Effect.map(integrationEntries));

const LiveChangeDetailSchema = Schema.Struct({
  apps: Schema.Union([Schema.Literal('all'), Schema.Array(Schema.String)]),
});
const changesIdentity = (event: Event): boolean =>
  Schema.decodeUnknownOption(LiveChangeDetailSchema)('detail' in event ? event.detail : null).pipe(
    Option.exists(({ apps }) => apps === 'all' || apps.includes('shell')),
  );

const isForbidden = Schema.is(ShellTargetForbiddenProblemSchema);

const useIntegrations = () => {
  const [entries, setEntries] = useState<readonly IntegrationEntry[] | null>(null);
  const [failure, setFailure] = useState<'failed' | 'forbidden' | null>(null);
  const load = () => {
    browserRuntime.runFork(
      readIntegrations.pipe(
        Effect.timeout(readTimeout),
        Effect.match({
          // A refusal of the Tenant's identity administration: this person may not manage integrations.
          onFailure: (problem) => setFailure(isForbidden(problem) ? 'forbidden' : 'failed'),
          onSuccess: (read) => {
            setFailure(null);
            setEntries(read);
          },
        }),
      ),
    );
  };
  const loadOnEvent = useEffectEvent(load);
  useEffect(() => {
    loadOnEvent();
    const follow = (event: Event) => {
      if (changesIdentity(event)) {
        loadOnEvent();
      }
    };
    globalThis.addEventListener(moduleChangeEvent, follow);
    return () => globalThis.removeEventListener(moduleChangeEvent, follow);
  }, []);
  return { entries, failure, load };
};

const CreateIntegrationDialog = ({
  onClose,
  onCreated,
}: {
  readonly onClose: () => void;
  readonly onCreated: () => void;
}) => {
  const { t } = useModernI18n();
  const [partner, setPartner] = useState<ConnectorPartnerKind>(connectorPartnerKinds[0] ?? 'symmy');
  const [name, setName] = useState<string>(CONNECTOR_PARTNERS[partner].label);
  const [state, setState] = useState<'conflict' | 'failed' | 'idle' | 'saving'>('idle');
  const choices = connectorPartnerKinds.map((kind) => ({ label: CONNECTOR_PARTNERS[kind].label, value: kind }));
  const save = () => {
    const displayName = name.trim();
    if (displayName.length === 0 || state === 'saving') {
      return;
    }
    setState('saving');
    browserRuntime.runFork(
      newRequestToken.pipe(
        Effect.flatMap((token) =>
          createNonHumanPrincipal(
            { displayName, integrationKind: partner, kind: 'integration' },
            { idempotencyKey: token },
          ),
        ),
        Effect.timeout(readTimeout),
        Effect.match({
          onFailure: (problem) =>
            setState(Schema.is(ShellPolicyConflictProblemSchema)(problem) ? 'conflict' : 'failed'),
          onSuccess: () => {
            setState('idle');
            onCreated();
          },
        }),
      ),
    );
  };
  return (
    <Dialog
      actions={
        <>
          <Button
            appearance="outline"
            disabled={state === 'saving'}
            onClick={onClose}
            severity="secondary"
            type="button"
          >
            {t(`${keysCopyKey}.cancel`)}
          </Button>
          <Button
            disabled={state === 'saving' || name.trim().length === 0}
            onClick={save}
            severity="primary"
            type="button"
          >
            {t(`${copyKey}.create`)}
          </Button>
        </>
      }
      closeLabel={dialogCloseLabel}
      closeOnInteractOutside={false}
      description={t(`${copyKey}.createDescription`)}
      onOpenChange={(details) => {
        if (!details.open && state !== 'saving') {
          onClose();
        }
      }}
      open
      title={t(`${copyKey}.create`)}
    >
      <div className="flex flex-col gap-200">
        <Select
          items={choices}
          onValueChange={(details) => {
            const [chosen] = details.value;
            const kind = connectorPartnerKinds.find((candidate) => candidate === chosen);
            if (kind !== undefined) {
              setPartner(kind);
              setName(CONNECTOR_PARTNERS[kind].label);
            }
          }}
          value={[partner]}
        >
          <Select.Label>{t(`${copyKey}.partner`)}</Select.Label>
          <Select.Control>
            <Select.Trigger>
              <Select.ValueText placeholder={t(`${copyKey}.partner`)} />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {choices.map((item) => (
                <Select.Item item={item} key={item.value}>
                  <Select.ItemText>{item.label}</Select.ItemText>
                  <Select.ItemIndicator />
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
        </Select>
        <FormInput
          autoComplete="off"
          label={t(`${copyKey}.name`)}
          maxLength={200}
          name="integrationName"
          onChange={(event) => setName(event.target.value)}
          required
          value={name}
        />
        {(state === 'failed' || state === 'conflict') && (
          <StatusText showIcon status="error">
            {t(`${keysCopyKey}.${state}`)}
          </StatusText>
        )}
      </div>
    </Dialog>
  );
};

// The page's own origin is where the partner sends; the server render has none.
const subscribeToNothing = () => constVoid;
const pageOrigin = () => globalThis.location.origin;
const serverOrigin = () => '';

/** What the person's composition offers on the Integrace cards: its revision and one component per partner kind. */
export interface IntegrationComponentOffers {
  readonly components: readonly ShellIntegrationComponent[];
  readonly compositionRevision: string;
}

const IntegrationCard = ({
  entry,
  offers,
}: {
  readonly entry: IntegrationEntry;
  readonly offers: IntegrationComponentOffers | undefined;
}) => {
  const { t } = useModernI18n();
  const partner = entry.integrationKind === null ? null : CONNECTOR_PARTNERS[entry.integrationKind];
  const origin = useSyncExternalStore(subscribeToNothing, pageOrigin, serverOrigin);
  const offered = offers?.components.find(({ connectorPartner }) => connectorPartner === entry.integrationKind);
  return (
    <li className="flex min-w-0 flex-col gap-100 rounded-md border border-border-primary/60 p-200">
      <div className="flex min-w-0 flex-wrap items-center gap-100">
        <span className="font-medium vertical-navigation-control">{entry.displayName ?? t(`${copyKey}.unnamed`)}</span>
        <Badge appearance="outline" severity="neutral" size="sm">
          {partner === null ? t(`${copyKey}.genericPartner`) : partner.label}
        </Badge>
        <Badge severity={entry.principalStatus === 'active' ? 'success' : 'neutral'} size="sm">
          {t(`${copyKey}.status.${entry.principalStatus}`)}
        </Badge>
      </div>
      {partner !== null && (
        <p className="text-fg-secondary text-xs vertical-navigation-control">
          {t(`${copyKey}.usage`, { header: partner.apiKeyHeader, url: `${origin}${partner.ingressPrefix}` })}{' '}
          <a className="underline" href={partner.docsPath} rel="noreferrer" target="_blank">
            {t(`${copyKey}.docs`)}
          </a>
        </p>
      )}
      {entry.principalStatus === 'active' && (
        <ManagedKeyDetail
          allowSuppliedSecret
          copyKey={keysCopyKey}
          subject={{ principalId: entry.principalId, scope: 'tenant-managed' }}
        />
      )}
      {entry.principalStatus === 'active' && offers !== undefined && offered !== undefined && (
        <IntegrationPartnerComponent
          compositionRevision={offers.compositionRevision}
          integrationPrincipalId={entry.principalId}
          offered={offered}
        />
      )}
    </li>
  );
};

/**
 * The Tenant's integrations and their keys; every change is a native, audited identity Action. Each active
 * integration also shows the component its connector partner's module offers, when the composition offers one.
 */
export const IntegrationsSection = ({ offers }: { readonly offers: IntegrationComponentOffers | undefined }) => {
  const { t } = useModernI18n();
  const { entries, failure, load } = useIntegrations();
  const [creating, setCreating] = useState(false);
  return (
    <section className="flex min-w-0 flex-col gap-200">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-100">
        <h2 className="font-semibold text-lg">{t(`${copyKey}.title`)}</h2>
        {failure !== 'forbidden' && (
          <Button
            disabled={entries === null}
            onClick={() => setCreating(true)}
            severity="primary"
            size="sm"
            type="button"
          >
            {t(`${copyKey}.create`)}
          </Button>
        )}
      </div>
      <p className="text-fg-secondary text-sm">{t(`${copyKey}.description`)}</p>
      {failure !== null && (
        <StatusText showIcon status={failure === 'forbidden' ? 'warning' : 'error'}>
          {t(`${copyKey}.${failure}`)}
        </StatusText>
      )}
      {failure === 'failed' && (
        <div>
          <Button appearance="outline" onClick={load} severity="secondary" size="sm" type="button">
            {t(`${keysCopyKey}.retry`)}
          </Button>
        </div>
      )}
      {entries?.length === 0 && <p className="text-fg-secondary text-sm">{t(`${copyKey}.empty`)}</p>}
      <ul className="flex min-w-0 flex-col gap-150">
        {entries?.map((entry) => (
          <IntegrationCard entry={entry} key={`${entry.principalId}:${entry.principalStatus}`} offers={offers} />
        ))}
      </ul>
      {creating && (
        <CreateIntegrationDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            load();
          }}
        />
      )}
    </section>
  );
};
