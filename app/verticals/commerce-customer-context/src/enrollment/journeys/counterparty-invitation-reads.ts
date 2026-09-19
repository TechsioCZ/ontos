import { Context } from 'effect';

import type { CounterpartyAccessPortService } from '../../../shared/domain/access-port.ts';

/**
 * The only two published Counterparty Access reads the invitation journey may use.  Narrowing the
 * full access port to `check` and `getInvitation` is the point: an enrollment journey must be able
 * to re-verify an invitation and its grantor's Current authority, and must be structurally unable
 * to grant, revoke or claim anything through this seam.
 */
export interface CounterpartyInvitationReadsService {
  readonly check: CounterpartyAccessPortService['check'];
  readonly getInvitation: CounterpartyAccessPortService['getInvitation'];
}

export class CounterpartyInvitationReads extends Context.Service<
  CounterpartyInvitationReads,
  CounterpartyInvitationReadsService
>()('@app/commerce-customer-context/enrollment/journeys/counterparty-invitation-reads/CounterpartyInvitationReads') {}
