import { DateTime, Effect, Schema } from 'effect';

import { AccessDecisionGate } from '../access/enforcement/contract.ts';
import { defineSystemModuleEntrypoint } from '../modules/module-entrypoint.ts';
import type { OperationalScope } from '../operations/context.ts';
import { defineRead } from '../reads/definition.ts';
import { ReadHandlerUnavailable } from '../reads/errors.ts';

/*
 * Administration of a company's connected applications (O81): seeing every connection of the selected
 * company, disconnecting another person's connection, setting an agent's operators there, and reading
 * the revocation notes others wrote. It is one `admin` capability of the core.identity catalogue,
 * `core.identity.oauth-connection.administer`, decided in the selected company. Like every admin key it is
 * held structurally (the owner, the company's access administrators, a live delegation for it) and by
 * "Plný přístup", which follows each release by additions; no other preset role gains it by itself.
 *
 * This read is the capability's carrier: admitting it IS the answer, and it returns nothing else.
 */

export const OAuthConnectionAdministrationInputSchema = Schema.Struct({});
export const OAuthConnectionAdministrationResultSchema = Schema.Struct({ administers: Schema.Literal(true) });

export const oauthConnectionAdministrationRead = defineRead(
  {
    accessDeclaration: {
      key: 'core.identity.oauth-connection.administer',
      kind: 'admin',
      modes: ['run'],
      placement: { group: 'identity', level: 'manage' },
      risk: 'sensitive',
      selectors: [],
    },
    accessKind: 'detail',
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'protected' },
      entrypointKey: 'core.identity.oauth-connection-administration',
      moduleKey: 'core.identity',
      role: 'api',
    }),
    evidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'core.identity.oauth-connection-administration.access.v1',
    },
    inputSchema: OAuthConnectionAdministrationInputSchema,
    legalEntityScope: 'required',
    owningModuleKey: 'core.identity',
    policies: [],
    readKey: 'core.identity.oauth-connection-administration',
    resultSchema: OAuthConnectionAdministrationResultSchema,
    schemaVersion: '1',
  },
  () => Effect.succeed({ evidence: { resultCount: 1 }, result: { administers: true as const } }),
  () => Effect.succeed({}),
);

const administrationUnavailable = () =>
  new ReadHandlerUnavailable({
    code: 'read_handler_unavailable',
    reason: 'Connected-application administration authority is unavailable',
  });

/**
 * The same question asked from inside another Core read's `prepare` (before its transaction): whether the
 * caller administers the selected company's connected applications. An unreadable authority is unavailable,
 * never a smaller or a larger answer.
 */
export const administersOAuthConnections = Effect.fn('OAuthConnectionAdministration.administers')(
  function* administersOAuthConnections(scope: OperationalScope) {
    if (scope.legalEntityId === undefined) {
      return false;
    }
    const gate = yield* AccessDecisionGate;
    const decision = yield* gate.decide({
      carrier: oauthConnectionAdministrationRead.descriptor,
      legalEntityScope: 'required',
      now: DateTime.toDateUtc(yield* DateTime.now),
      scope,
    });
    if (decision.outcome === 'UNAVAILABLE') {
      return yield* administrationUnavailable();
    }
    return decision.outcome === 'ALLOWED';
  },
);
