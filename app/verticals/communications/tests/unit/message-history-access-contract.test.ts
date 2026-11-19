import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'effect-rstest';

import { messageHistoryDetailOperation } from '../../shared/apis/message-history-detail.ts';
import { messageHistoryListOperation } from '../../shared/apis/message-history-list.ts';
import { messageHistoryDetailRead } from '../../src/api/message-history-detail.read.ts';
import { messageHistoryListRead } from '../../src/api/message-history-list.read.ts';

/**
 * [#1409] What the public history Reads DECLARE, and the guard that the access lane contains no destructive statement. The
 * permission keys below are PROPOSALS to the product owner: they enter the authorization catalog only through ADR-0030
 * adoption into a Role, and this lane grants nothing.
 */

const reads = [
  {
    fieldKey: 'communications.core.message-history-recipient-mask.list',
    key: 'communications.core.message-history.list',
    read: messageHistoryListRead,
  },
  {
    fieldKey: 'communications.core.message-history-recipient-mask.read',
    key: 'communications.core.message-history.read',
    read: messageHistoryDetailRead,
  },
] as const;

describe('The public history Reads declare exact-scope Current Permissions and nothing wider (#1409, ACC-02, ACC-03)', () => {
  it('are registered protected Reads of this owner with ONE permission each and one personal-data field group', () => {
    for (const { fieldKey, key, read } of reads) {
      const { descriptor } = read;
      expect(descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
      expect(descriptor.owningModuleKey).toBe('communications.core');
      expect(descriptor.accessDeclaration).toMatchObject({
        key,
        kind: 'read',
        modes: ['run'],
        risk: 'sensitive',
        selectors: [],
      });
      expect(descriptor.accessFieldGroups).toHaveLength(1);
      expect(descriptor.accessFieldGroups?.[0]).toMatchObject({
        fieldClass: 'personal_data',
        key: fieldKey,
        kind: 'field_read',
      });
      // exact scope: the Tenant always, the Legal Entity when the caller selected one; never a global fallback
      expect(descriptor.legalEntityScope).toBe('optional');
      // a Communications permission is a Communications key: it names no Order, Billing, Party, Counterparty or Media capability
      expect(key.startsWith('communications.core.')).toBe(true);
      expect(descriptor.accessWorkload).toBeUndefined();
    }
  });

  it('declare no export and no DSR delivery: history is a safe metadata Read, not a Data Subject Request (ACC-10)', () => {
    const kinds = reads.flatMap(({ read }) => [
      read.descriptor.accessDeclaration?.kind,
      ...(read.descriptor.accessFieldGroups?.map(({ kind }) => kind) ?? []),
    ]);
    expect(new Set(kinds)).toEqual(new Set(['read', 'field_read']));
    const names = reads.flatMap(({ read }) => [
      read.descriptor.readKey,
      read.descriptor.accessDeclaration?.key ?? '',
      ...(read.descriptor.accessFieldGroups?.map(({ key }) => key) ?? []),
    ]);
    expect(names.join(' ')).not.toMatch(/export|dsr|erase|anonymi[sz]e|purge|delete|retention|manage|notifications/u);
  });

  it('publish typed Core SDK operations of exactly this owner', () => {
    expect(messageHistoryListOperation).toMatchObject({
      kind: 'read',
      provider: { entrypointKey: 'communications.core.api.message-history-list', moduleId: 'communications.core' },
    });
    expect(messageHistoryDetailOperation).toMatchObject({
      kind: 'read',
      provider: { entrypointKey: 'communications.core.api.message-history-detail', moduleId: 'communications.core' },
    });
  });
});

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf-8');
/** The modules of the access lane: the Reads, their service, the projection, the visibility port and the document policy. */
const ACCESS_LANE = [
  '../../src/api/message-history-detail.read.ts',
  '../../src/api/message-history-list.read.ts',
  '../../src/api/message-history-support.ts',
  '../../src/domain/access/source-visibility.ts',
  '../../src/domain/documents/disclosure.ts',
  '../../src/domain/documents/document-owner.ts',
  '../../src/domain/documents/document-policy.ts',
  '../../src/history/message-history-projection.ts',
  '../../src/services/message-history-read.service.ts',
];
/** A write, a removal or a hidden cleanup. Comments are stripped first: the rule is about statements, not about words. */
const DESTRUCTIVE =
  /\.(?:delete|update|insert|execute)\s*\(|\bdelete\s+from\b|\btruncate\b|\bdrop\s+(?:table|column|schema)\b|\banonymi[sz]e\w*\s*\(|\bpurge\w*\s*\(|\b(?:unlink|rm|rmSync|writeFile)\s*\(/iu;
const withoutComments = (source: string) =>
  source.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/(?:^|[^:])\/\/.*$/gmu, '');

describe('No destructive statement exists in the access lane (#1409, ACC-12, AC-08)', () => {
  it('contains no DELETE, UPDATE, INSERT, TRUNCATE, ANONYMIZE, PURGE or file removal: reading, refusing and the document policy only decide', () => {
    for (const path of ACCESS_LANE) {
      const source = withoutComments(read(path));
      expect({ hit: DESTRUCTIVE.exec(source)?.[0] ?? null, path }).toEqual({ hit: null, path });
    }
  });

  it('the guard itself sees a destructive statement when there is one', () => {
    for (const sample of [
      'await tx.delete(messageIntents)',
      "tx.update(communicationRequests).set({ purpose: 'x' })",
      'delete from communications.message_intents',
      'anonymizeRecipient(id)',
      'purgeExpired(window)',
    ]) {
      expect(DESTRUCTIVE.test(sample)).toBe(true);
    }
    expect(
      DESTRUCTIVE.test(withoutComments('// delete from nothing\n/* tx.delete(x) */\nconst fine = tx.select()')),
    ).toBe(false);
  });
});
