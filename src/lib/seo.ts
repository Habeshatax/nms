import type { Metadata } from "next";

export const SITE_URL = "https://bubblydnursery.co.uk";
export const SITE_NAME = "Bubbly Day Nursery";

export const publicPages = {
  "/": {
    title: "Day Nursery in Bermondsey, SE16",
    description:
      "Childcare for babies, toddlers and preschool children at Bubbly Day Nursery in Bermondsey, London SE16. Explore our two settings and book a nursery tour.",
  },
  "/about": {
    title: "About Our Bermondsey Nursery",
    description:
      "Meet Bubbly Day Nursery in Bermondsey, SE16. Learn about our early years approach, safeguarding, nursery team and care for children from 3 months to 5 years.",
  },
  "/rooms": {
    title: "Baby, Toddler & Preschool Rooms in SE16",
    description:
      "Explore baby, toddler and preschool rooms at Bubbly Day Nursery in Bermondsey, London SE16. Discover daily routines and learning for children aged 3 months to 5.",
  },
  "/curriculum": {
    title: "Early Years Learning & EYFS Curriculum",
    description:
      "Discover how Bubbly Day Nursery supports communication, physical development, creativity and early learning through its EYFS curriculum in Bermondsey, SE16.",
  },
  "/parent-info": {
    title: "Nursery Fees & Parent Information",
    description:
      "Find nursery fees, session information, settling-in details and answers to parent questions at Bubbly Day Nursery in Bermondsey, London SE16.",
  },
  "/menu": {
    title: "Nursery Meals & Food Menu",
    description:
      "See meals and food information at Bubbly Day Nursery in Bermondsey, SE16. Explore our nursery menu and discuss your child's dietary needs with our team.",
  },
  "/gallery": {
    title: "Nursery Gallery & Everyday Activities",
    description:
      "Explore photos of nursery life, play and learning at Bubbly Day Nursery in Bermondsey, SE16. Get a feel for our settings before booking a visit.",
  },
  "/news": {
    title: "Nursery News & Events in Bermondsey",
    description:
      "Read the latest news, events and updates from Bubbly Day Nursery in Bermondsey, London SE16. Stay connected with our nursery community.",
  },
  "/careers": {
    title: "Nursery Jobs & Early Years Careers",
    description:
      "Explore nursery jobs and early years career opportunities at Bubbly Day Nursery in Bermondsey, London SE16. View current vacancies and application details.",
  },
  "/contact": {
    title: "Book a Nursery Tour in Bermondsey, SE16",
    description:
      "Visit Bubbly Day Nursery on Galleywall Road or Corbetts Lane in London SE16. Find branch contact details, ask about childcare or request a nursery tour.",
  },
  "/privacy": {
    title: "Privacy Policy",
    description:
      "Read how Bubbly Day Nursery handles personal information and protects the privacy of families, children and website visitors.",
  },
  "/terms": {
    title: "Website Terms of Service",
    description: "Read the terms for using the Bubbly Day Nursery website and nursery portal.",
  },
} as const;

export function publicPageMetadata(path: keyof typeof publicPages): Metadata {
  const { title, description } = publicPages[path];
  const fullTitle = `${title} | ${SITE_NAME}`;
  return {
    title: { absolute: fullTitle },
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      locale: "en_GB",
      siteName: SITE_NAME,
      title: fullTitle,
      description,
      url: `${SITE_URL}${path}`,
      images: [{ url: "/images/hero1.png", alt: "Bubbly Day Nursery in Bermondsey, London SE16" }],
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description,
      images: ["/images/hero1.png"],
    },
  };
}
