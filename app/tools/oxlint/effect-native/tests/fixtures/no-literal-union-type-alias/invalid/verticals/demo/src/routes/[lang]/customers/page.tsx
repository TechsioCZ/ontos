// expect-count: 3
import type { ReactElement } from 'react';

type UnavailableReason = 'backend' | 'decode' | 'transport';

type ContactDetailUnavailableReason = 'backend' | 'decode' | 'internal' | 'transport';

// parenthesised members + a nested union still form one closed vocabulary.
type ArchiveFilter = ('active' | 'archived') | 'all';

export default function Page(): ReactElement {
  const reason: UnavailableReason = 'backend';
  const nested: ArchiveFilter = 'all';
  const detail: ContactDetailUnavailableReason = 'internal';
  return <p>{reason}{nested}{detail}</p>;
}
