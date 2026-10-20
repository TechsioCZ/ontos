import { expect, it } from 'effect-rstest';
import { metersAgenda } from '../../shared/commands/meters.ts';
import { canReadAgenda, canWriteAgenda } from '../../src/services/persistence.service.ts';

it('excludes financial meter histories from operational-only governed records and writes', () => {
  const external = { readAll: false, readOperational: true, writeAll: false, writeOperational: true };
  expect(metersAgenda.sensitivity).toBe('restricted');
  expect(canReadAgenda(external, metersAgenda.sensitivity)).toBe(false);
  expect(canWriteAgenda(external, metersAgenda.sensitivity)).toBe(false);
});

it('keeps authorized meter reads and separates read-only from write access', () => {
  const finance = { readAll: true, readOperational: false, writeAll: false, writeOperational: false };
  const operations = { ...finance, writeAll: true };
  expect(canReadAgenda(finance, metersAgenda.sensitivity)).toBe(true);
  expect(canWriteAgenda(finance, metersAgenda.sensitivity)).toBe(false);
  expect(canReadAgenda(operations, metersAgenda.sensitivity)).toBe(true);
  expect(canWriteAgenda(operations, metersAgenda.sensitivity)).toBe(true);
});
