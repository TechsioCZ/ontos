// Labels of filter and select options. A stored name that is an opaque ID is never shown: a client falls back to its
// registry name or IČO, and an option without any readable label is left out.
import { readableName } from '@app/admin-ui/visible-text';
import type { Client } from '../../shared/domain/clients.ts';
import type { Salesperson } from '../../shared/domain/team.ts';

export const clientOptionLabel = (client: Client): string | undefined => {
  const name = readableName(client.name) ?? readableName(client.partyRef?.registryName);
  if (name !== undefined) {
    return name;
  }
  const regNo = readableName(client.regNo);
  return regNo === undefined ? undefined : `IČO ${regNo}`;
};

/** Client options by label; clients without a readable label are left out, archived ones say so. */
export const clientOptions = (clients: readonly Client[]) =>
  clients
    .flatMap((client) => {
      const label = clientOptionLabel(client);
      if (label === undefined) {
        return [];
      }
      return [{ label: client.status === 'archived' ? `${label} (archivovaný)` : label, value: client.id }];
    })
    .toSorted((left, right) => left.label.localeCompare(right.label, 'cs'));

/** Salesperson options; inactive salespeople keep their option and are marked as removed. */
export const salespersonOptions = (people: readonly Salesperson[]) =>
  people.flatMap((person) => {
    const name = readableName(person.name);
    return name === undefined ? [] : [{ label: person.active ? name : `${name} (vyřazen)`, value: person.id }];
  });
