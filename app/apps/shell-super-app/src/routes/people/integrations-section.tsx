// Správa oprávnění › Integrace: the Tenant's connector-partner integrations (Symmy, …) and their API keys. An
// integration is an `integration` Principal created for one connector partner (`CONNECTOR_PARTNERS`); its keys are
// tenant-managed and run through the same native, audited key Actions as an agent's, so issue, rotation, pause and
// revocation work alike. An issue or rotation may register a key value the partner already holds instead of a
// generated one; Better Auth stores it exactly like a key it generated.
import { dialogCloseLabel, requiredLabelFor } from '@app/admin-ui';
import {
  ChoiceField,
  FormReact,
  FormRoot,
  FormRootError,
  TextField,
  fromPayload,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { CONNECTOR_PARTNERS, connectorPartnerKinds } from '@app/shared-contracts/integrations/connector-partners';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { Effect, Option, Schema, Struct } from 'effect';
import { constVoid } from 'effect/Function';
import { AsyncResult } from 'effect/reactivity';
import { useEffect, useEffectEvent, useState, useSyncExternalStore } from 'react';

import {
  CreateNonHumanPrincipalPayloadSchema,
  ShellPolicyConflictProblemSchema,
  ShellTargetForbiddenProblemSchema,
} from '../../../shared/browser-api.ts';
import type { ManagedApiKeyListResponse, ShellIntegrationComponent } from '../../../shared/browser-api.ts';
import { createNonHumanPrincipal, listManagedApiKeys } from '../../api/auth-client.ts';
import type { IdentityClientError } from '../../api/auth-client.ts';
import { browserAtomRuntime, browserRuntime } from '../../runtime/browser-effect-runtime.ts';
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

/** Why the Shell did not create the integration: the message key of the form-level error, if any. */
class CreateIntegrationRefused extends Schema.TaggedError<CreateIntegrationRefused>()('CreateIntegrationRefused', {
  /** `blank` is a name of only spaces: nothing is sent and nothing is said, as the create button is disabled for it. */
  reason: Schema.Literals(['blank', 'conflict', 'failed']),
}) {}

const [, integrationPayload] = CreateNonHumanPrincipalPayloadSchema.members;
const defaultPartner = connectorPartnerKinds[0] ?? 'symmy';

const createIntegration = Effect.fn('IntegrationsSection.createIntegration')(function* createIntegration(input: {
  readonly displayName: string;
  readonly integrationKind: string;
}) {
  const displayName = input.displayName.trim();
  if (displayName.length === 0) {
    return yield* new CreateIntegrationRefused({ reason: 'blank' });
  }
  const payload = yield* Schema.decodeUnknownEffect(integrationPayload)({
    displayName,
    integrationKind: input.integrationKind,
    kind: 'integration',
  }).pipe(Effect.catchTag('SchemaError', () => Effect.fail(new CreateIntegrationRefused({ reason: 'failed' }))));
  const token = yield* newRequestToken;
  return yield* createNonHumanPrincipal(payload, { idempotencyKey: token }).pipe(
    Effect.timeout(readTimeout),
    Effect.mapError(
      (problem) =>
        new CreateIntegrationRefused({
          reason: Schema.is(ShellPolicyConflictProblemSchema)(problem) ? 'conflict' : 'failed',
        }),
    ),
  );
});

/** A new integration of one connector partner; its name starts as the partner's and follows a change of partner. */
const createIntegrationForm = FormReact.make(
  fromPayload(integrationPayload.mapFields(Struct.pick(['displayName']))).addField('integrationKind', Schema.String),
  {
    fields: { displayName: TextField, integrationKind: ChoiceField },
    onSubmit: (_submit, { decoded }) => createIntegration(decoded),
    runtime: browserAtomRuntime,
    submitErrors: ({ reason }) => (reason === 'blank' ? [] : [{ message: `${keysCopyKey}.${reason}`, path: '' }]),
  },
);
const integrationName = createIntegrationForm.getFieldAtoms(createIntegrationForm.fields.displayName);
const integrationKind = createIntegrationForm.getFieldAtoms(createIntegrationForm.fields.integrationKind).value;

const CreateIntegrationDialog = ({
  onClose,
  onCreated,
}: {
  readonly onClose: () => void;
  readonly onCreated: () => void;
}) => {
  const { language, t } = useModernI18n();
  const submit = useAtomSet(createIntegrationForm.submit);
  const saving = useAtomValue(createIntegrationForm.submit).waiting;
  const name = Option.getOrElse(useAtomValue(integrationName.value), () => '');
  const setName = useAtomSet(integrationName.setValue);
  const choices = connectorPartnerKinds.map((kind) => ({ label: CONNECTOR_PARTNERS[kind].label, value: kind }));
  useAtomSubscribe(
    integrationKind,
    (chosen) => {
      const kind = connectorPartnerKinds.find((candidate) => Option.contains(chosen, candidate));
      if (kind !== undefined) {
        setName(CONNECTOR_PARTNERS[kind].label);
      }
    },
    { immediate: false },
  );
  useAtomSubscribe(createIntegrationForm.submit, (result) => {
    if (AsyncResult.isSuccess(result) && !result.waiting) {
      onCreated();
    }
  });
  return (
    <Dialog
      actions={
        <>
          <Button appearance="outline" disabled={saving} onClick={onClose} severity="secondary" type="button">
            {t(`${keysCopyKey}.cancel`)}
          </Button>
          <Button
            disabled={saving || name.trim().length === 0}
            onClick={() => submit()}
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
        if (!details.open && !saving) {
          onClose();
        }
      }}
      open
      title={t(`${copyKey}.create`)}
    >
      <FormRoot
        className="flex flex-col gap-200"
        defaultValues={{ displayName: CONNECTOR_PARTNERS[defaultPartner].label, integrationKind: defaultPartner }}
        form={createIntegrationForm}
        translateMessage={t}
      >
        <createIntegrationForm.integrationKind
          items={choices}
          label={t(`${copyKey}.partner`)}
          placeholder={t(`${copyKey}.partner`)}
        />
        <createIntegrationForm.displayName
          autoComplete="off"
          label={t(`${copyKey}.name`)}
          maxLength={200}
          name="integrationName"
          required
          requiredLabel={requiredLabelFor(language)}
        />
        <FormRootError form={createIntegrationForm} />
      </FormRoot>
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
