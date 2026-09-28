import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "www.akros.cz",
        pathname: "/data/**",
      },
    ],
  },
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: "/nerezovy-spojovaci-material",
        destination: "/kategorie/nerezovy-spojovaci-material",
      },
      { source: "/srouby", destination: "/kategorie/srouby" },
      { source: "/matice", destination: "/kategorie/matice" },
      { source: "/podlozky", destination: "/kategorie/podlozky" },
      { source: "/zavitove-tyce", destination: "/kategorie/zavitove-tyce" },
      { source: "/kotevni-technika", destination: "/kategorie/kotevni-technika" },
      { source: "/retezy-a-lana", destination: "/kategorie/nerezova-lana" },
      { source: "/sady-a-sortimenty", destination: "/kategorie/sady-a-sortimenty" },
      { source: "/naradi-a-prislusenstvi", destination: "/kategorie/naradi-a-prislusenstvi" },
      {
        source: "/srouby-se-sestihrannou-hlavou-din-933-a2",
        destination: "/produkt/srouby-se-sestihrannou-hlavou-din-933-a2",
      },
      {
        source: "/produkt/vrut-univerzalni-se-zapustnou-hlavou",
        destination: "/produkt/vruty-se-zapustnou-hlavou-s-krizovou-drazkou-din-7997-a2",
      },
      {
        source: "/matice-sestihranna-m8-din-934-a2",
        destination: "/produkt/matice-sestihranna-m8-din-934-a2",
      },
    ];
  },
};

export default nextConfig;
