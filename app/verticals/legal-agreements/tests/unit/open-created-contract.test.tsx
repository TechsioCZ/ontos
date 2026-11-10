// @rstest-environment happy-dom
// After a create form saves, the agreements page opens the new contract once the form is gone, and only once. Going
// back to the list or opening another contract afterwards (Back, Renew) must stay where the person went, not bounce
// to the created contract.
import { afterEach, describe, expect, it } from 'effect-rstest';
import { Effect } from 'effect';
import { useState } from 'react';
import { useOpenCreated } from '../../src/routes/[lang]/smlouvy/use-open-created.ts';
import { click, mount, unmountAll } from '../support/agreement-form.tsx';

const opened: string[] = [];

/** The page in miniature: the linked contract is the URL, `open` navigates to another one, the form may be open. */
const Page = () => {
  const [linked, setLinked] = useState<string>();
  const [formOpen, setFormOpen] = useState(true);
  const open = (resourceId: string) => {
    opened.push(resourceId);
    setLinked(resourceId);
  };
  const noteCreated = useOpenCreated(formOpen, linked, open);
  const saveCreate = () => {
    noteCreated('created');
    setFormOpen(false);
  };
  return (
    <>
      <output data-testid="linked">{linked ?? 'list'}</output>
      <button aria-label="Create" data-testid="create" onClick={saveCreate} type="button" />
      <button aria-label="Back" data-testid="back" onClick={() => setLinked(undefined)} type="button" />
      <button aria-label="Renew" data-testid="renew" onClick={() => open('successor')} type="button" />
    </>
  );
};

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? undefined;
const linked = () => byTestId('linked')?.textContent;

describe('opening a created contract', () => {
  afterEach(() => {
    unmountAll();
    opened.splice(0);
  });

  it.effect('opens it once the form is gone, then Back and Renew stay where the person went', () =>
    Effect.gen(function* createThenLeave() {
      yield* mount(<Page />);
      expect(linked()).toBe('list');
      yield* click(byTestId('create'));
      expect(linked()).toBe('created');
      yield* click(byTestId('back'));
      expect(linked()).toBe('list');
      yield* click(byTestId('renew'));
      expect(linked()).toBe('successor');
      expect(opened).toEqual(['created', 'successor']);
    }),
  );
});
