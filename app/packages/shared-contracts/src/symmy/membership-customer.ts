import { Option } from 'effect';

/** Coordinates of an exact owner source; identities and facts themselves are decoded by the public owner schemas. */
interface SourceKey {
  readonly issuer: string;
  readonly mappingRevision: string;
  readonly namespace: string;
  readonly recordId: string;
  readonly recordType: string;
  readonly route: { readonly id: string; readonly revision: string };
}
export const currentCustomerSourceMatches = (request: SourceKey, source: SourceKey): boolean =>
  source.issuer === request.issuer &&
  source.namespace === request.namespace &&
  source.recordType === request.recordType &&
  source.recordId === request.recordId &&
  source.mappingRevision === request.mappingRevision &&
  source.route.id === request.route.id &&
  source.route.revision === request.route.revision;
interface CurrentItem {
  readonly icoAuthority?: string;
  readonly partyRef: { readonly tenantId: string };
  readonly profile: {
    readonly profileRef: { readonly kind: string; readonly tenantId: string };
    readonly state: string;
    readonly subject: { readonly kind: string };
  };
  readonly source: SourceKey;
}
/** Only the pure wire projection is shared; each process owns its client, error handling and validated contract. */
export const projectCurrentMembershipCustomer = <Fact>(
  request: SourceKey,
  tenantId: string,
  { item }: { readonly item: CurrentItem },
  decodeFact: (value: {
    readonly customerSource: SourceKey;
    readonly processingKind: 'ORG_BUSINESS_REFERENCE' | 'PERSONAL';
    readonly profile: { readonly profileKind: string; readonly profileRef: CurrentItem['profile']['profileRef'] };
  }) => Option.Option<Fact>,
) => {
  const { partyRef, profile, source } = item;
  if (
    !currentCustomerSourceMatches(request, source) ||
    profile.profileRef.tenantId !== tenantId ||
    partyRef.tenantId !== tenantId ||
    profile.subject.kind !== profile.profileRef.kind ||
    (profile.profileRef.kind === 'COUNTERPARTY' && item.icoAuthority === undefined)
  ) {
    return { status: 'INVALID' } as const;
  }
  if (profile.state !== 'ACTIVE') {
    return { status: 'INACTIVE' } as const;
  }
  const fact = decodeFact({
    customerSource: source,
    processingKind: item.icoAuthority === 'ORGANIZATION' ? 'ORG_BUSINESS_REFERENCE' : 'PERSONAL',
    profile: { profileKind: profile.profileRef.kind, profileRef: profile.profileRef },
  });
  return Option.isSome(fact) ? ({ fact: fact.value, status: 'CURRENT' } as const) : ({ status: 'INVALID' } as const);
};
