import { SingleWorkCommandSchema } from '@app/work-tasks/contracts/apply-command';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TaggingCommandSchema } from '../../verticals/tagging/shared/actions/apply-command.ts';
import { canTransition } from '../../verticals/work-tasks/shared/actions/task-transitions.ts';
import {
  companyContent,
  dueDate,
  missingTags,
  missingTasks,
  personaPrincipalIds,
  statePath,
} from './company-content.mts';
import type { TagSpec, TaskSpec } from './company-content.mts';
import { demoTenantId, eshopDemoLegalEntityId } from './fixture-ids.mts';
import { rentalStory } from './rental-seed.mts';

const domainOf = (email: string) => email.slice(email.indexOf('@'));
const tagSpec = (name: string): TagSpec => ({
  color: 'gray',
  description: '',
  name,
  subjectKinds: ['customer'],
  subjects: [],
});
const taskSpec = (title: string): TaskSpec => ({
  assignee: 'finance@najempark.demo',
  description: '',
  dueInDays: 0,
  priority: 'NORMAL',
  state: 'NEW',
  title,
});

it('reaches every demo state from NEW through legal transitions only', () => {
  expect(statePath('NEW')).toEqual([]);
  expect(statePath('IN_PROGRESS')).toEqual(['IN_PROGRESS']);
  expect(statePath('WAITING')).toEqual(['IN_PROGRESS', 'WAITING']);
  expect(statePath('DONE')).toEqual(['IN_PROGRESS', 'DONE']);
  expect(statePath('CANCELLED')).toEqual(['CANCELLED']);
  for (const target of ['IN_PROGRESS', 'WAITING', 'DONE', 'CANCELLED'] as const) {
    const path = statePath(target);
    expect(path.every((state, index) => canTransition(index === 0 ? 'NEW' : (path[index - 1] ?? 'NEW'), state))).toBe(
      true,
    );
  }
});

it('adds only tags and tasks that are not there yet', () => {
  expect(missingTags([tagSpec('VIP'), tagSpec('Riziko')], [{ name: 'vip' }]).map((spec) => spec.name)).toEqual([
    'Riziko',
  ]);
  expect(missingTasks([taskSpec('A'), taskSpec('B')], ['B']).map((spec) => spec.title)).toEqual(['A']);
});

it('keeps every company catalogue small, unique and applicable to its own subjects', () => {
  for (const company of companyContent.filter((content) => content.tags.length > 0)) {
    expect(company.tags.length).toBeGreaterThanOrEqual(5);
    expect(company.tags.length).toBeLessThanOrEqual(8);
    const names = company.tags.map((tag) => tag.name.toLocaleLowerCase());
    expect(new Set(names).size).toBe(names.length);
    for (const tag of company.tags) {
      expect(tag.subjects.every((subject) => tag.subjectKinds.includes(subject.kind))).toBe(true);
      expect(
        tag.subjects.every(
          (subject) =>
            subject.kind !== 'employee' ||
            (personaPrincipalIds.has(subject.email) && domainOf(subject.email) === domainOf(company.writerEmail)),
        ),
      ).toBe(true);
    }
  }
});

it('seeds varied café work without writing its read-only tag catalogue', () => {
  const cafe = companyContent.find((company) => company.legalEntityId === eshopDemoLegalEntityId);
  expect(cafe).toBeDefined();
  expect(cafe?.writerEmail).toBe('eshop@kavarna.demo');
  expect(cafe?.tags).toEqual([]);
  expect(cafe?.tasks.length).toBe(8);
  expect(cafe?.tasks.every((task) => task.assignee === 'eshop@kavarna.demo')).toBe(true);
  expect(cafe?.tasks.some((task) => task.dueInDays < 0 && task.state === 'WAITING')).toBe(true);
  expect(cafe?.tasks.some((task) => task.dueInDays === 0)).toBe(true);
  expect(cafe?.tasks.some((task) => task.dueInDays > 0)).toBe(true);
  expect(missingTasks(cafe?.tasks ?? [], cafe?.tasks.map((task) => task.title) ?? [])).toEqual([]);
});

it('assigns every task to a persona of its own company and links only seeded rental records', () => {
  const tenants = new Set<string>(rentalStory.tenants.map((tenant) => tenant.name));
  for (const company of companyContent) {
    const titles = company.tasks.map((task) => task.title);
    expect(new Set(titles).size).toBe(titles.length);
    const assignees = new Set(company.tasks.map((task) => task.assignee));
    expect([...assignees].every((email) => personaPrincipalIds.has(email))).toBe(true);
    expect([...assignees].every((email) => domainOf(email) === domainOf(company.writerEmail))).toBe(true);
    expect(company.tasks.every((task) => task.customer === undefined || tenants.has(task.customer))).toBe(true);
    expect(
      company.tasks.every(
        (task) => task.opportunity === undefined || task.opportunity === rentalStory.opportunity.title,
      ),
    ).toBe(true);
    // Each state of the demo appears, so lists show open, waiting and finished work.
    expect(new Set(company.tasks.map((task) => task.state)).size).toBeGreaterThanOrEqual(4);
  }
});

it.effect('builds commands the tagging and work-tasks owners accept', () =>
  Effect.gen(function* commandsDecode() {
    const today = DateTime.makeUnsafe('2026-10-30T08:00:00.000Z');
    for (const company of companyContent) {
      yield* Effect.forEach(
        company.tags,
        (tag) =>
          Schema.decodeUnknownEffect(TaggingCommandSchema)({
            _tag: 'CreateTag',
            color: tag.color,
            description: tag.description,
            name: tag.name,
            subjectKinds: tag.subjectKinds,
          }),
        { concurrency: 1 },
      );
      yield* Effect.forEach(
        company.tasks,
        (task) =>
          Schema.decodeUnknownEffect(SingleWorkCommandSchema)({
            _tag: 'CreateTask',
            description: task.description,
            dueDate: dueDate(today, task.dueInDays),
            ownerPrincipalRef: { principalId: personaPrincipalIds.get(task.assignee), tenantId: demoTenantId },
            priority: task.priority,
            title: task.title,
          }),
        { concurrency: 1 },
      );
    }
    expect(dueDate(today, -3)).toBe('2026-10-27');
  }),
);
