import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';
import { ClientSchema } from '../../shared/domain/clients.ts';
import { SalespersonSchema } from '../../shared/domain/team.ts';
import { clientOptionLabel, clientOptions, salespersonOptions } from '../../src/crm/option-labels.ts';

const at = '2026-10-29T12:00:00.000Z';
const opaqueId = '501c8023-4a74-52de-b20c-fc64856a9856';

interface ClientFields {
  readonly id?: string;
  readonly name?: string;
  readonly partyRef?: { readonly partyId: string; readonly registryName?: string };
  readonly regNo?: string;
  readonly status?: 'active' | 'archived';
}

interface PersonFields {
  readonly active?: boolean;
  readonly id?: string;
  readonly name?: string;
}

const client = (fields: ClientFields) =>
  Schema.decodeUnknownSync(ClientSchema)({
    createdAt: at,
    createdBy: 'admin',
    id: 'client-1',
    kind: 'organization',
    name: 'Velkoobchod Hanák',
    status: 'active',
    updatedAt: at,
    ...fields,
  });

const person = (fields: PersonFields) =>
  Schema.decodeUnknownSync(SalespersonSchema)({ active: true, id: 'person-1', name: 'Eva Nová', ...fields });

describe('crm option labels', () => {
  it('labels a client by its name, then its registry name, then its IČO, and never by an opaque ID', () => {
    expect(clientOptionLabel(client({}))).toBe('Velkoobchod Hanák');
    expect(
      clientOptionLabel(client({ name: opaqueId, partyRef: { partyId: 'party-1', registryName: 'Hanák s.r.o.' } })),
    ).toBe('Hanák s.r.o.');
    expect(clientOptionLabel(client({ name: opaqueId, regNo: '12345678' }))).toBe('IČO 12345678');
    expect(clientOptionLabel(client({ name: opaqueId }))).toBeUndefined();
  });

  it('leaves clients without a readable label out of the list and sorts the rest by label', () => {
    const options = clientOptions([
      client({ id: 'c-1', name: 'Zeta' }),
      client({ id: 'c-2', name: opaqueId }),
      client({ id: 'c-3', name: 'Alfa', status: 'archived' }),
      client({ id: 'c-4', name: opaqueId, regNo: '87654321' }),
    ]);
    expect(options).toEqual([
      { label: 'Alfa (archivovaný)', value: 'c-3' },
      { label: 'IČO 87654321', value: 'c-4' },
      { label: 'Zeta', value: 'c-1' },
    ]);
  });

  it('marks inactive salespeople and leaves out a salesperson whose stored name is an opaque ID', () => {
    expect(
      salespersonOptions([
        person({ id: 'p-1' }),
        person({ active: false, id: 'p-2', name: 'Petr Starý' }),
        person({ id: 'p-3', name: opaqueId }),
      ]),
    ).toEqual([
      { label: 'Eva Nová', value: 'p-1' },
      { label: 'Petr Starý (vyřazen)', value: 'p-2' },
    ]);
  });
});
