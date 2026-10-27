import { Context } from 'effect';
import type { Effect, Option } from 'effect';
import type { CrmReferenceUnavailable } from '../../shared/actions/apply-command.ts';
import type { VerifiedParty } from '../../shared/commands/context.ts';
import type { IntakeCrmClient } from './party-intake.ts';

/** Request-bound registry operations used by the sequential intake fold. */
export class PartyIntakeSteps extends Context.Service<
  PartyIntakeSteps,
  {
    readonly identify: (
      client: IntakeCrmClient,
      taken: ReadonlySet<string>,
      crmClients: readonly IntakeCrmClient[],
    ) => Effect.Effect<Option.Option<VerifiedParty>, CrmReferenceUnavailable>;
    readonly link: (
      clientId: string,
      party: VerifiedParty,
      expectedRevision: number,
    ) => Effect.Effect<number, CrmReferenceUnavailable>;
  }
>()('@app/crm/services/party-intake-steps/PartyIntakeSteps') {}
