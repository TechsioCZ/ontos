import { expect, it } from 'effect-rstest';
import type { AgentCommand } from '@app/shared-contracts/agent-proposals';

import { clientReadEvidence, reviewCrmProposal, seesAllClients } from '../../src/api/agent-review.ts';
import type { CrmReviewViewer } from '../../src/api/agent-review.ts';

const clientOfJan = {
  id: 'c-jan',
  name: 'Pekárna Jan',
  ownerSalespersonId: 'sp-jan',
  phone: '+420 541 100 200',
  segment: 'retail',
};
const salesperson = (viewer: Partial<CrmReviewViewer>): CrmReviewViewer => ({
  assign: false,
  readAll: false,
  writeAll: false,
  writeAssigned: true,
  ...viewer,
});
const updateJansClient = { _tag: 'UpdateClient', id: 'c-jan', patch: { phone: '+420 541 100 299', segment: 'bakery' } };
const request = (command: AgentCommand, stage: 'history' | 'proposed' | 'undo' = 'proposed') => ({
  actionSlug: 'apply-command',
  command,
  key: 'k',
  stage,
});

it('a salesperson does not see proposals about a colleague client, not even in history', () => {
  const petra = salesperson({ salespersonId: 'sp-petra' });
  expect(reviewCrmProposal(request(updateJansClient), petra, []).visible).toBe(false);
  expect(reviewCrmProposal(request(updateJansClient, 'history'), petra, []).visible).toBe(false);
  expect(reviewCrmProposal(request({ _tag: 'CreateClient', name: 'Nový' }), petra, []).visible).toBe(true);
});

it('only the owning salesperson or a manager may carry out a client change', () => {
  expect(
    reviewCrmProposal(request(updateJansClient), salesperson({ salespersonId: 'sp-jan' }), [clientOfJan]),
  ).toMatchObject({
    visible: true,
  });
  expect(
    reviewCrmProposal(request(updateJansClient), salesperson({ salespersonId: 'sp-jan' }), [clientOfJan]).blockedReason,
  ).toBeUndefined();
  expect(
    reviewCrmProposal(request(updateJansClient), salesperson({ readAll: true, salespersonId: 'sp-petra' }), [
      clientOfJan,
    ]),
  ).toMatchObject({
    blockedReason: 'Tohoto klienta nemůžete upravovat, změnu schválí jeho obchodník nebo vedoucí.',
    visible: true,
  });
  expect(
    reviewCrmProposal(request(updateJansClient), salesperson({ writeAll: true }), [clientOfJan]).blockedReason,
  ).toBeUndefined();
  expect(
    reviewCrmProposal(request({ _tag: 'AssignClient', clientId: 'c-jan' }), salesperson({ writeAll: true }), [
      clientOfJan,
    ]).blockedReason,
  ).toBe('Přidělit klienta jinému obchodníkovi může jen správce nebo vedoucí.');
});

it('a client edit shows Czech labels with the live value before and is undone to it', () => {
  const item = reviewCrmProposal(request(updateJansClient), salesperson({ salespersonId: 'sp-jan' }), [clientOfJan]);
  expect(item.diff).toEqual([
    { after: '+420 541 100 299', before: '+420 541 100 200', field: 'phone', label: 'Telefon' },
    { after: 'Pekárna', before: 'Maloobchod', field: 'segment', label: 'Segment' },
  ]);
  expect(item.revert).toEqual({
    commands: [{ _tag: 'UpdateClient', id: 'c-jan', patch: { phone: '+420 541 100 200', segment: 'retail' } }],
    kind: 'commands',
  });
  expect(item.targetName).toBe('Pekárna Jan');
  expect(item.revertUnavailableReason).toBeUndefined();
  expect(
    reviewCrmProposal(request({ _tag: 'RecordVisit', clientId: 'c-jan' }), salesperson({ writeAll: true }), [
      clientOfJan,
    ]).revertUnavailableReason,
  ).toBe('Tuto změnu nelze automaticky vrátit.');
});

it('a client edit with a field that had no value is not undoable', () => {
  const command = { _tag: 'UpdateClient', id: 'c-jan', patch: { website: 'https://jan.cz' } };
  expect(reviewCrmProposal(request(command), salesperson({ writeAll: true }), [clientOfJan]).revert).toMatchObject({
    kind: 'none',
  });
});

it('undo checks that the client still holds the approved values', () => {
  const jan = salesperson({ salespersonId: 'sp-jan' });
  const edited = { ...clientOfJan, phone: '+420 541 100 299', segment: 'bakery' };
  expect(reviewCrmProposal(request(updateJansClient, 'undo'), jan, [edited])).toEqual({
    key: 'k',
    stillInPlace: true,
    visible: true,
  });
  expect(reviewCrmProposal(request(updateJansClient, 'undo'), jan, [clientOfJan]).stillInPlace).toBe(false);
  expect(reviewCrmProposal(request(updateJansClient, 'undo'), jan, []).visible).toBe(false);
});

it('only readers of every client see all CRM agent activity', () => {
  expect(seesAllClients(salesperson({}))).toBe(false);
  expect(seesAllClients(salesperson({ readAll: true }))).toBe(true);
  expect(seesAllClients(salesperson({ writeAll: true }))).toBe(true);
});

it('records the exact visible client in single-record read evidence', () => {
  expect(clientReadEvidence(1, clientOfJan)).toEqual({
    resultCount: 1,
    targetResource: { resourceId: 'c-jan', resourceType: 'demo.crm.client' },
  });
});

it('does not invent a target for a list, hidden client, empty read or review batch', () => {
  expect(clientReadEvidence(1)).toEqual({ resultCount: 1 });
  expect(clientReadEvidence(0)).toEqual({ resultCount: 0 });
  expect(clientReadEvidence(0, clientOfJan)).toEqual({ resultCount: 0 });
  expect(clientReadEvidence(2, clientOfJan)).toEqual({ resultCount: 2 });
});
