import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { ActionHandlerContext, ScopedTransactionExecutor } from '@app/core-runtime';
import { createActionCollector } from '@app/core-runtime/testing/actions';
import { Effect, Schema } from 'effect';
import type { Crypto, Layer } from 'effect';

import type {
  SubmitCommunicationRequestPayload,
  SubmitCommunicationRequestResult,
} from '../../shared/communication-intake.ts';
import type { CommunicationDecisionService } from '../../src/domain/catalog/decision-service.ts';
import type { MessageTypeRegistryInvalid } from '../../src/domain/catalog/registry.ts';
import type { MessageTypeCatalog } from '../../src/domain/intake/message-type-catalog.ts';
import type { RecipientLanguageAuthority } from '../../src/domain/intake/recipient-language.ts';
import type { ProcessingScopeDeclaration } from '../../src/domain/intake/scope-declaration.ts';
import type { SourceOccurrenceAuthority } from '../../src/domain/intake/source-authority.ts';
import type { ProcessingEligibilityGate } from '../../src/domain/privacy/eligibility-gate.ts';
import type { RecipientCurrentGate } from '../../src/domain/recipient/current-gate.ts';
import {
  handleSubmitCommunicationRequest,
  submitCommunicationRequestAction,
} from '../../src/actions/submit-communication-request.action.ts';
import { communicationIntakeService } from '../../src/services/communication-intake.service.ts';
import type { makeRuntimeDatabase } from './persistence.fixture.ts';
import { asSourceWorker } from './source-worker-principal.ts';

export type RuntimeDatabase = Effect.Success<ReturnType<typeof makeRuntimeDatabase>>;
/** Every service the intake handler composes: the catalog and decision evaluator, the owner ports and Crypto. */
export type IntakeOwnerPorts = Layer.Layer<
  | CommunicationDecisionService
  | Crypto.Crypto
  | MessageTypeCatalog
  | ProcessingEligibilityGate
  | ProcessingScopeDeclaration
  | RecipientLanguageAuthority
  | RecipientCurrentGate
  | SourceOccurrenceAuthority,
  MessageTypeRegistryInvalid
>;
export interface IntakeRun {
  readonly outbox: readonly { readonly payloadJson: unknown; readonly topic: string }[];
  readonly result: SubmitCommunicationRequestResult;
}

const COMPOSITION_REVISION = 'a'.repeat(64);
const PRINCIPAL_ID = '00000000-0000-4000-8000-0000000000b1';

/** The module the fictional requests name as their source, and therefore the verified caller by default. */
export const FIXTURE_SOURCE_MODULE_KEY = 'fixture.source';

const principalOf = (tenantId: string, callerModule: string) =>
  Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
    authContextRef: 'job:communications-intake-tests:run:1',
    authMethod: 'system',
    principalId: PRINCIPAL_ID,
    tenantId,
  }).pipe(
    Effect.map((principal) =>
      asSourceWorker(
        { ...principal, correlationId: 'communications-intake-tests' },
        callerModule,
        COMPOSITION_REVISION,
      ),
    ),
    Effect.orDie,
  );

const runHandler = Effect.fn('CommunicationIntakeTest.runHandler')(function* runIntake(
  transaction: ScopedTransactionExecutor,
  tenantId: string,
  request: SubmitCommunicationRequestPayload,
  invocationId: string,
  callerModule: string,
) {
  const scope = yield* principalOf(tenantId, callerModule);
  const collector = createActionCollector(
    submitCommunicationRequestAction.descriptor.domainEvents,
    'communications.core',
    submitCommunicationRequestAction.descriptor.accessEvidencePolicy,
    undefined,
    COMPOSITION_REVISION,
  );
  const services = yield* communicationIntakeService(transaction, scope);
  const context: ActionHandlerContext<
    typeof submitCommunicationRequestAction.descriptor.domainEvents,
    typeof services
  > = {
    actionInvocationId: invocationId,
    addDomainEvent: collector.addDomainEvent,
    addOutboxMessage: collector.addOutboxMessage,
    compositionRevision: COMPOSITION_REVISION,
    recordAuditEvidence: collector.recordAuditEvidence,
    recordDataAccess: collector.recordDataAccess,
    scope,
    services,
  };
  const result = yield* handleSubmitCommunicationRequest(request, context);
  return {
    outbox: collector.snapshot().outboxMessages.map(({ message }) => ({
      payloadJson: message.payloadJson,
      topic: message.topic,
    })),
    result,
  } satisfies IntakeRun;
});

/**
 * Runs the REAL intake handler in ONE real Core transaction of the runtime role, with the Tenant installed by Core's own
 * scoped-transaction installer, exactly as the Action runtime calls it. Only the Action's own collector is in-process, so
 * the outbox messages it collects can be read back. Other owners are the labelled doubles of `intake-fixtures.ts`.
 */
export const intakeRunnerOver = (database: RuntimeDatabase, ownerPorts: IntakeOwnerPorts) => ({
  submit: (
    tenantId: string,
    request: SubmitCommunicationRequestPayload,
    invocationId = '00000000-0000-4000-8000-0000000000a9',
    callerModule = FIXTURE_SOURCE_MODULE_KEY,
  ): Effect.Effect<IntakeRun, unknown> =>
    database
      .inTenant(tenantId, (transaction) => runHandler(transaction, tenantId, request, invocationId, callerModule))
      .pipe(Effect.provide(ownerPorts)),
});
