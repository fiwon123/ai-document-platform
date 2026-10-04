import { describe, expect, it } from "vitest";
import {
  LEGAL_DOCUMENTS,
  NAV_LEGAL,
  legalDocument,
  legalDocumentProps,
} from "./legal";
import { MARKETING_ROUTES } from "./marketing";

/**
 * The legal documents are one list, and this is what holds them to it.
 *
 * Before #618 each page owned its own `SECTIONS` array, so nothing tied the
 * four together: the footer listed four links, the router mounted four routes,
 * and the four page components held four independent copies of the text. Any
 * one of those could change without the others noticing. These assertions are
 * the tie.
 */

describe("legal documents", () => {
  it("publishes the four documents, in footer order", () => {
    expect(LEGAL_DOCUMENTS.map((d) => d.route)).toEqual([
      "/privacy",
      "/terms",
      "/security",
      "/gdpr",
    ]);
  });

  it("gives every document the shape LegalDocument renders", () => {
    for (const doc of LEGAL_DOCUMENTS) {
      // The lookup key and the nav target are the same string, deliberately —
      // one field, so they cannot be set inconsistently.
      expect(doc.route).toMatch(/^\/[a-z]+$/);
      expect(doc.label.length).toBeGreaterThan(0);
      expect(doc.title.length).toBeGreaterThan(0);
      expect(doc.intro.length).toBeGreaterThan(0);
      expect(Array.isArray(doc.sections)).toBe(true);
      expect(doc.sections.length).toBeGreaterThan(0);

      for (const section of doc.sections) {
        expect(section.heading.length).toBeGreaterThan(0);
        expect(section.body.length).toBeGreaterThan(0);
        for (const paragraph of section.body) {
          expect(paragraph.length).toBeGreaterThan(0);
        }
        if (section.items) {
          expect(section.items.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("has no duplicate routes, titles or section headings", () => {
    // `LegalDocument` keys sections by heading and `key`es paragraphs by their
    // first 40 characters, so a repeat inside one document is a React key
    // collision — two nodes fighting over one identity.
    for (const doc of LEGAL_DOCUMENTS) {
      const headings = doc.sections.map((s) => s.heading);
      expect(new Set(headings).size, `${doc.route} headings`).toBe(
        headings.length,
      );
      for (const section of doc.sections) {
        const paragraphs = section.body;
        const keys = paragraphs.map((p) => p.slice(0, 40));
        expect(new Set(keys).size, `${doc.route} / ${section.heading}`).toBe(
          keys.length,
        );
      }
    }

    const routes = LEGAL_DOCUMENTS.map((d) => d.route);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it("resolves each document by its own route", () => {
    for (const doc of LEGAL_DOCUMENTS) {
      expect(legalDocument(doc.route)).toBe(doc);
    }
  });

  it("refuses to answer for a route with no document", () => {
    // Throwing rather than falling back to the first document: the caller is a
    // page whose route was written by hand, so a miss means a route points at a
    // document that does not exist. Returning the first one instead would serve
    // the Privacy Policy at `/terms` — a wrong legal document under a real URL.
    expect(() => legalDocument("/nope")).toThrow(/No legal document/);
    expect(() => legalDocument("/privacy/nope")).toThrow(/No legal document/);
  });

  it("hands every page the same section eyebrow", () => {
    // Declared once, so it cannot end up spelled four ways.
    for (const doc of LEGAL_DOCUMENTS) {
      expect(legalDocumentProps(doc.route).eyebrow).toBe("Legal");
    }
  });

  it("still carries the placeholders that must be replaced before publishing", () => {
    // A refactor that quietly dropped these would make the pages look ready to
    // publish while `*.example` addresses and a stand-in entity are still in
    // them. See AGENTS.md → "Before publishing the legal pages".
    const all = LEGAL_DOCUMENTS.flatMap((d) =>
      d.sections.flatMap((s) => [...s.body, ...(s.items ?? [])]),
    ).join(" ");

    expect(all).toContain("before this policy is published");
  });
});

describe("NAV_LEGAL", () => {
  it("is derived from the documents, so it cannot drift from them", () => {
    expect(NAV_LEGAL).toEqual(
      LEGAL_DOCUMENTS.map(({ label, route }) => ({ label, to: route })),
    );
  });

  it("points only at real documents", () => {
    for (const { to } of NAV_LEGAL) {
      expect(() => legalDocument(to)).not.toThrow();
    }
  });

  it("covers every published legal route in the marketing route list", () => {
    // The routing test iterates MARKETING_ROUTES and asserts a mounted page, so
    // a document added to legal.ts without a route registered would otherwise
    // appear in the footer and 404.
    for (const { to } of NAV_LEGAL) {
      expect(MARKETING_ROUTES).toContain(to);
    }
  });
});