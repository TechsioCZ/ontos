/**
 * The text whose digest names the occurrence of one customer of a `POST /customer-groups/{code}/customers/batch`
 * request: the admitted route, the group it selects, the request's Idempotency-Key and the plan item. The owner keys a
 * membership assertion by profile and manager, which two group routes can share, so one key and position sent to two
 * routes names two assertions. The conformance suites seed Privacy for this exact occurrence before they submit.
 */
export const symmyGroupMembershipOccurrenceSeed = ({
  groupId,
  idempotencyKey,
  itemKey,
  routeId,
}: {
  readonly groupId: string;
  readonly idempotencyKey: string;
  readonly itemKey: string;
  readonly routeId: string;
}): string =>
  ['group-membership-occurrence', routeId, groupId, idempotencyKey, itemKey]
    .map((part) => `${part.length}:${part}`)
    .join('');
