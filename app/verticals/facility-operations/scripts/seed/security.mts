// Seed of agenda `security` for Siampark (legal entity …0021). OWNED BY THE `security` LANE.
// Returns the ENCODED state with fixed ids/timestamps so reseeds are deterministic.
// Property/unit references are display snapshots of the rental seed (Rezidence Parková, Riverside Office Park);
// the ids are the ones the live rental seed produced, the labels keep the card readable if ids ever change.
import type { SecurityStateEncoded } from '../../shared/domain/security.ts';

const tenantId = '70000000-0000-4000-8000-000000000020';
const management = { principalId: '72000000-0000-4000-8000-000000000021', tenantId };
const operations = { principalId: '72000000-0000-4000-8000-000000000022', tenantId };

const riverside = {
  id: '6a0197b3-4b13-46c5-a3ab-8dbb46dda58e',
  kind: 'property',
  label: 'Riverside Office Park (RIVERSIDE)',
} as const;
const parkova = {
  id: 'f5ef97e9-2935-4ebc-83e6-aa9d475e561b',
  kind: 'property',
  label: 'Rezidence Parková (PARKOVA)',
} as const;
const r201 = {
  id: 'ec2c089a-69d4-459d-a67f-83d986add5f8',
  kind: 'unit',
  label: 'Riverside Office Park › Kancelář R201 (R201)',
} as const;
const s01 = {
  id: '1ecbca7a-0c49-49c3-a122-3d0d03476cad',
  kind: 'unit',
  label: 'Riverside Office Park › Sklad S01 (S01)',
} as const;

