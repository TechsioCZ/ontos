/* eslint-disable complexity -- One closed mode matrix is clearer than distributed cross-field checks. */
import { Schema } from 'effect';

const uuid = Schema.String.check(Schema.isUUID());
const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

export const TrustedPrincipalContextSchema = Schema.Struct({
  authBindingId: Schema.optionalKey(uuid),
  authContextRef: Schema.optionalKey(nonEmptyString),
  authMethod: Schema.Literals(['session', 'api_key', 'system', 'support_impersonation']),
  impersonatedByPrincipalId: Schema.optionalKey(uuid),
  legalEntityId: Schema.optionalKey(uuid),
  principalId: uuid,
  tenantId: uuid,
}).check(
  Schema.makeFilter((context) => {
    const issues: Schema.FilterIssue[] = [];
    const safeSessionRef = context.authContextRef?.startsWith('better-auth-session:') === true;
    const safeKeyRef = context.authContextRef?.startsWith('better-auth-api-key:') === true;
    const safeJobRef =
      context.authContextRef !== undefined &&
      /^job:[^:]{1,100}:run:[^:]{1,200}$/u.test(context.authContextRef);
    if (
      context.authMethod === 'session' &&
      (context.authBindingId === undefined ||
        !safeSessionRef ||
        context.impersonatedByPrincipalId !== undefined)
    ) {
      issues.push({
        issue: 'session context requires a binding and safe session reference',
        path: ['authMethod'],
      });
    }
    if (
      context.authMethod === 'api_key' &&
      (context.authBindingId === undefined ||
        !safeKeyRef ||
        context.impersonatedByPrincipalId !== undefined)
    ) {
      issues.push({
        issue: 'api_key context requires a binding and safe key reference',
        path: ['authMethod'],
      });
    }
    if (
      context.authMethod === 'support_impersonation' &&
      (context.authBindingId === undefined ||
        !safeSessionRef ||
        context.impersonatedByPrincipalId === undefined ||
        context.impersonatedByPrincipalId === context.principalId)
    ) {
      issues.push({
        issue: 'support impersonation requires distinct effective and original principals',
        path: ['authMethod'],
      });
    }
    if (
      context.authMethod === 'system' &&
      (context.authBindingId !== undefined ||
        context.impersonatedByPrincipalId !== undefined ||
        context.legalEntityId !== undefined ||
        !safeJobRef)
    ) {
      issues.push({
        issue: 'system context requires only a safe job/run reference',
        path: ['authMethod'],
      });
    }
    return issues;
  }),
);

export type TrustedPrincipalContext = Schema.Schema.Type<typeof TrustedPrincipalContextSchema>;
