import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { RecordsResponseSchema } from '../../shared/apis/records.ts';
import { CrmViewerSchema } from '../../shared/domain/access.ts';
import { CrmStateSchema, initialCrmState, projectCrmState } from '../../shared/domain/state.ts';
import { CrmQueryStringSchema } from '../../shared/route-search.ts';
import {
  defaultClientFilters,
  parseClientQuery,
  serializeClientQuery,
} from '../../src/routes/[lang]/crm/klienti/client-filters.ts';
import { contactSelectionOf } from '../../src/routes/[lang]/crm/klienti/clients-model.ts';

const at = '2026-11-03T00:00:00.000Z';

const client = (id: string, status: 'active' | 'archived' = 'active') => ({
  createdAt: at,
  createdBy: 'admin',
  id,
  kind: 'organization' as const,
  name: `Firma ${id}`,
  ownerSalespersonId: 'a',
  status,
  updatedAt: at,
});

const contact = (id: string, clientId: string, status: 'active' | 'archived' = 'active') => ({
  clientId,
  createdAt: at,
  createdBy: 'admin',
  email: `${id}@example.test`,
  id,
  name: `Osoba ${id}`,
  phone: '123 456 789',
  status,
  updatedAt: at,
});

const makeRecords = (items: ReturnType<typeof client>[], contacts: ReturnType<typeof contact>[]) =>
  Schema.decodeUnknownSync(RecordsResponseSchema)({
    assignmentCandidates: [],
    departedPrincipalIds: [],
    now: at,
    revision: 7,
    state: {
      ...Schema.encodeSync(CrmStateSchema)(initialCrmState),
      clients: { assignmentHistory: [], contacts, items },
      salespeople: [{ active: true, id: 'a', name: 'Anna', principalId: 'rep' }],
    },
    viewer: {
      assign: false,
      principalId: 'rep',
      readAll: false,
      readAssigned: true,
      salespersonId: 'a',
      writeAll: false,
      writeAssigned: true,
    },
  });

// A contact UUID deliberately equal to another client's UUID: the parent must still come from the contact row.
const records = makeRecords(
  [client('client-1'), client('client-2')],
  [
    contact('contact-1', 'client-1'),
    contact('client-2', 'client-1'),
    contact('contact-archived', 'client-1', 'archived'),
  ],
);

