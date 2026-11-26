// The component an integration's connector partner offers on its Integrace card (the core `integration` placement),
// loaded from the offering module through Module Federation. The Shell picks it by the integration's partner kind, never
// by module, and makes the Core identity writes it asks for once the administrator confirmed them.
import type {
  ConnectorPartnerComponentProps,
  ConnectorPartnerCoreWrite,
  ConnectorPartnerCoreWriteOutcome,
  ConnectorPartnerPrincipalId,
} from '@app/shared-contracts/integrations/connector-partner-component';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Exit, Fiber, Predicate, Schema } from 'effect';
import type { ComponentType } from 'react';
import { useEffect, useState } from 'react';

import {
  ChangeSystemWorkloadEnrollmentPayloadSchema,
  RegisterIntegrationWorkloadsPayloadSchema,
  ResolveModuleTargetPayloadSchema,
} from '../../../shared/browser-api.ts';
import type { ShellIntegrationComponent } from '../../../shared/browser-api.ts';
import {
  changeSystemWorkloadEnrollment,
  registerIntegrationWorkloads,
  resolveModuleTarget,
} from '../../api/auth-client.ts';
import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import { loadBrowserModuleEntrypoint } from '../module-entrypoint-loader.ts';
import { newRequestToken } from './people-client.ts';

const timeout = '60 seconds';

type PartnerComponent = ComponentType<ConnectorPartnerComponentProps>;

const PartnerComponentModuleSchema = Schema.Struct({
  default: Schema.declare((value): value is PartnerComponent => Predicate.isFunction(value)),
});

type LoadState =
  | { readonly Component: PartnerComponent; readonly state: 'ready' }
  | { readonly state: 'loading' }
  | { readonly state: 'unavailable' };

const loadPartnerComponent = (offered: ShellIntegrationComponent, compositionRevision: string) =>
  Schema.decodeEffect(ResolveModuleTargetPayloadSchema)({
    compositionRevision,
    entrypointKey: offered.entrypointKey,
    moduleId: offered.moduleId,
  }).pipe(
    Effect.flatMap((payload) => resolveModuleTarget(payload)),
    Effect.flatMap((target) => loadBrowserModuleEntrypoint(target, PartnerComponentModuleSchema)),
    Effect.timeout(timeout),
    Effect.exit,
    Effect.map((exit): LoadState => {
      if (Exit.isSuccess(exit) && exit.value.state === 'ready') {
        return { Component: exit.value.value.default, state: 'ready' };
      }
      return { state: 'unavailable' };
    }),
  );

/** The Core identity Action one confirmed write of the partner's component runs, for this integration. */
const coreWrite = Effect.fn('IntegrationPartnerComponent.coreWrite')(function* partnerCoreWrite(
  integrationPrincipalId: ConnectorPartnerPrincipalId,
  write: ConnectorPartnerCoreWrite,
) {
  const idempotencyKey = yield* newRequestToken;
  if (write.kind === 'enrollSystemWorkload') {
    const enrollment = yield* Schema.decodeUnknownEffect(ChangeSystemWorkloadEnrollmentPayloadSchema)({
      _tag: 'ENROLL',
      moduleKey: write.moduleKey,
      reason: write.reason,
      workloadKey: write.workloadKey,
    });
    yield* changeSystemWorkloadEnrollment(enrollment, { idempotencyKey });
    return;
  }
  const registration = yield* Schema.decodeUnknownEffect(RegisterIntegrationWorkloadsPayloadSchema)({
    principalId: integrationPrincipalId,
    workloadKeys: write.workloadKeys,
  });
  yield* registerIntegrationWorkloads(registration, { idempotencyKey });
});

const writeCoreFor =
  (integrationPrincipalId: ConnectorPartnerPrincipalId): ConnectorPartnerComponentProps['writeCore'] =>
  (write, settle) => {
    browserRuntime.runFork(
      coreWrite(integrationPrincipalId, write).pipe(
        Effect.timeout(timeout),
        Effect.exit,
        Effect.map((exit): ConnectorPartnerCoreWriteOutcome => (Exit.isSuccess(exit) ? 'done' : 'failed')),
        Effect.flatMap((outcome) => Effect.sync(() => settle(outcome))),
      ),
    );
  };

/** The partner's own component for one active integration; nothing while it loads, a notice when it cannot load. */
export const IntegrationPartnerComponent = ({
  compositionRevision,
  integrationPrincipalId,
  offered,
}: {
  readonly compositionRevision: string;
  readonly integrationPrincipalId: ConnectorPartnerPrincipalId;
  readonly offered: ShellIntegrationComponent;
}) => {
  const { t } = useModernI18n();
  const [loaded, setLoaded] = useState<LoadState>({ state: 'loading' });
  useEffect(() => {
    const fiber = browserRuntime.runFork(
      loadPartnerComponent(offered, compositionRevision).pipe(
        Effect.tap((state) => Effect.sync(() => setLoaded(state))),
      ),
    );
    return () => {
      browserRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, [compositionRevision, offered]);
  if (loaded.state === 'loading') {
    return null;
  }
  if (loaded.state === 'unavailable') {
    return (
      <StatusText showIcon status="error">
        {t('shell.integrations.partnerComponentUnavailable')}
      </StatusText>
    );
  }
  const { Component } = loaded;
  return <Component integrationPrincipalId={integrationPrincipalId} writeCore={writeCoreFor(integrationPrincipalId)} />;
};
