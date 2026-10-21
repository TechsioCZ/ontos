// Pure helpers of the MCP resource server: Czech upstream errors, idempotent replay, search, input check.
// Run: pnpm --dir tools/ontos-agent-mcp exec rstest run tests/rs-helpers.test.ts
import assert from 'node:assert/strict';
import { describe, it } from '@rstest/core';
import { entryTitleCs } from '../src/catalog/labels-cs.ts';
import { czechProblem } from '../src/mcp/errors-cs.ts';
import { inputProblems } from '../src/mcp/input-check.ts';
import { DirectReplayCache, requestHash } from '../src/mcp/replay.ts';
import { matchesTokens, queryTokens } from '../src/mcp/search.ts';
import { annotationsFor, actionAvailability } from '../src/mcp/tool-plan.ts';
import type { CatalogAction } from '../src/capabilities/types.ts';

const action = (moduleId: string, commandTag: string | undefined, actionSlug = 'apply-command'): CatalogAction => ({
  actionSlug,
  appId: 'x',
  commandTag,
  id: `${moduleId}/${commandTag === undefined ? 'action' : 'command'}/${commandTag ?? actionSlug}`,
  inputSchema: { type: 'object' },
  kind: 'action',
  moduleId,
  proposable: false,
  toolName: 'x',
});

describe('czechProblem', () => {
  it('turns known English problems into Czech with a machine code', () => {
    const forbidden = czechProblem({ detail: 'The requested module is forbidden in the selected context.', status: 403 });
    assert.equal(forbidden.text, 'Tento modul není pro toto připojení v této firmě dostupný. (kód http_403)');
    assert.equal(forbidden.meta['ontos/detail'], 'The requested module is forbidden in the selected context.');
    const busy = czechProblem({ detail: 'The governed read is temporarily unavailable.', status: 503 });
    assert.ok(busy.text.startsWith('Modul je teď dočasně nedostupný.'));
    const conflict = czechProblem({ code: 'action_request_hash_conflict', detail: 'The Action conflicts with current state.', status: 409 });
    assert.ok(conflict.text.includes('idempotencyKey') && conflict.text.endsWith('(kód action_request_hash_conflict)'));
    const human = czechProblem({ code: 'merchandise_permission_denied', detail: 'Merchandise command ChangePrice is reserved for human users', status: 403 });
    assert.ok(human.text.startsWith('Tuto změnu smí v tomto modulu udělat jen člověk'));
    assert.ok(!/[A-Z][a-z]+ [a-z]+ [a-z]+ [a-z]+/u.test(czechProblem({ detail: 'Something odd happened here', status: 418 }).text));
  });

  it('keeps a detail that is already Czech', () => {
    const problem = czechProblem({ detail: 'Tato změna vyžaduje oprávnění správce', status: 403 });
    assert.equal(problem.text, 'Tato změna vyžaduje oprávnění správce. (kód http_403)');
  });
});

describe('DirectReplayCache', () => {
  it('returns the first result for the same key and input, refuses the key for another input, forgets after a day', () => {
    let now = 1_000;
    const cache = new DirectReplayCache(() => now);
    const hash = requestHash('work.tasks/command/CreateTask', { title: 'A', b: 1 });
    assert.equal(requestHash('work.tasks/command/CreateTask', { b: 1, title: 'A' }), hash);
    cache.remember('grant-1', 'k', hash, { status: 'executed' });
    assert.deepEqual(cache.lookup('grant-1', 'k', hash), { kind: 'hit', result: { status: 'executed' } });
    assert.deepEqual(cache.lookup('grant-1', 'k', 'other'), { kind: 'conflict' });
    assert.deepEqual(cache.lookup('grant-2', 'k', hash), { kind: 'miss' });
    now += 25 * 60 * 60 * 1000;
    assert.deepEqual(cache.lookup('grant-1', 'k', hash), { kind: 'miss' });
  });
});

describe('search tokens', () => {
  it('folds case and diacritics and strips Czech endings', () => {
    assert.deepEqual(queryTokens('Faktura'), ['faktu']);
    assert.ok(matchesTokens(queryTokens('pronájem'), 'Pronájmy a obsazenost'));
    assert.ok(matchesTokens(queryTokens('smlouva'), 'Smlouvy a dokumenty'));
    assert.ok(matchesTokens(queryTokens('ukol'), 'Úkoly a projekty'));
    assert.ok(!matchesTokens(queryTokens('faktura'), 'Úkoly a projekty'));
    assert.ok(matchesTokens([], 'cokoli'));
  });
});

describe('inputProblems', () => {
  it('lists missing, unknown and mistyped fields in Czech', () => {
    const schema = {
      additionalProperties: false,
      properties: { count: { type: 'integer' }, title: { type: 'string' } },
      required: ['title'],
      type: 'object',
    };
    assert.equal(inputProblems(schema, { title: 'A' }), undefined);
    const problems = inputProblems(schema, { count: 'x', titl: 'A' }, 'input') ?? '';
    assert.ok(problems.includes('chybí povinné pole „input.title“'), problems);
    assert.ok(problems.includes('neznámé pole „input.titl“'), problems);
    assert.ok(problems.includes('„input.count“ musí být celé číslo'), problems);
  });
});

describe('action availability and annotations', () => {
  it('hides demo maintenance always and human-only merchandise commands for direct writes', () => {
    assert.equal(actionAvailability(action('demo.merchandise', 'ResetDemoData'), 'approval'), 'demo_maintenance');
    assert.equal(actionAvailability(action('demo.merchandise', 'RemoveDemoOrder'), 'direct'), 'demo_maintenance');
    assert.equal(actionAvailability(action('demo.merchandise', 'ChangePrice'), 'direct'), 'human_only');
    assert.equal(actionAvailability(action('demo.merchandise', 'ChangePrice'), 'approval'), 'offered');
    assert.equal(actionAvailability(action('demo.crm', 'AiProposeChanges'), 'approval'), 'ai_meta');
  });

  it('marks erasing personal data, voiding and terminating as destructive', () => {
    assert.equal(annotationsFor(action('party.registry', undefined, 'execute-privacy-measure')).destructiveHint, true);
    assert.equal(annotationsFor(action('finance.billing', 'VoidInvoice')).destructiveHint, true);
    assert.equal(annotationsFor(action('legal.agreements', 'TerminateContract')).destructiveHint, true);
    assert.equal(annotationsFor(action('facility.operations', 'AssetDispose')).destructiveHint, true);
    assert.equal(annotationsFor(action('work.tasks', 'CreateTask')).destructiveHint, false);
  });
});

describe('Czech titles', () => {
  it('names facility, commerce and party entries in Czech', () => {
    assert.equal(entryTitleCs(action('facility.operations', 'AssetValueChange'), 'Provoz'), 'Změnit hodnotu majetku');
    assert.equal(
      entryTitleCs(action('commerce.customer-context', undefined, 'add-saved-address'), 'E-shop'),
      'Přidat uloženou adresu',
    );
    assert.equal(
      entryTitleCs(
        { appId: 'p', id: 'party.registry/read/counterparty-role-history', inputSchema: {}, kind: 'read', moduleId: 'party.registry', slug: 'counterparty-role-history', toolName: 'x' },
        'Registr',
      ),
      'Historie rolí obchodního partnera',
    );
  });
});