describe('CRM contact detail selection over authorized records', () => {
  it('opens the contact on its actual parent client, never the contact UUID as a client UUID', () => {
    const selection = contactSelectionOf(records, 'client-2');
    expect(selection?.contact.id).toBe('client-2');
    expect(selection?.contact.clientId).toBe('client-1');
    expect(selection?.client.id).toBe('client-1');
    expect(selection?.client.id).not.toBe('client-2');
  });

  it('resolves the exact authorized contact, including its parent and contact fields', () => {
    const selection = contactSelectionOf(records, 'contact-1');
    expect(selection?.contact.name).toBe('Osoba contact-1');
    expect(selection?.contact.email).toBe('contact-1@example.test');
    expect(selection?.client.name).toBe('Firma client-1');
  });

  it('does not resolve an archived contact', () => {
    expect(contactSelectionOf(records, 'contact-archived')).toBeUndefined();
  });

  it('does not resolve a contact whose parent client is absent from the authorized projection', () => {
    const orphaned = makeRecords([client('client-1')], [contact('contact-orphan', 'client-gone')]);
    expect(contactSelectionOf(orphaned, 'contact-orphan')).toBeUndefined();
  });

  it('does not resolve a contact that exists only in another company read', () => {
    const otherCompany = makeRecords([client('client-other')], [contact('contact-other-company', 'client-other')]);
    expect(contactSelectionOf(otherCompany, 'contact-other-company')).toBeDefined();
    expect(contactSelectionOf(records, 'contact-other-company')).toBeUndefined();
  });

  it('does not resolve an unassigned contact omitted from the assigned-only projection', () => {
    expect(contactSelectionOf(records, 'contact-unassigned')).toBeUndefined();
  });

  it('resolves only contacts of clients the assigned viewer may see', () => {
    const full = Schema.decodeUnknownSync(CrmStateSchema)({
      ...Schema.encodeSync(CrmStateSchema)(initialCrmState),
      clients: {
        assignmentHistory: [],
        contacts: [contact('contact-mine', 'client-mine'), contact('contact-other', 'client-other')],
        items: [
          { ...client('client-mine'), ownerSalespersonId: 'a' },
          { ...client('client-other'), ownerSalespersonId: 'b' },
        ],
      },
      salespeople: [
        { active: true, id: 'a', name: 'Anna', principalId: 'rep' },
        { active: true, id: 'b', name: 'Boris', principalId: 'rep-b' },
      ],
    });
    const viewer = Schema.decodeUnknownSync(CrmViewerSchema)({
      assign: false,
      principalId: 'rep',
      readAll: false,
      readAssigned: true,
      salespersonId: 'a',
      writeAll: false,
      writeAssigned: true,
    });
    const projected = Schema.decodeUnknownSync(RecordsResponseSchema)({
      assignmentCandidates: [],
      departedPrincipalIds: [],
      now: at,
      revision: 1,
      state: Schema.encodeSync(CrmStateSchema)(projectCrmState(full, viewer)),
      viewer,
    });
    expect(contactSelectionOf(projected, 'contact-mine')?.client.id).toBe('client-mine');
    expect(contactSelectionOf(projected, 'contact-other')).toBeUndefined();
  });

  it('does not resolve a forbidden or missing contact', () => {
    expect(contactSelectionOf(records, 'contact-forbidden')).toBeUndefined();
    expect(contactSelectionOf(records, 'contact-missing')).toBeUndefined();
  });

  it('does not resolve a contact whose parent client is archived', () => {
    const archivedClient = makeRecords([client('client-1', 'archived')], [contact('contact-1', 'client-1')]);
    expect(contactSelectionOf(archivedClient, 'contact-1')).toBeUndefined();
  });
});

describe('CRM contact detail URL contract', () => {
  it('round-trips the exact ?osoba contact ID as opaque text', () => {
    for (const id of ['00123', 'true', 'null', '"quoted"', '[1,2]', 'a+b /?#&=', '__proto__', 'Žluťoučký']) {
      const decoded = Schema.decodeUnknownSync(CrmQueryStringSchema)(new URLSearchParams({ osoba: id }).toString());
      expect(decoded.osoba).toBe(id);
      const roundTrip = Schema.decodeUnknownSync(CrmQueryStringSchema)(
        Schema.encodeSync(CrmQueryStringSchema)(decoded),
      );
      expect(roundTrip).toEqual(decoded);
    }
  });

  it('keeps the existing client selection and recency filter semantics unchanged', () => {
    const decoded = Schema.decodeUnknownSync(CrmQueryStringSchema)('?klient=client-1&kontakt=recent30&osoba=contact-1');
    expect(decoded.klient).toBe('client-1');
    expect(decoded.kontakt).toBe('recent30');
    expect(decoded.osoba).toBe('contact-1');
    const query = parseClientQuery('?klient=client-1&kontakt=recent30&osoba=contact-1');
    expect(query.filters.recency).toBe('recent30');
    expect(query.entity).toBe('client');
  });

  it('preserves ?osoba and ?klient while filter controls rewrite their own parameters', () => {
    const serialized = serializeClientQuery('?osoba=contact-1&klient=client-1', {
      entity: 'client',
      filters: { ...defaultClientFilters, status: 'archived' },
    });
    const params = new URLSearchParams(serialized);
    expect(params.get('osoba')).toBe('contact-1');
    expect(params.get('klient')).toBe('client-1');
    expect(params.get('stav')).toBe('archived');
  });

  it('never reads a contact UUID as the recent-contact filter', () => {
    const query = parseClientQuery('?osoba=contact-1');
    expect(query.filters.recency).toBe('all');
  });
});
