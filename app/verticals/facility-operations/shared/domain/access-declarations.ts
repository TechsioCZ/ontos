// The canonical Authorization v2 declarations of the Facility Operations module (ADR-0030), as plain
// data: the descriptors carry them, Core decodes them, and the owner asks the one access gate about
// exactly these keys, so a descriptor and the owner's business check can never name a capability
// differently.
import type { AccessDeclarationInput, AccessFieldGroupInput } from '@app/core-runtime';

/** The Role-editor placement group of every facility declaration (a suggestion, never a grant). */
const placementGroup = 'facility-operations';

/** The records read every facility persona needs; it is the operational-agenda reach. */
export const facilityOperationsRecordsReadCapability = 'facility.operations.api-records.read' as const;
/** The overview read (Přehled provozu / Moje agenda); it narrows by the same reach. */
export const facilityOperationsOverviewReadCapability = 'facility.operations.api-overview.read' as const;
/** The one facility write Action. */
export const facilityOperationsApplyCommandCapability = 'facility.operations.apply-command.write' as const;
/**
 * The restricted agendas the operational reach does not include: finance values, purchasing,
 * documents, assets and security. The parent read also returns the allowlisted operational meter
 * fields, but none of the protected meter values listed below.
 */
export const facilityOperationsRecordsRestrictedCapability = 'facility.operations.records-restricted.read' as const;

/** Restricted agenda and meter-field paths in the records response. */
export const facilityOperationsRestrictedAgendaFields = [
  'agendas.assets',
  'agendas.documents',
  'agendas.meters.state.meters.consumer',
  'agendas.meters.state.meters.contract',
  'agendas.meters.state.meters.note',
  'agendas.meters.state.meters.supplier',
  'agendas.meters.state.meters.readings.costMinor',
  'agendas.meters.state.meters.readings.note',
  'agendas.meters.state.meters.readings.photo',
  'agendas.purchasing',
  'agendas.security',
] as const;

export const facilityOperationsRecordsReadDeclaration = {
  key: facilityOperationsRecordsReadCapability,
  kind: 'read',
  modes: ['run'],
  placement: { group: placementGroup, level: 'basic' },
  risk: 'sensitive',
  selectors: [],
} as const satisfies AccessDeclarationInput;

export const facilityOperationsOverviewReadDeclaration = {
  key: facilityOperationsOverviewReadCapability,
  kind: 'read',
  modes: ['run'],
  placement: { group: placementGroup, level: 'basic' },
  risk: 'sensitive',
  selectors: [],
} as const satisfies AccessDeclarationInput;

export const facilityOperationsApplyCommandDeclaration = {
  key: facilityOperationsApplyCommandCapability,
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  placement: { group: placementGroup, level: 'manage' },
  risk: 'sensitive',
  selectors: [],
} as const satisfies AccessDeclarationInput;

/** The field group that keeps the restricted agendas out of an operational reader's records read. */
export const facilityOperationsRecordsRestrictedGroup = {
  fieldClass: 'personal_data',
  fields: [...facilityOperationsRestrictedAgendaFields],
  key: facilityOperationsRecordsRestrictedCapability,
  kind: 'field_read',
  modes: ['run'],
  placement: { group: placementGroup, level: 'basic' },
  risk: 'sensitive',
  selectors: [],
} as const satisfies AccessFieldGroupInput;
