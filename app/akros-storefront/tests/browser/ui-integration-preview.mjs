// Isolated visual fixture, never a data source for the deployed storefront.
// Run with the workspace toolchain: pnpm --filter akros-storefront exec node tests/browser/ui-integration-preview.mjs
import { mkdir, writeFile, copyFile, symlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const root = fileURLToPath(new URL("../../", import.meta.url));
const preview = resolve(root, "test-results/ui-integration/preview");
const source = resolve(root, "src").replaceAll("\\", "/");
const support = resolve(root, "tests/support/catalog-fixture").replaceAll("\\", "/");
const write = async (path, body) => {
  const target = resolve(preview, path);
  await mkdir(resolve(target, ".."), { recursive: true });
  await writeFile(target, body);
};
await write("package.json", JSON.stringify({ private: true, type: "module" }));
try {
  await symlink(resolve(root, "src"), resolve(preview, "src"), "junction");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
await write(
  "tsconfig.json",
  JSON.stringify({
    compilerOptions: { allowJs: true, jsx: "preserve", paths: { "@/*": ["./src/*"] } },
    include: ["app/**/*.jsx", "app/**/*.js"],
    exclude: ["node_modules", ".next"],
  }),
);
await write(
  "next.config.mjs",
  `export default { agentRules: false, images: { unoptimized: true }, experimental: { externalDir: true }, outputFileTracingRoot: ${JSON.stringify(resolve(root, ".."))}, webpack(config) { config.resolve.alias["@"] = ${JSON.stringify(source)}; return config; } };`,
);
await write("postcss.config.mjs", 'export default { plugins: { "@tailwindcss/postcss": {} } };');
await mkdir(resolve(preview, "public"), { recursive: true });
await copyFile(
  resolve(root, "src/fonts/InterVariable-latin.woff2"),
  resolve(preview, "public/inter.woff2"),
);
try {
  await symlink(resolve(root, "public/akros"), resolve(preview, "public/akros"), "junction");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
await write(
  "app/fixture.jsx",
  `import { fixtureProducts, fixtureCategories, fixtureCatalog } from ${JSON.stringify(support)};
export const product = fixtureProducts.find(p => p.slug === "vruty-se-zapustnou-hlavou-s-krizovou-drazkou-din-7997-a2");
export const large = fixtureProducts.reduce((a,b) => a.detail.variants.length > b.detail.variants.length ? a : b);
export const cards = fixtureProducts.filter(p => p.detail.variants.length).slice(0,8).map(fixtureCatalog.toProductSummary);
export const snapshot = { revision: 1, catalog: { products: [], homepageFeaturedProductIds: [] }, categories: { categories: fixtureCategories } };
export const account = { id: "visual-customer", name: "Jan Novák", email: "jan@example.test", tenantId: "visual-tenant", partyId: "visual-party" };
export const profile = { displayName: account.name, contactEmail: account.email, phone: "+420777123456", version: "a".repeat(64) };
export const orders = Array.from({length: 5}, (_,i) => ({ id: "visual-order-"+i, customerAccountId: account.id, number: "#2026-0084"+i, status: "DELIVERED", createdAt: "2026-10-20T12:00:00Z", updatedAt: "2026-10-20T12:00:00Z", totalMinor: 123456, totalVatMinor: 21427, lines: [{ productId: product.id, variantId: product.detail.variants[0].id, productName: product.name, sku: product.detail.variants[0].sku, quantity: 20, unitPriceMinor: 77, vatRate: 21 }] }));`,
);
await write(
  "app/layout.jsx",
  `import ${JSON.stringify(source + "/app/globals.css")};
import Ready from "./ready";
import { CatalogProvider } from "@/ontos/catalog-provider";
import { CartProvider } from "@/features/cart/cart-provider";
import { CartNotifications } from "@/features/cart/cart-notifications";
import { snapshot } from "./fixture";
export default function Layout({children}) { return <html lang="cs" className="light" style={{"--font-akros":"IntegrationInter"}}><body><style>{'@font-face{font-family:IntegrationInter;src:url(/inter.woff2) format("woff2");font-weight:100 900;font-display:swap}'}</style><CatalogProvider snapshot={snapshot}><CartProvider>{children}<CartNotifications/><Ready/></CartProvider></CatalogProvider></body></html>; }`,
);
await write(
  "app/ready.jsx",
  '"use client"; import {useEffect} from "react"; export default function Ready(){useEffect(()=>{document.body.dataset.previewReady="true";},[]);return null;}',
);
await write(
  "app/address.jsx",
  `"use client";
import { useState } from "react";
import { AddressFields } from "@/features/checkout/address-fields";
export default function Address() { const [address,setAddress] = useState({firstName:"Jan",lastName:"Novák",street:"",city:"",postalCode:"",country:"CZ",phone:"+420777123456"}); return <AddressFields address={address} prefix="billing" onChange={setAddress} errors={{}}/>; }`,
);
await write(
  "app/render.jsx",
  `import { StorefrontShell, StorefrontWideShell } from "@/components/storefront-shell";
import { ProductPurchaseForm } from "@/features/cart/product-purchase-form";
import { ProductDetailActions } from "@/components/product-detail-actions";
import { ProductVariantDetail } from "@/components/product-variant-detail";
import { ProductGrid } from "@/components/product-grid";
import { AccountOrders } from "@/features/account/account-orders";
import { AccountProfilePage } from "@/features/account/account-profile-page";
import { AccountShell } from "@/components/account-shell";
import { FavoritesList } from "@/features/favorites/favorites-list";
import { CartContent } from "@/features/cart/cart-content";
import { purchaseProductOf, purchaseVariantOf } from "@/ontos/catalog-projection";
import Address from "./address";
import { product,large,cards,account,profile,orders } from "./fixture";
export default function Render({view = "variants"}) { const p = view === "large" ? large : product; const purchase = purchaseProductOf(p);
if(view === "profile") return <AccountProfilePage account={account} profile={profile}/>;
if(view === "orders") return <AccountShell active="orders"><AccountOrders orders={orders} total={5}/></AccountShell>;
if(view === "favorites") return <AccountShell active="favorites"><FavoritesList/></AccountShell>;
if(view === "address") return <StorefrontWideShell><div data-akros-checkout><Address/></div></StorefrontWideShell>;
if(view === "cart") return <StorefrontWideShell><div data-akros-checkout><CartContent/></div></StorefrontWideShell>;
return <StorefrontShell><h1>{p.name}</h1>{view === "cards" ? <ProductGrid products={cards}/> : <><ProductDetailActions productId={p.id} productName={p.name} productSlug={p.slug}/><ProductPurchaseForm product={purchase} variants={p.detail.variants.map(purchaseVariantOf)}/><ProductVariantDetail product={purchase} descriptionParagraphs={p.detail.descriptionParagraphs}/></>}</StorefrontShell>; }`,
);
await write(
  "app/page.jsx",
  `import Render from "./render"; export default async function Page({searchParams}) {return <Render view={(await searchParams).view}/>;}`,
);
await write(
  "app/produkt/[slug]/page.jsx",
  `import Render from "../../render"; export default function Page(){return <Render/>;}`,
);
await write(
  "app/fixture-data/route.js",
  `import { product,large,account,profile,orders } from "../fixture"; export function GET(){return Response.json({product,large,account,profile,orders});}`,
);
const child = spawn(
  process.execPath,
  [
    resolve(root, "node_modules/next/dist/bin/next"),
    "dev",
    "--webpack",
    "-p",
    process.env.AKROS_PREVIEW_PORT ?? "3097",
    "-H",
    "127.0.0.1",
  ],
  { cwd: preview, env: process.env, stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 1));
