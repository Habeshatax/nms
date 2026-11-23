import type { ReactNode } from "react";

import type { Metadata } from "next";

import { SITE_NAME, SITE_URL } from "@/lib/seo";

export const metadata: Metadata = {
  robots: { index: true, follow: true },
};

const branches = [
  {
    id: "galleywall-road",
    name: "Bubbly Day Nursery - Galleywall Road",
    streetAddress: "Manor Methodist Church, Galleywall Road",
    postalCode: "SE16 3PB",
    email: "bubblydnursery@gmail.com",
    telephone: "+442081098601",
  },
  {
    id: "corbetts-lane",
    name: "Bubbly Day Nursery - Corbetts Lane",
    streetAddress: "St Gertrudes Church Hall, Corbetts Lane",
    postalCode: "SE16 2BQ",
    email: "bubblyd2nursery@gmail.com",
  },
];

const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE_URL}/#organization`,
      name: SITE_NAME,
      legalName: "BUBBLY DAY NURSERY LIMITED",
      url: SITE_URL,
      logo: `${SITE_URL}/images/newlogo.png`,
      location: branches.map((branch) => ({ "@id": `${SITE_URL}/#${branch.id}` })),
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      name: SITE_NAME,
      url: SITE_URL,
      inLanguage: "en-GB",
      publisher: { "@id": `${SITE_URL}/#organization` },
    },
    ...branches.map((branch) => ({
      "@type": "ChildCare",
      "@id": `${SITE_URL}/#${branch.id}`,
      name: branch.name,
      url: `${SITE_URL}/contact`,
      image: `${SITE_URL}/images/hero1.png`,
      email: branch.email,
      telephone: branch.telephone,
      parentOrganization: { "@id": `${SITE_URL}/#organization` },
      address: {
        "@type": "PostalAddress",
        streetAddress: branch.streetAddress,
        addressLocality: "London",
        postalCode: branch.postalCode,
        addressCountry: "GB",
      },
      openingHoursSpecification: [{
        "@type": "OpeningHoursSpecification",
        dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
        opens: "07:30",
        closes: "18:00",
      }],
      description: "Day nursery in Bermondsey, London SE16. Closed on UK bank holidays and for one week over Christmas.",
    })),
  ],
};

export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, "\\u003c") }}
      />
      {children}
    </>
  );
}
