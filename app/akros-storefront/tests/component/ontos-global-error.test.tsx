import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import GlobalError from "@/app/global-error";

it("keeps noindex and Czech retry guidance even when the root catalog layout fails", () => {
  const html = renderToStaticMarkup(<GlobalError reset={() => undefined} />);
  expect(html).toContain('name="robots" content="noindex, nofollow, noarchive"');
  expect(html).toContain("Katalog je dočasně nedostupný");
  expect(html).toContain("Zkusit znovu");
  expect(html).toContain("Ceny ani sklad nenahrazujeme ukázkovými daty.");
});
