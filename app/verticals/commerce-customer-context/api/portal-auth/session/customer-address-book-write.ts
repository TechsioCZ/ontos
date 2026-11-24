import { ActionRuntime } from '@app/core-runtime';
import { Crypto, Effect, Match } from 'effect';

import { mapAddSavedAddressActionProblem } from '../../add-saved-address-action-problems.ts';
import { mapRemoveSavedAddressActionProblem } from '../../remove-saved-address-action-problems.ts';
import { mapUpdateSavedAddressActionProblem } from '../../update-saved-address-action-problems.ts';
import {
  CUSTOMER_ADDRESS_BOOK_CONFLICT_STATUS,
  CustomerOwnAddressBookConflictProblemSchema,
} from '../../../shared/portal-auth/session-api.ts';
import type { CustomerOwnAddressBookCommand } from '../../../shared/portal-auth/session-api.ts';
import { addSavedAddressAction } from '../../../src/actions/add-saved-address.action.ts';
import { removeSavedAddressAction } from '../../../src/actions/remove-saved-address.action.ts';
import { updateSavedAddressAction } from '../../../src/actions/update-saved-address.action.ts';
import { customerAddressBookProfile } from './customer-address-book.ts';
import { admittedCustomerPrincipal } from './own-customer-principal.ts';
import type { CustomerOwnPortalScope } from './own-customer-principal.ts';

const addressConflict = () =>
  CustomerOwnAddressBookConflictProblemSchema.make({
    code: 'address_conflict',
    detail: 'The saved address could not be changed using the current request.',
    status: CUSTOMER_ADDRESS_BOOK_CONFLICT_STATUS,
    title: 'Saved address conflict',
    type: 'https://ontos.dev/problems/commerce-portal-address-conflict',
  });

/** Reuse the exact same Core Actions and owner rules as the native address-book API. */
export const changeCustomerOwnAddressBook = Effect.fn('CustomerOwnAddressBook.change')(function* changeAddressBook<
  Authentication,
  Forbidden,
  Invalid,
  Unavailable,
>(
  scope: CustomerOwnPortalScope,
  command: CustomerOwnAddressBookCommand,
  problems: {
    readonly authentication: () => Authentication;
    readonly forbidden: () => Forbidden;
    readonly invalid: () => Invalid;
    readonly unavailable: () => Unavailable;
  },
) {
  const principal = yield* admittedCustomerPrincipal(scope, problems.unavailable);
  const correlationId = yield* (yield* Crypto.Crypto).randomUUIDv4().pipe(Effect.mapError(problems.unavailable));
  const profile = customerAddressBookProfile(scope);
  const runtime = yield* ActionRuntime;
  const invocation = {
    audience: 'commerce-customer-context',
    principal,
    transport: { correlationId, idempotencyKey: `portal-address:${command.operationId}` },
  };
  const reason = 'Customer managed their saved address in the Commerce portal';
  const operation = Match.value(command).pipe(
    Match.discriminatorsExhaustive('operation')({
      add: ({ postalAddress, purposes }) =>
        runtime
          .runAction({
            ...invocation,
            payload: { origin: { kind: 'COMMERCE_ONLY', postalAddress }, profile, purposes, reason },
            registration: addSavedAddressAction,
          })
          .pipe(Effect.asVoid, Effect.mapError(mapAddSavedAddressActionProblem)),
      remove: ({ addressId, revision }) =>
        runtime
          .runAction({
            ...invocation,
            payload: {
              expectedRevision: revision,
              profile,
              reason,
              savedAddressRef: {
                moduleId: 'commerce.customer-context',
                resourceId: addressId,
                resourceType: 'commerce.customer-context.saved-address',
                tenantId: scope.tenantId,
              },
            },
            registration: removeSavedAddressAction,
          })
          .pipe(Effect.asVoid, Effect.mapError(mapRemoveSavedAddressActionProblem)),
      update: ({ addressId, postalAddress, purposes, revision }) =>
        runtime
          .runAction({
            ...invocation,
            payload: {
              expectedRevision: revision,
              origin: { kind: 'COMMERCE_ONLY', postalAddress },
              profile,
              purposes,
              reason,
              savedAddressRef: {
                moduleId: 'commerce.customer-context',
                resourceId: addressId,
                resourceType: 'commerce.customer-context.saved-address',
                tenantId: scope.tenantId,
              },
            },
            registration: updateSavedAddressAction,
          })
          .pipe(Effect.asVoid, Effect.mapError(mapUpdateSavedAddressActionProblem)),
    }),
  );
  return yield* operation.pipe(
    Effect.catch((error) =>
      Match.value(error.status).pipe(
        Match.when(400, () => Effect.fail(problems.invalid())),
        Match.when(401, () => Effect.fail(problems.authentication())),
        Match.when(403, () => Effect.fail(problems.forbidden())),
        Match.when(404, () => Effect.fail(addressConflict())),
        Match.when(409, () =>
          'resolution' in error && error.resolution === 'REFRESH_GOVERNED_READS'
            ? Effect.void
            : Effect.fail(addressConflict()),
        ),
        Match.when(422, () => Effect.fail(addressConflict())),
        Match.orElse(() => Effect.fail(problems.unavailable())),
      ),
    ),
  );
});
