// Seed of agenda `documents` for Nájempark (legal entity …0021). OWNED BY THE `documents` LANE.
// Return the ENCODED state (ISO strings for dates, plain ids). It is validated against DocumentsStateSchema.
// Real seed files live in ./files (generated PDFs/PNGs); `seedDocumentFiles` lists them for facility_operations.files.
import { Effect, FileSystem, Path, Schema } from 'effect';
import type { DocumentsStateEncoded } from '../../shared/domain/documents.ts';

const seedText = {
  applicationPdf: 'application/pdf',
  janaSpravcova: 'Jana Správcová',
  kavarnaUParkuSRO: 'Kavárna U Parku s.r.o.',
  najemniSmlouvaObchodniProstorR101: 'Nájemní smlouva – Obchodní prostor R101',
  seedDocR101: 'seed-doc-r101',
} as const;

const tenantId = '70000000-0000-4000-8000-000000000020';
const management = { principalId: '72000000-0000-4000-8000-000000000021', tenantId };
const operations = { principalId: '72000000-0000-4000-8000-000000000022', tenantId };
const finance = { principalId: '72000000-0000-4000-8000-000000000023', tenantId };
type Actor = typeof management;

// Nájempark property/unit ids (property-portfolio) and contract ids (legal-agreements, deterministic demo ids).
const ref = {
  a202: {
    id: '675f7443-390d-4f9c-adfd-2a0471e9f331',
    kind: 'unit',
    label: 'Rezidence Parková › Byt A202 · 2+kk (A202)',
  },
  parkova: { id: 'f5ef97e9-2935-4ebc-83e6-aa9d475e561b', kind: 'property', label: 'Rezidence Parková (PARKOVA)' },
  r101: {
    id: 'bf65f06e-fe64-4787-813f-6a62bad12409',
    kind: 'unit',
    label: 'Riverside Office Park › Obchodní prostor R101 (R101)',
  },
  r201: {
    id: 'ec2c089a-69d4-459d-a67f-83d986add5f8',
    kind: 'unit',
    label: 'Riverside Office Park › Kancelář R201 (R201)',
  },
  riverside: {
    id: '6a0197b3-4b13-46c5-a3ab-8dbb46dda58e',
    kind: 'property',
    label: 'Riverside Office Park (RIVERSIDE)',
  },
} as const;
// Facility operations assets (assets lane seed, deterministic ids) — documents show on the asset card via LinkedDocuments.
const asset = {
  riversideBuilding: {
    id: 'siampark-asset-002',
    kind: 'asset',
    label: 'BUD-002 · Administrativní budova Riverside Office Park',
  },
  switchboard: { id: 'siampark-asset-011', kind: 'asset', label: 'TEC-008 · Hlavní rozvodna NN' },
} as const;
const tenant = (id: string, label: string) => ({ id: `tenant:${id}`, kind: 'tenant', label });
const agreement = (id: string, label: string) => ({ id, kind: 'contract', label });

type EncodedVersion = DocumentsStateEncoded['documents'][number]['versions'][number];
type MutableVersion = { -readonly [Key in keyof EncodedVersion]: EncodedVersion[Key] };

interface SeedFile {
  readonly createdAt: DocumentsStateEncoded['documents'][number]['createdAt'];
  readonly createdBy: Actor;
  readonly file: string;
  readonly id: string;
  readonly mime: string;
  readonly name: string;
}

