import { startAutosave } from '@app/admin-ui';
import type { AutosaveOutcome } from '@app/admin-ui';
import { Effect, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';
import { DocumentSchema } from '../../shared/domain/documents.ts';
import {
  documentEditDraftOf,
  documentEditProblems,
  documentUpdateCommandOf,
  sameDocumentEditDraft,
} from '../../src/routes/[lang]/provoz/dokumenty/document-draft.ts';
import type { DocumentEditDraft } from '../../src/routes/[lang]/provoz/dokumenty/document-draft.ts';
import { facilityAutosaveOutcome } from '../../src/ui/facility-autosave.ts';
import type { CommandOutcome } from '../../src/ui/use-agenda.ts';

const principal = {
  principalId: '72000000-0000-4000-8000-000000000021',
  tenantId: '70000000-0000-4000-8000-000000000020',
} as const;

const documentRecord = Schema.decodeUnknownSync(DocumentSchema)({
  category: 'contract',
  contract: {
    contractType: 'Nájemní smlouva',
    owner: 'Jana Nováková',
    parties: ['Nájempark s.r.o.', 'Kavárna Dolce s.r.o.'],
    status: 'active',
    subject: 'Kancelář 2.04',
  },
  createdAt: '2026-10-01T08:00:00Z',
  createdBy: principal,
  id: 'doc-1',
  links: [{ id: 'riverside', kind: 'property', label: 'Riverside Office Park' }],
  title: 'Nájemní smlouva R204',
  updatedAt: '2026-10-01T08:00:00Z',
  updatedBy: principal,
  versions: [],
});

const stored = documentEditDraftOf(documentRecord);
const documentId = documentRecord.id;

describe('document edit draft', () => {
  it('starts from the stored document and ignores surrounding spaces in the comparison', () => {
    expect(stored.title).toBe('Nájemní smlouva R204');
    expect(stored.contract.parties).toBe('Nájempark s.r.o.\nKavárna Dolce s.r.o.');
    expect(sameDocumentEditDraft(stored, { ...stored, title: '  Nájemní smlouva R204 ' })).toBe(true);
    expect(sameDocumentEditDraft(stored, { ...stored, description: 'Příloha' })).toBe(false);
    expect(sameDocumentEditDraft(stored, { ...stored, links: [] })).toBe(false);
  });

  it('never saves an empty title and needs the contract terms of a contract category', () => {
    expect(Option.isNone(documentUpdateCommandOf(documentId, { ...stored, title: ' ' }))).toBe(true);
    const withoutTerms = { ...stored, contract: { ...stored.contract, owner: '' } };
    expect(documentEditProblems(withoutTerms).contract).toBe(true);
    expect(Option.isNone(documentUpdateCommandOf(documentId, withoutTerms))).toBe(true);
    // A protocol has no contract terms, so the same empty terms are harmless there.
    expect(Option.isSome(documentUpdateCommandOf(documentId, { ...withoutTerms, category: 'protocol' }))).toBe(true);
  });

  it('sends the trimmed title, the links and only the filled-in optionals', () => {
    const command = Option.getOrThrow(
      documentUpdateCommandOf(documentId, {
        ...stored,
        category: 'protocol',
        description: '  Předání prostor  ',
        title: '  Předávací protokol  ',
      }),
    );
    expect(command).toMatchObject({
      description: 'Předání prostor',
      documentId,
      title: 'Předávací protokol',
    });
    expect('contract' in command).toBe(false);
  });
});

const savedOutcome: CommandOutcome = {
  ok: true,
  result: { agenda: 'documents', entityIds: [], revision: 5 },
};
const refused = (reason: 'conflict' | 'forbidden'): CommandOutcome => ({ ok: false, reason });

describe('facility autosave outcome', () => {
  it.effect('maps a saved command, a stale revision and any other refusal', () =>
    Effect.gen(function* outcomes() {
      expect(yield* facilityAutosaveOutcome(Effect.succeed(savedOutcome))).toBe('saved');
      expect(yield* facilityAutosaveOutcome(Effect.succeed(refused('conflict')))).toBe('conflict');
      expect(yield* facilityAutosaveOutcome(Effect.succeed(refused('forbidden')))).toBe('failed');
    }),
  );
});

const panel = Effect.fnUntraced(function* panel(outcome: AutosaveOutcome) {
  const sent: DocumentEditDraft[] = [];
  const controller = yield* startAutosave(stored, {
    equals: sameDocumentEditDraft,
    isValid: (value: DocumentEditDraft) => Option.isSome(documentUpdateCommandOf(documentId, value)),
    save: (value: DocumentEditDraft) => Effect.sync(() => sent.push(value)).pipe(Effect.as(outcome)),
  });
  return { controller, sent };
});

describe('document edit panel autosave', () => {
  it.effect('saves a typed description after the quiet time; an empty title stays local', () =>
    Effect.gen(function* typed() {
      const { controller, sent } = yield* panel('saved');
      controller.change({ ...stored, title: '' });
      controller.flush();
      expect(controller.status()).toBe('invalid');
      controller.change({ ...stored, description: 'Příloha k podpisu' });
      yield* TestClock.adjust('800 millis');
      expect(sent.map(({ description }) => description)).toEqual(['Příloha k podpisu']);
      expect(controller.status()).toBe('saved');
    }),
  );

  it.effect('holds a conflicting draft instead of sending it again', () =>
    Effect.gen(function* conflict() {
      const { controller, sent } = yield* panel('conflict');
      controller.change({ ...stored, title: 'Nájemní smlouva R204 – oprava' });
      controller.flush();
      yield* Effect.yieldNow;
      expect(controller.status()).toBe('conflict');
      controller.change({ ...stored, title: 'Nájemní smlouva R204 – oprava 2' });
      yield* TestClock.adjust('1 second');
      expect(sent).toHaveLength(1);
    }),
  );
});
