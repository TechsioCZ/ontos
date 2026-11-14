import type { MetadataRoute } from "next";

// Both prototype and connected storefront are nonproduction presentations.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