const deviceId = (n: number) => `73110000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
const incidentId = (n: number) => `73110000-0000-4000-8000-0000000002${String(n).padStart(2, '0')}`;

const audit = (createdAt: string, updatedAt = createdAt, by = management) => ({
  createdAt,
  createdBy: by,
  updatedAt,
  updatedBy: by,
});
const created = (at: string, name: string, by = management) => ({
  at,
  by,
  event: 'created' as const,
  summary: `Karta založena: ${name}`,
});

interface SeedDevice {
  readonly n: number;
  readonly name: string;
  readonly deviceType: 'camera' | 'access' | 'alarm' | 'other';
  readonly state: 'in_operation' | 'fault' | 'in_service' | 'decommissioned';
  readonly location: typeof riverside | typeof parkova | typeof r201 | typeof s01;
  readonly locationDetail: string;
  readonly administrator: string;
  readonly supplier: string;
  readonly serialNumber: string;
  readonly lastInspectionDate?: string;
  readonly nextInspectionDate?: string;
  readonly note?: string;
  readonly createdAt: string;
  readonly extraHistory?: readonly {
    at: string;
    event: 'inspection' | 'incident_reported' | 'incident_state' | 'state_changed';
    summary: string;
    by?: typeof management;
  }[];
}

const devices: readonly SeedDevice[] = [
  {
    administrator: 'Petr Dvořák (správce areálu)',
    createdAt: '2026-03-02T08:15:00.000Z',
    deviceType: 'camera',
    extraHistory: [
      { at: '2026-04-14T09:00:00.000Z', event: 'inspection', summary: 'Kontrola provedena 2026-04-14: bez závad' },
      {
        at: '2026-09-02T07:40:00.000Z',
        event: 'incident_reported',
        summary: 'Nahlášena porucha: Zamlžený kryt objektivu',
        by: operations,
      },
      {
        at: '2026-09-04T13:10:00.000Z',
        event: 'incident_state',
        summary: 'Porucha „Zamlžený kryt objektivu“: vyřešeno',
        by: operations,
      },
    ],
    lastInspectionDate: '2026-04-14',
    location: riverside,
    locationDetail: 'Vstupní hala, strop nad recepcí',
    n: 1,
    name: 'Kamera K-01 vstupní hala',
    nextInspectionDate: '2027-04-14',
    serialNumber: 'HIK-DS2CD-7731',
    state: 'in_operation',
    supplier: 'SecuriTech Praha s.r.o.',
  },
  {
    administrator: 'Petr Dvořák (správce areálu)',
    createdAt: '2026-03-02T08:20:00.000Z',
    deviceType: 'camera',
    extraHistory: [
      {
        at: '2026-10-17T06:45:00.000Z',
        event: 'incident_reported',
        summary: 'Nahlášena porucha: Kamera nezobrazuje obraz',
        by: operations,
      },
      {
        at: '2026-10-17T10:05:00.000Z',
        event: 'incident_state',
        summary: 'Porucha „Kamera nezobrazuje obraz“: v řešení',
      },
    ],
    lastInspectionDate: '2026-04-14',
    location: riverside,
    locationDetail: 'Parkoviště P1, sloup u vjezdu',
    n: 2,
    name: 'Kamera K-02 parkoviště P1',
    nextInspectionDate: '2027-04-14',
    serialNumber: 'HIK-DS2CD-7732',
    state: 'fault',
    supplier: 'SecuriTech Praha s.r.o.',
  },
  {
    administrator: 'Jana Malá (recepce)',
    createdAt: '2026-03-05T10:00:00.000Z',
    deviceType: 'access',
    extraHistory: [
      {
        at: '2026-08-11T07:30:00.000Z',
        event: 'incident_reported',
        summary: 'Nahlášena porucha: Čtečka nereaguje na karty',
      },
      {
        at: '2026-08-11T15:20:00.000Z',
        event: 'incident_state',
        summary: 'Porucha „Čtečka nereaguje na karty“: vyřešeno',
      },
    ],
    lastInspectionDate: '2025-10-15',
    location: riverside,
    locationDetail: 'Hlavní vchod, turniket A',
    n: 3,
    name: 'Přístupový terminál hlavní vchod',
    nextInspectionDate: '2026-10-15',
    note: 'Roční revize je po termínu, objednat u dodavatele.',
    serialNumber: 'ACS-T5-00418',
    state: 'in_operation',
    supplier: 'AccessPro CZ a.s.',
  },
  {
    administrator: 'Jana Malá (recepce)',
    createdAt: '2026-03-05T10:20:00.000Z',
    deviceType: 'access',
    lastInspectionDate: '2026-05-20',
    location: r201,
    locationDetail: 'Dveře kanceláře, čtečka karet',
    n: 4,
    name: 'Elektrický zámek R201',
    nextInspectionDate: '2027-05-20',
    serialNumber: 'ACS-L2-01193',
    state: 'in_operation',
    supplier: 'AccessPro CZ a.s.',
  },
  {
    administrator: 'Petr Dvořák (správce areálu)',
    createdAt: '2026-03-10T09:00:00.000Z',
    deviceType: 'alarm',
    extraHistory: [
      { at: '2026-10-12T08:00:00.000Z', event: 'state_changed', summary: 'Změna stavu: in_operation → in_service' },
    ],
    lastInspectionDate: '2025-11-03',
    location: parkova,
    locationDetail: 'Technická místnost 1. PP',
    n: 5,
    name: 'Ústředna EZS Rezidence Parková',
    nextInspectionDate: '2026-11-03',
    note: 'Plánovaná výměna záložního akumulátoru, servis do konce října.',
    serialNumber: 'JAB-JA101-55821',
    state: 'in_service',
    supplier: 'Alarmservis Novák s.r.o.',
  },
  {
    administrator: 'Petr Dvořák (správce areálu)',
    createdAt: '2026-03-10T09:30:00.000Z',
    deviceType: 'alarm',
    extraHistory: [
      {
        at: '2026-10-18T05:55:00.000Z',
        event: 'incident_reported',
        summary: 'Nahlášena porucha: Opakované falešné poplachy v noci',
        by: operations,
      },
    ],
    lastInspectionDate: '2025-11-03',
    location: s01,
    locationDetail: 'Sklad, roh u nakládací rampy',
    n: 6,
    name: 'Pohybové čidlo PIR sklad S01',
    nextInspectionDate: '2026-11-03',
    serialNumber: 'JAB-JA150P-20877',
    state: 'fault',
    supplier: 'Alarmservis Novák s.r.o.',
  },
  {
    administrator: 'Petr Dvořák (správce areálu)',
    createdAt: '2026-03-12T11:00:00.000Z',
    deviceType: 'camera',
    lastInspectionDate: '2026-06-09',
    location: parkova,
    locationDetail: 'Vjezd do podzemních garáží',
    n: 7,
    name: 'Kamera K-11 vjezd garáží',
    nextInspectionDate: '2027-06-09',
    serialNumber: 'AXIS-P3265-1120',
    state: 'in_operation',
    supplier: 'SecuriTech Praha s.r.o.',
  },
  {
    administrator: 'Jana Malá (recepce)',
    createdAt: '2026-03-12T11:30:00.000Z',
    deviceType: 'other',
    lastInspectionDate: '2026-06-09',
    location: parkova,
    locationDetail: 'Hlavní vstup, videovrátný',
    n: 8,
    name: 'Domovní videotelefon vchod A',
    nextInspectionDate: '2027-06-09',
    serialNumber: '2N-IPV-88310',
    state: 'in_operation',
    supplier: 'AccessPro CZ a.s.',
  },
  {
    administrator: 'Petr Dvořák (správce areálu)',
    createdAt: '2026-03-02T08:30:00.000Z',
    deviceType: 'camera',
    extraHistory: [
      { at: '2026-06-30T12:00:00.000Z', event: 'state_changed', summary: 'Změna stavu: in_operation → decommissioned' },
    ],
    location: riverside,
    locationDetail: 'Zadní dvůr (demontováno)',
    n: 9,
    name: 'Analogová kamera K-00 dvůr',
    note: 'Nahrazena kamerou K-02, uchováno pro historii.',
    serialNumber: 'AN-CAM-0007',
    state: 'decommissioned',
    supplier: 'SecuriTech Praha s.r.o.',
  },
];

const lastChange = (createdAt: string, history: SeedDevice['extraHistory']) =>
  [createdAt, ...(history ?? []).map((entry) => entry.at)].sort().at(-1) ?? createdAt;

export const seedSecurityState = (): SecurityStateEncoded => ({
  devices: devices.map(({ n, createdAt, extraHistory, ...device }) => ({
    ...device,
    ...audit(createdAt, lastChange(createdAt, extraHistory)),
    attachments: [],
    history: [
      created(createdAt, device.name),
      ...(extraHistory ?? []).map(({ by, ...entry }) => ({ ...entry, by: by ?? management })),
    ],
    id: deviceId(n),
  })),
  incidents: [
    {
      ...audit('2026-10-17T06:45:00.000Z', '2026-10-17T10:05:00.000Z', operations),
      description: 'Od rána je na záznamu černý obraz. Napájení LED svítí, síťový port bez spojení.',
      deviceId: deviceId(2),
      id: incidentId(1),
      occurredOn: '2026-10-17',
      severity: 'high',
      state: 'in_progress',
      title: 'Kamera nezobrazuje obraz',
    },
    {
      ...audit('2026-10-18T05:55:00.000Z', '2026-10-18T05:55:00.000Z', operations),
      description: 'Tři poplachy mezi 1:00 a 4:00, ostraha na místě nic nezjistila. Podezření na průvan od rampy.',
      deviceId: deviceId(6),
      id: incidentId(2),
      occurredOn: '2026-10-18',
      severity: 'medium',
      state: 'reported',
      title: 'Opakované falešné poplachy v noci',
    },
    {
      ...audit('2026-09-02T07:40:00.000Z', '2026-09-04T13:10:00.000Z', operations),
      deviceId: deviceId(1),
      id: incidentId(3),
      occurredOn: '2026-09-02',
      resolution: 'Kryt vyčištěn a utěsněn, obraz ověřen servisním technikem.',
      resolvedAt: '2026-09-04T13:10:00.000Z',
      severity: 'low',
      state: 'resolved',
      title: 'Zamlžený kryt objektivu',
    },
    {
      ...audit('2026-08-11T07:30:00.000Z', '2026-08-11T15:20:00.000Z'),
      description: 'Ráno nešlo projít turniketem A, zaměstnanci procházeli přes recepci.',
      deviceId: deviceId(3),
      id: incidentId(4),
      occurredOn: '2026-08-11',
      resolution: 'Vyměněn napájecí zdroj čtečky, dodavatel AccessPro CZ.',
      resolvedAt: '2026-08-11T15:20:00.000Z',
      severity: 'critical',
      state: 'resolved',
      title: 'Čtečka nereaguje na karty',
    },
  ],
});