const seedFiles: readonly SeedFile[] = [
  {
    createdAt: '2025-10-01T09:12:00Z',
    createdBy: management,
    file: 'r101-smlouva-navrh.pdf',
    id: 'seed-file-r101-v1',
    mime: seedText.applicationPdf,
    name: 'Nájemní smlouva R101 – návrh.pdf',
  },
  {
    createdAt: '2025-10-15T14:40:00Z',
    createdBy: management,
    file: 'r101-smlouva-podepsana.pdf',
    id: 'seed-file-r101-v2',
    mime: seedText.applicationPdf,
    name: 'Nájemní smlouva R101 – podepsaná.pdf',
  },
  {
    createdAt: '2026-03-12T10:05:00Z',
    createdBy: management,
    file: 'r101-dodatek-1.pdf',
    id: 'seed-file-r101-d1',
    mime: seedText.applicationPdf,
    name: 'Dodatek č. 1 R101 – předzahrádka.pdf',
  },
  {
    createdAt: '2025-12-10T16:20:00Z',
    createdBy: management,
    file: 'r201-smlouva.pdf',
    id: 'seed-file-r201-v1',
    mime: seedText.applicationPdf,
    name: 'Nájemní smlouva R201.pdf',
  },
  {
    createdAt: '2024-10-28T08:30:00Z',
    createdBy: operations,
    file: 'uklid-smlouva.pdf',
    id: 'seed-file-uklid-v1',
    mime: seedText.applicationPdf,
    name: 'Smlouva o úklidu – Parková.pdf',
  },
  {
    createdAt: '2026-09-19T07:50:00Z',
    createdBy: operations,
    file: 'revize-elektro-riverside.pdf',
    id: 'seed-file-revize-elektro',
    mime: seedText.applicationPdf,
    name: 'Revizní zpráva elektro – Riverside 2026.pdf',
  },
  {
    createdAt: '2026-08-31T15:10:00Z',
    createdBy: operations,
    file: 'predavaci-protokol-a202.pdf',
    id: 'seed-file-protokol-a202',
    mime: seedText.applicationPdf,
    name: 'Předávací protokol A202.pdf',
  },
  {
    createdAt: '2026-09-02T11:00:00Z',
    createdBy: management,
    file: 'pudorys-riverside-2np.png',
    id: 'seed-file-pudorys-2np',
    mime: 'image/png',
    name: 'Půdorys Riverside 2. NP.png',
  },
  {
    createdAt: '2026-10-14T13:25:00Z',
    createdBy: operations,
    file: 'foto-fasada-prasklina.png',
    id: 'seed-file-foto-fasada',
    mime: 'image/png',
    name: 'Fasáda R-blok – prasklina.png',
  },
];

const fileUrl = (file: string) => new URL(`files/${file}`, import.meta.url);

/** Rows for facility_operations.files (content read from ./files). */
export const seedDocumentFiles = Effect.fn('FacilityOperations.seedDocumentFiles')(function* seedDocumentFiles() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.forEach(
    seedFiles,
    (entry) =>
      Effect.gen(function* seedDocumentFile() {
        const filename = yield* path.fromFileUrl(fileUrl(entry.file));
        const bytes = yield* fs.readFile(filename);
        return {
          bytes: Buffer.from(bytes),
          createdAt: entry.createdAt,
          createdBy: entry.createdBy.principalId,
          id: entry.id,
          mime: entry.mime,
          name: entry.name,
        };
      }),
    { concurrency: 1 },
  );
});

class DocumentSeedFileMissing extends Schema.TaggedError<DocumentSeedFileMissing>()('DocumentSeedFileMissing', {
  message: Schema.String,
}) {}

const fileRef = Effect.fn('FacilityOperations.documentSeedFileRef')(function* fileRef(id: string) {
  const entry = seedFiles.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    return yield* new DocumentSeedFileMissing({ message: `Unknown seed file ${id}` });
  }
  const path = yield* Path.Path;
  const filename = yield* path.fromFileUrl(fileUrl(entry.file));
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(filename);
  return { id: entry.id, mime: entry.mime, name: entry.name, size: Number(info.size) };
});

const version = Effect.fn('FacilityOperations.documentSeedVersion')(function* version(
  fileId: string,
  number: number,
  note?: string,
) {
  const entry = seedFiles.find((candidate) => candidate.id === fileId);
  const seededVersion: MutableVersion = {
    file: yield* fileRef(fileId),
    uploadedAt: entry?.createdAt ?? '2026-01-01T00:00:00Z',
    uploadedBy: entry?.createdBy ?? management,
    version: number,
  };
  if (note !== undefined) {
    seededVersion.note = note;
  }
  return seededVersion;
});

const audit = (createdAt: string, createdBy: Actor, updatedAt = createdAt, updatedBy = createdBy) => ({
  createdAt,
  createdBy,
  updatedAt,
  updatedBy,
});

const siampark = 'Nájempark s.r.o.';

