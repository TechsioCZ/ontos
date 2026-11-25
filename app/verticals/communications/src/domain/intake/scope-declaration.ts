import { Context, Effect, Layer } from 'effect';

import type { CommunicationDecisionRequest } from '../catalog/decision-request.ts';
import type { TransactionalMessageType } from '../catalog/message-type.ts';
import type { AudienceSlotKey } from '../catalog/vocabulary.ts';
import type { ProcessingScope } from '../privacy/processing-scope.ts';
import type { OriginalRecipientBinding } from '../recipient/original-binding.ts';
import { ProcessingScopeUndeclared } from './scope-declaration-errors.ts';

/**
 * Where the exact Privacy Processing Scope of ONE message to ONE original recipient comes from. A source producer
 * declares it (Controller, purpose version, Processing Activity, subject locator); Communications never derives a
 * Controller, a purpose or a legal basis and never widens a scope. The scope is declared once at the decision, stored
 * with the intent and asked again, unchanged, before the last stoppable handoff.
 */
export interface ProcessingScopeDeclarationInput {
  readonly binding: OriginalRecipientBinding;
  readonly request: CommunicationDecisionRequest;
  readonly slotKey: AudienceSlotKey;
  readonly type: TransactionalMessageType;
}

export interface ProcessingScopeDeclarationService {
  readonly declare: (
    input: ProcessingScopeDeclarationInput,
  ) => Effect.Effect<ProcessingScope, ProcessingScopeUndeclared>;
}

export class ProcessingScopeDeclaration extends Context.Service<
  ProcessingScopeDeclaration,
  ProcessingScopeDeclarationService
>()('@app/communications/domain/intake/scope-declaration/ProcessingScopeDeclaration') {}

/**
 * The only production composition today. The scope is SOURCE-SUPPLIED (#1396 J: every involved source producer declares its exact
 * Privacy Subject, Controller, Purpose, Activity and material scope; Communications declares none and a type catalog entry never
 * could, as it would have to invent the Privacy owner's values). No approved Communication Request field carries it yet, and the
 * Privacy owner has not confirmed the purpose and operation names, so a recipient has no scope, Privacy is never asked about a
 * guess, and the message is stopped as an unresolved Privacy context (R-D9: any PROPOSED name stays marked).
 */
export const undeclaredProcessingScopeLayer = Layer.succeed(ProcessingScopeDeclaration, {
  declare: () => Effect.fail(new ProcessingScopeUndeclared({ reason: 'NO_DECLARATION' })),
});
