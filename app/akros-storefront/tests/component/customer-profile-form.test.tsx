import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AccountProfilePage } from "@/features/account/account-profile-page";
import { CartProvider } from "@/features/cart/cart-provider";

const router = vi.hoisted(() => ({
  refresh: vi.fn<() => void>(),
  replace: vi.fn<(url: string) => void>(),
  push: vi.fn<(url: string) => void>(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/muj-ucet",
  useSearchParams: () => new URLSearchParams(),
}));

const account = {
  id: "customer-1",
  partyId: "party-1",
  tenantId: "tenant-1",
  email: "customer@example.test",
  name: "Jan Novák",
};
const profile = {
  displayName: account.name,
  contactEmail: account.email,
  phone: "+420777123456",
  version: "a".repeat(64),
};
const notice = {
  language: "cs",
  noticeVersionId: "11111111-1111-4111-8111-111111111111",
  wording: "Aktuální informace o dobrovolném odběru novinek.",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("saves a national phone with its prefix and preserves profile revision without subscribing to the newsletter", async () => {
  const request = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async (url, init) => {
      if (url === "/api/ontos/account/profile" && init?.method === "POST") {
        return Response.json({
          outcome: "PROFILE_SAVED",
          profile: { ...JSON.parse(String(init.body)), version: "b".repeat(64) },
        });
      }
      if (url === "/api/ontos/account/consent") {
        return Response.json({ consent: { decision: "ABSENT", revision: 0, notice } });
      }
      return Response.json({ account });
    },
  );
  vi.stubGlobal("fetch", request);
  const user = userEvent.setup();
  const view = render(
    <CartProvider storage={null}>
      <AccountProfilePage account={account} profile={profile} />
    </CartProvider>,
  );
  const phone = screen.getByRole("textbox", { name: "Telefonní kontakt" });
  await user.clear(phone);
  await user.type(phone, "777234567");
  await user.click(screen.getByRole("button", { name: "Uložit změny" }));
  await screen.findByText("Údaje byly uloženy v OntOS a znovu načteny.");
  const saves = request.mock.calls.filter(
    ([url, init]) => url === "/api/ontos/account/profile" && init?.method === "POST",
  );
  expect(saves).toHaveLength(1);
  expect(JSON.parse(String(saves[0][1]?.body))).toEqual({ ...profile, phone: "+420777234567" });
  expect(
    request.mock.calls.filter(
      ([url, init]) => url === "/api/ontos/account/consent" && init?.method === "POST",
    ),
  ).toHaveLength(0);
  expect(router.refresh).toHaveBeenCalledOnce();
  view.rerender(
    <CartProvider storage={null}>
      <AccountProfilePage
        account={account}
        profile={{ ...profile, phone: "+420777234567", version: "b".repeat(64) }}
      />
    </CartProvider>,
  );
  expect(document.querySelector<HTMLInputElement>('input[name="phone"]')?.value).toBe(
    "+420777234567",
  );
});

it("keeps newsletter grant and withdrawal independent of profile saving and uses the owner's notice and revision", async () => {
  let consent = { decision: "ABSENT", revision: 0, notice };
  const request = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async (url, init) => {
      if (url !== "/api/ontos/account/consent") return Response.json({ account });
      if (init?.method === "POST") {
        const input = JSON.parse(String(init.body));
        consent = { ...consent, decision: input.decision, revision: consent.revision + 1 };
      }
      return Response.json({ consent });
    },
  );
  vi.stubGlobal("fetch", request);
  const user = userEvent.setup();
  render(
    <CartProvider storage={null}>
      <AccountProfilePage account={account} profile={profile} />
    </CartProvider>,
  );
  const checkbox = await screen.findByRole("checkbox", {
    name: "Souhlasím se zasíláním newsletteru e-mailem",
  });
  expect(screen.getByText(notice.wording)).toBeTruthy();
  await user.click(checkbox);
  await screen.findByText("Volba byla uložena v OntOS.");
  await waitFor(() => expect((checkbox as HTMLInputElement).disabled).toBe(false));
  await user.click(checkbox);
  await waitFor(() => expect(consent.decision).toBe("WITHDRAWN"));
  const writes = request.mock.calls.filter(([, init]) => init?.method === "POST");
  expect(writes).toHaveLength(2);
  expect(writes.every(([url]) => url === "/api/ontos/account/consent")).toBe(true);
  expect(JSON.parse(String(writes[0][1]?.body))).toMatchObject({
    decision: "GRANTED",
    expectedRevision: 0,
    noticeVersionId: notice.noticeVersionId,
    noticeAcknowledged: true,
  });
  expect(JSON.parse(String(writes[1][1]?.body))).toMatchObject({
    decision: "WITHDRAWN",
    expectedRevision: 1,
    noticeVersionId: notice.noticeVersionId,
    noticeAcknowledged: false,
  });
});
