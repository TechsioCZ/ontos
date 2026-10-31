import { PgClient } from '@effect/sql-pg';
import { DateTime, Effect, Redacted, Schema } from 'effect';

import type { PlannedEmail } from './contract.ts';
import type { DeliveryScope } from './scope.ts';
import { escapeHtml } from './templates.ts';

const InvitationIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PersonInvitationId'));
const LegalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('LegalEntityId'));
const TenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('TenantId'));

export const PersonInvitationEmailInputSchema = Schema.Struct({
  createdAt: Schema.DateTimeUtcFromString,
  displayName: Schema.String,
  email: Schema.String,
  expiresAt: Schema.DateTimeUtcFromString,
  invitationId: InvitationIdSchema,
  legalEntityId: LegalEntityIdSchema,
  legalName: Schema.String,
  tenantId: TenantIdSchema,
  token: Schema.RedactedFromValue(Schema.String),
});
export type PersonInvitationEmailInput = typeof PersonInvitationEmailInputSchema.Type;

/** Read only committed, unexpired invitations in the dispatcher's installed RLS scope. Never expose the secret to receipts. */
export const readPersonInvitations = Effect.fn('PersonInvitation.readPersonInvitations')(
  function* readPersonInvitations(scope: DeliveryScope, invitationIds: readonly string[]) {
    if (invitationIds.length === 0) {
      return [];
    }
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql`
    select i.invitation_id::text as "invitationId", i.tenant_id::text as "tenantId",
      i.legal_entity_id::text as "legalEntityId", u.name as "displayName", u.email,
      le.legal_name as "legalName", substring(v.identifier from 16) as token,
      to_char(i.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
      to_char(i.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt"
    from core.person_invitations i
    join auth."user" u on u.id = i.provider_subject_id
    join auth.verification v on v.id = i.verification_id and v.value = i.provider_subject_id
    join core.legal_entities le on le.tenant_id = i.tenant_id and le.legal_entity_id = i.legal_entity_id
    where i.tenant_id = ${scope.tenantId}::uuid and i.legal_entity_id = ${scope.legalEntityId}::uuid
      and i.invitation_id::text in ${sql.in(invitationIds)}
      and i.expires_at > now() and v.expires_at > now()
      and v.identifier ~ '^reset-password:[A-Za-z0-9_-]{43}$'
    order by i.created_at, i.invitation_id`;
    return yield* Schema.decodeUnknownEffect(Schema.Array(PersonInvitationEmailInputSchema))(rows);
  },
);

export const planPersonInvitationEmail = (invitation: PersonInvitationEmailInput, appUrl: string): PlannedEmail => {
  const link = new URL('/cs/set-password', appUrl);
  link.searchParams.set('token', Redacted.value(invitation.token));
  const subject = `Pozvánka do OntOS – ${invitation.legalName}`;
  const text =
    `Dobrý den, ${invitation.displayName},\n\nadministrátor společnosti ${invitation.legalName} vás pozval do OntOS.\n` +
    `Pro nastavení vlastního hesla otevřete tento jednorázový odkaz:\n${link.href}\n\n` +
    `Platnost pozvánky končí ${DateTime.format(invitation.expiresAt, { dateStyle: 'medium', locale: 'cs-CZ', timeStyle: 'short', timeZone: 'Europe/Prague' })} (Praha).\n` +
    'Pozvánka sama nepřiděluje žádná oprávnění. Přístup nastavuje administrátor.\n' +
    'Pokud jste pozvánku neočekávali, můžete tento e-mail ignorovat.\n';
  return {
    dedupeKey: `person-invitation:${invitation.invitationId}`,
    event: 'PERSON_INVITED',
    eventAt: DateTime.formatIso(invitation.createdAt),
    eventLabel: 'Pozvánka do OntOS',
    html: `<!doctype html><html lang="cs"><meta charset="utf-8"><title>${escapeHtml(subject)}</title><body><p>${escapeHtml(text).replaceAll('\n', '<br>')}</p><p><a href="${escapeHtml(link.href)}">Nastavit heslo</a></p></body></html>`,
    legalEntityId: invitation.legalEntityId,
    recipient: invitation.email,
    source: 'person-invitation',
    subject,
    subjectId: invitation.invitationId,
    subjectNumber: '',
    tenantId: invitation.tenantId,
    text,
  };
};
