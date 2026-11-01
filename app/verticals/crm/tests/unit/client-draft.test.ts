import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { ClientSchema } from '../../shared/domain/clients.ts';
import {
  draftOf,
  patchOf,
  sameClientDraft,
  validClientDraft,
} from '../../src/routes/[lang]/crm/klienti/client-draft.ts';

const at = '2026-11-01T10:00:00.000Z';
const client = Schema.decodeSync(ClientSchema)({
  createdAt: at,
  createdBy: 'client-draft-test',
  email: 'info@akros.cz',
  id: 'client-1',
  kind: 'organization',
  name: 'Akros',
  regNo: '12345678',
  status: 'active',
  updatedAt: at,
});
const saved = draftOf(client, 'none');

describe('client autosave draft', () => {
  it('treats a draft that differs only in surrounding spaces as already saved', () => {
    expect(sameClientDraft(saved, { ...saved, name: 'Akros ' })).toBe(true);
    expect(sameClientDraft(saved, { ...saved, name: 'Akros CZ' })).toBe(false);
  });

  it('never saves a client without a name, with a malformed e-mail or IČO', () => {
    expect(validClientDraft(saved)).toBe(true);
    expect(validClientDraft({ ...saved, name: '  ' })).toBe(false);
    expect(validClientDraft({ ...saved, email: 'info@' })).toBe(false);
    expect(validClientDraft({ ...saved, regNo: '123' })).toBe(false);
    expect(validClientDraft({ ...saved, kind: 'person', regNo: '123' })).toBe(true);
  });

  it('sends only the changed fields, trimmed, and clears an emptied one', () => {
    expect(patchOf(saved, client)).toEqual({});
    expect(patchOf({ ...saved, email: '', name: ' Akros CZ ' }, client)).toEqual({ email: '', name: 'Akros CZ' });
  });
});