export const seedDocumentsState = Effect.fn('FacilityOperations.seedDocumentsState')(
  function* seedDocumentsState(): Effect.fn.Return<
    DocumentsStateEncoded,
    Effect.Error<ReturnType<typeof version>>,
    Effect.Services<ReturnType<typeof version>>
  > {
    return {
      comments: [
        {
          ...audit('2026-03-10T08:41:00Z', management),
          body: 'Nájemce žádá o předzahrádku od dubna. Připravím dodatek č. 1, finance prosím o kontrolu příplatku.',
          edits: [],
          id: 'seed-comment-r101-1',
          subject: { id: seedText.seedDocR101, kind: 'document', label: seedText.najemniSmlouvaObchodniProstorR101 },
        },
        {
          ...audit('2026-03-10T10:02:00Z', finance, '2026-03-10T10:15:00Z', finance),
          body: 'Příplatek 2 400 Kč měsíčně v sezóně je v pořádku, fakturace od dubna samostatnou položkou.',
          edits: [
            {
              body: 'Příplatek 2 400 Kč je v pořádku.',
              editedAt: '2026-03-10T10:15:00Z',
              editedBy: finance,
            },
          ],
          id: 'seed-comment-r101-2',
          subject: { id: seedText.seedDocR101, kind: 'document', label: seedText.najemniSmlouvaObchodniProstorR101 },
        },
        {
          ...audit('2026-10-15T07:30:00Z', operations),
          attachment: {
            id: 'seed-doc-revize-elektro',
            kind: 'document',
            label: 'Revizní zpráva elektro – Riverside 2026',
          },
          body: 'Revize elektro má dvě závady (popisky v RH 2. NP, nouzové osvětlení). Objednal jsem opravu, termín do 18. 10.',
          edits: [],
          id: 'seed-comment-channel-1',
          subject: { id: 'provoz', kind: 'channel', label: 'Provoz areálu' },
        },
        {
          ...audit('2026-10-15T08:05:00Z', management),
          attachment: {
            id: 'seed-doc-foto-fasada',
            kind: 'document',
            label: 'Fotodokumentace – prasklina fasády R-blok',
          },
          body: 'Díky. Prosím ještě zkontrolovat prasklinu na fasádě R-bloku — fotka je v dokumentech.',
          edits: [],
          id: 'seed-comment-channel-2',
          subject: { id: 'provoz', kind: 'channel', label: 'Provoz areálu' },
        },
        {
          ...audit('2026-10-19T16:20:00Z', operations),
          attachment: {
            id: 'seed-doc-uklid',
            kind: 'document',
            label: 'Smlouva o úklidu společných prostor – Parková',
          },
          body: 'Smlouva o úklidu Parkové končí 25. 10. Mám od Čistoty novou nabídku o 6 % dražší, rozhodneme na poradě?',
          edits: [],
          id: 'seed-comment-channel-3',
          subject: { id: 'vedeni', kind: 'channel', label: 'Vedení a smlouvy' },
        },
        {
          ...audit('2026-10-14T13:30:00Z', operations),
          body: 'Prasklina u okna 3. NP, cca 40 cm. Statik objednán na 22. 10.',
          edits: [],
          id: 'seed-comment-riverside-1',
          subject: ref.riverside,
        },
      ],
      documents: [
        {
          ...audit('2025-10-01T09:12:00Z', management, '2025-10-15T14:45:00Z', management),
          category: 'contract',
          contract: {
            amountTerms: '48 000 Kč měsíčně + zálohy na služby 6 500 Kč',
            contractType: 'Nájemní smlouva',
            noticeDate: '2028-04-30',
            noticePeriod: '6 měsíců ke konci kalendářního měsíce',
            owner: seedText.janaSpravcova,
            parties: [siampark, seedText.kavarnaUParkuSRO],
            status: 'active',
            subject: 'Nájem obchodního prostoru R101 pro provoz kavárny',
            validFrom: '2025-11-01',
            validTo: '2028-10-31',
          },
          description: 'Kavárna s předzahrádkou, provozní doba 7–20 h. Číslo smlouvy NS-2025/014.',
          id: seedText.seedDocR101,
          links: [
            ref.r101,
            ref.riverside,
            tenant('kavarna-u-parku', seedText.kavarnaUParkuSRO),
            agreement(
              'a0ac0359-d251-5b37-bed2-b9a0db201a77',
              'Smlouva v agendě Smlouvy: Nájem obchodního prostoru R101',
            ),
          ],
          signature: {
            recordedAt: '2025-10-15T14:45:00Z',
            recordedBy: management,
            signedBy: 'Petra Malá, jednatelka Kavárna U Parku s.r.o.',
            signedOn: '2025-10-15',
            version: 2,
          },
          title: seedText.najemniSmlouvaObchodniProstorR101,
          versions: [
            yield* version('seed-file-r101-v1', 1, 'Návrh k připomínkám nájemce'),
            yield* version('seed-file-r101-v2', 2, 'Podepsané znění (sken)'),
          ],
        },
        {
          ...audit('2026-03-12T10:05:00Z', management),
          amendsDocumentId: seedText.seedDocR101,
          category: 'amendment',
          contract: {
            amountTerms: 'Příplatek 2 400 Kč měsíčně v sezóně (duben–září)',
            contractType: 'Dodatek k nájemní smlouvě',
            owner: seedText.janaSpravcova,
            parties: [siampark, seedText.kavarnaUParkuSRO],
            status: 'active',
            subject: 'Rozšíření předmětu nájmu o předzahrádku 24 m²',
            validFrom: '2026-04-01',
            validTo: '2028-10-31',
          },
          id: 'seed-doc-r101-d1',
          links: [ref.r101, tenant('kavarna-u-parku', seedText.kavarnaUParkuSRO)],
          signature: {
            recordedAt: '2026-03-12T10:06:00Z',
            recordedBy: management,
            signedBy: 'Petra Malá, jednatelka Kavárna U Parku s.r.o.',
            signedOn: '2026-03-12',
            version: 1,
          },
          title: 'Dodatek č. 1 – předzahrádka R101',
          versions: [yield* version('seed-file-r101-d1', 1)],
        },
        {
          ...audit('2025-12-10T16:20:00Z', management),
          category: 'contract',
          contract: {
            amountTerms: '32 000 Kč měsíčně + zálohy na služby 4 200 Kč',
            contractType: 'Nájemní smlouva',
            noticePeriod: '3 měsíce',
            owner: seedText.janaSpravcova,
            parties: [siampark, 'Ateliér Horák s.r.o.'],
            status: 'active',
            subject: 'Nájem kanceláře R201 (2. NP) včetně dvou parkovacích stání',
            validFrom: '2026-01-01',
            validTo: '2027-12-31',
          },
          id: 'seed-doc-r201',
          links: [
            ref.r201,
            ref.riverside,
            tenant('atelier-horak', 'Ateliér Horák s.r.o.'),
            agreement('08b7022c-3168-5a9a-9fb7-e243767ff944', 'Smlouva v agendě Smlouvy: Nájem kanceláře R201'),
          ],
          signature: {
            recordedAt: '2025-12-10T16:25:00Z',
            recordedBy: management,
            signedBy: 'Ing. arch. Tomáš Horák',
            signedOn: '2025-12-10',
            version: 1,
          },
          title: 'Nájemní smlouva – Kancelář R201',
          versions: [yield* version('seed-file-r201-v1', 1)],
        },
        {
          ...audit('2024-10-28T08:30:00Z', operations),
          category: 'contract',
          contract: {
            amountTerms: '14 900 Kč měsíčně bez DPH',
            contractType: 'Smlouva o službách',
            noticePeriod: '1 měsíc',
            owner: 'Martin Provozní',
            parties: [siampark, 'Čistota Praha s.r.o.'],
            status: 'active',
            subject: 'Úklid společných prostor, mytí oken a zimní údržba – Rezidence Parková',
            validFrom: '2024-11-01',
            validTo: '2026-10-25',
          },
          description: 'Končí 25. 10. 2026 — rozhodnout o prodloužení nebo novém dodavateli.',
          id: 'seed-doc-uklid',
          links: [ref.parkova],
          title: 'Smlouva o úklidu společných prostor – Parková',
          versions: [yield* version('seed-file-uklid-v1', 1)],
        },
        {
          ...audit('2026-09-19T07:50:00Z', operations),
          category: 'revision',
          description:
            'Pravidelná revize elektroinstalace podle ČSN 33 1500. Dvě závady k odstranění, příští revize do 18. 9. 2029.',
          id: 'seed-doc-revize-elektro',
          links: [ref.riverside, asset.riversideBuilding, asset.switchboard],
          title: 'Revizní zpráva elektro – Riverside 2026',
          versions: [yield* version('seed-file-revize-elektro', 1)],
        },
        {
          ...audit('2026-08-31T15:10:00Z', operations),
          category: 'protocol',
          description: 'Vrácení bytu po ukončení nájmu dohodou, stavy měřidel a klíče.',
          id: 'seed-doc-protokol-a202',
          links: [ref.a202, ref.parkova, tenant('novotny-consulting', 'Novotný Consulting s.r.o.')],
          title: 'Předávací protokol – Byt A202',
          versions: [yield* version('seed-file-protokol-a202', 1)],
        },
        {
          ...audit('2026-09-02T11:00:00Z', management),
          category: 'plan',
          id: 'seed-doc-pudorys-2np',
          links: [ref.riverside, ref.r201, asset.riversideBuilding],
          title: 'Půdorys 2. NP – Riverside Office Park',
          versions: [yield* version('seed-file-pudorys-2np', 1)],
        },
        {
          ...audit('2026-10-14T13:25:00Z', operations),
          category: 'photo',
          description: 'Prasklina u okna ve 3. NP, R-blok. Statik objednán na 22. 10. 2026.',
          id: 'seed-doc-foto-fasada',
          links: [ref.riverside, asset.riversideBuilding],
          title: 'Fotodokumentace – prasklina fasády R-blok',
          versions: [yield* version('seed-file-foto-fasada', 1)],
        },
      ],
    };
  },
);
