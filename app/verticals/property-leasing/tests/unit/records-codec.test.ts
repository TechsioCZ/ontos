import { DateTime, Effect, Exit, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import {
  OccupancyStateSchema,
  PreparedNoticeSchema,
  RegistrationSheetSchema,
  TenantCaseDetailsSchema,
  TenantDossierSchema,
} from '../../shared/apis/records.ts';
import type { RegistrationOccupantSchema } from '../../shared/apis/records.ts';

const occupancyId = '55555555-5555-4555-8555-555555555555';
const instant = '2026-10-27T12:34:56.789+02:00';
const canonicalInstant = '2026-10-27T10:34:56.789Z';
const caseWire: Schema.Codec.Encoded<typeof TenantCaseDetailsSchema> = {
  deadline: '2026-11-15',
  estimatedValueMinor: null,
  owner: 'Vedení',
  subject: 'Prodloužení nájmu',
};
const dossierWire: Schema.Codec.Encoded<typeof TenantDossierSchema> = {
  archived: false,
  caseState: 'NEW',
  contacts: [],
  counterpartyId: '44444444-4444-4444-8444-444444444444',
  history: [{ authorPrincipalId: 'unknown', kind: 'NOTE', occurredAt: instant, summary: 'První kontakt.' }],
};
const occupantWire: Schema.Codec.Encoded<typeof RegistrationOccupantSchema> = {
  address: '',
  birthDate: null,
  identityDocument: '',
  name: 'Eva Bílá',
  nationality: '',
};
const sheetWire: Schema.Codec.Encoded<typeof RegistrationSheetSchema> = {
  authorPrincipalId: 'unknown',
  createdAt: instant,
  endDate: null,
  note: '',
  number: 'EL-2026-001',
  occupancyId,
  occupants: [occupantWire],
  peopleCount: null,
  purpose: '',
  sheetId: 'abababab-abab-4bab-8bab-abababababab',
  startDate: '2026-10-27',
  unitId: '33333333-3333-4333-8333-333333333333',
};
const noticeWire: Schema.Codec.Encoded<typeof PreparedNoticeSchema> = {
  authorPrincipalId: 'unknown',
  body: 'Navrhněte termín předání.',
  channel: 'SMS',
  noticeId: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
  occupancyId,
  preparedAt: instant,
  recipient: '',
  subject: '',
  templateKey: 'lease-handover',
};

describe('property-leasing metadata wire codecs', () => {
  it.effect('keeps null absence distinct from an omitted case and preserves zero values', () =>
    Effect.gen(function* caseAbsence() {
      const details = yield* Schema.decodeEffect(TenantCaseDetailsSchema)(caseWire);
      expect(Option.isNone(details.estimatedValueMinor)).toBe(true);
      expect(yield* Schema.encodeEffect(TenantCaseDetailsSchema)(details)).toEqual(caseWire);
      const zeroWire = { ...caseWire, estimatedValueMinor: 0 };
      const zero = yield* Schema.decodeEffect(TenantCaseDetailsSchema)(zeroWire);
      expect(Option.getOrNull(zero.estimatedValueMinor)).toBe(0);
      expect(yield* Schema.encodeEffect(TenantCaseDetailsSchema)(zero)).toEqual(zeroWire);
      const dossier = yield* Schema.decodeEffect(TenantDossierSchema)(dossierWire);
      const encoded = yield* Schema.encodeEffect(TenantDossierSchema)(dossier);
      expect(Object.hasOwn(encoded, 'caseDetails')).toBe(false);
      expect(encoded).toEqual({
        ...dossierWire,
        history: [{ ...dossierWire.history[0], occurredAt: canonicalInstant }],
      });
      const withCase = yield* Schema.decodeEffect(TenantDossierSchema)({ ...dossierWire, caseDetails: caseWire });
      expect((yield* Schema.encodeEffect(TenantDossierSchema)(withCase)).caseDetails).toEqual(caseWire);
      expect(
        Exit.isFailure(
          Schema.decodeUnknownExit(TenantCaseDetailsSchema)({
            deadline: caseWire.deadline,
            owner: caseWire.owner,
            subject: caseWire.subject,
          }),
        ),
      ).toBe(true);
    }),
  );

  it.effect('round-trips empty optional sheet values and encodes native timestamps canonically', () =>
    Effect.gen(function* sheetCodec() {
      const sheet = yield* Schema.decodeEffect(RegistrationSheetSchema)(sheetWire);
      expect(Option.isNone(sheet.endDate)).toBe(true);
      expect(Option.isNone(sheet.peopleCount)).toBe(true);
      const [occupant] = sheet.occupants;
      expect(occupant).toBeDefined();
      if (occupant === undefined) {
        expect.unreachable('Expected the registration sheet occupant');
      }
      expect(Option.isNone(occupant.birthDate)).toBe(true);
      expect(DateTime.formatIso(sheet.createdAt)).toBe(canonicalInstant);
      expect(yield* Schema.encodeEffect(RegistrationSheetSchema)(sheet)).toEqual({
        ...sheetWire,
        createdAt: canonicalInstant,
      });
      const datedWire = {
        ...sheetWire,
        endDate: '2026-11-30',
        occupants: [{ ...occupantWire, birthDate: '1980-01-02' }],
        peopleCount: 2,
      };
      const dated = yield* Schema.decodeEffect(RegistrationSheetSchema)(datedWire);
      expect(yield* Schema.encodeEffect(RegistrationSheetSchema)(dated)).toEqual({
        ...datedWire,
        createdAt: canonicalInstant,
      });
    }),
  );

  it.effect('preserves empty notice fields and the absence of legacy metadata collections', () =>
    Effect.gen(function* noticeCodec() {
      const notice = yield* Schema.decodeEffect(PreparedNoticeSchema)(noticeWire);
      expect(DateTime.formatIso(notice.preparedAt)).toBe(canonicalInstant);
      expect(yield* Schema.encodeEffect(PreparedNoticeSchema)(notice)).toEqual({
        ...noticeWire,
        preparedAt: canonicalInstant,
      });
      const legacy = { occupancies: [] };
      const decoded = yield* Schema.decodeEffect(OccupancyStateSchema)(legacy);
      expect(yield* Schema.encodeEffect(OccupancyStateSchema)(decoded)).toEqual(legacy);
      const populated = yield* Schema.decodeEffect(OccupancyStateSchema)({
        ...legacy,
        occupancyHistory: [
          { authorPrincipalId: 'unknown', kind: 'CREATED', occupancyId, occurredAt: instant, summary: 'Návrh.' },
        ],
        preparedNotices: [noticeWire],
        registrationSheets: [sheetWire],
        tenantDossiers: [dossierWire],
      });
      const stored = yield* Schema.encodeEffect(OccupancyStateSchema)(populated);
      expect(stored.occupancyHistory?.[0]?.occurredAt).toBe(canonicalInstant);
      expect(stored.registrationSheets?.[0]?.endDate).toBeNull();
      expect(stored.preparedNotices?.[0]?.recipient).toBe('');
      expect(yield* Schema.decodeEffect(OccupancyStateSchema)(stored)).toEqual(populated);
    }),
  );
});
