import { ProtectedShellRemotePage } from '../../protected-remote-page';
import { shellModuleEntrypoints } from '../../../module-entrypoints';
import ShellFrame from '../../shell-frame';

const entrypoint = shellModuleEntrypoints.ticketingTicketingPage;

export default function TicketingTicketingPageShellPage() {
  return (
    <ShellFrame>
      <section className="shell:mx-auto shell:mt-8 shell:max-w-7xl">
        <ProtectedShellRemotePage entrypoint={entrypoint} loadingLabel={"Ticketing Ticketing"} />
      </section>
    </ShellFrame>
  );
}
