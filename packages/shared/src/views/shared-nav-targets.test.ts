/**
 * Unit tests for the shared navigation target table: pins the matcher-id →
 * client-view vocabulary (`SHARED_NAV_TARGETS`), the localized-label locales
 * (`SHARED_NAV_UI_LOCALES`), and the documents vocabulary derivation. Pure
 * data assertions against the real module, no mocks, deterministic.
 */
import { describe, expect, it } from "vitest";
import {
  DOCUMENTS_NAV_VOCABULARY,
  SHARED_NAV_TARGETS,
  SHARED_NAV_UI_LOCALES,
} from "./shared-nav-targets";

const EXPECTED_MATCHER_IDS = [
  "settings",
  "vault",
  "wallet",
  "calendar",
  "inbox",
  "finances",
  "focus",
  "goals",
  "health",
  "todos",
  "notes",
  "documents",
  "memories",
  "relationships",
  "background",
  "transcripts",
  "character",
  "automations",
  "cloud-apps",
  "chat",
  "task-coordinator",
] as const;

describe("SHARED_NAV_UI_LOCALES", () => {
  it("exposes exactly the eight supported UI locales in order", () => {
    expect([...SHARED_NAV_UI_LOCALES]).toEqual([
      "en",
      "es",
      "pt",
      "ja",
      "ko",
      "vi",
      "zh-CN",
      "tl",
    ]);
  });

  it("has no duplicate or empty locale codes", () => {
    expect(new Set(SHARED_NAV_UI_LOCALES).size).toBe(
      SHARED_NAV_UI_LOCALES.length,
    );
    for (const locale of SHARED_NAV_UI_LOCALES) {
      expect(locale.length).toBeGreaterThan(0);
    }
  });
});

describe("DOCUMENTS_NAV_VOCABULARY", () => {
  it("targets the documents view with the English label", () => {
    expect(DOCUMENTS_NAV_VOCABULARY.viewId).toBe("documents");
    expect(DOCUMENTS_NAV_VOCABULARY.label).toBe("Knowledge");
  });

  it("provides a non-empty localized label for every supported locale", () => {
    for (const locale of SHARED_NAV_UI_LOCALES) {
      const label = DOCUMENTS_NAV_VOCABULARY.localizedLabels[locale];
      expect(label, `missing label for locale ${locale}`).toBeTruthy();
    }
    expect(Object.keys(DOCUMENTS_NAV_VOCABULARY.localizedLabels)).toHaveLength(
      SHARED_NAV_UI_LOCALES.length,
    );
  });

  it("keeps the English localized label equal to the shared label", () => {
    expect(DOCUMENTS_NAV_VOCABULARY.localizedLabels.en).toBe(
      DOCUMENTS_NAV_VOCABULARY.label,
    );
  });

  it("lists lowercase semantic aliases including both knowledge phrases", () => {
    expect([...DOCUMENTS_NAV_VOCABULARY.aliases]).toEqual([
      "knowledge base",
      "knowledge hub",
    ]);
  });
});

describe("SHARED_NAV_TARGETS", () => {
  it("contains exactly the documented matcher ids and nothing else", () => {
    expect(Object.keys(SHARED_NAV_TARGETS).sort()).toEqual(
      [...EXPECTED_MATCHER_IDS].sort(),
    );
  });

  it("gives every entry a non-empty viewId and human label", () => {
    for (const [matcherId, target] of Object.entries(SHARED_NAV_TARGETS)) {
      expect(target.viewId, matcherId).toBeTruthy();
      expect(target.label, matcherId).toBeTruthy();
    }
  });

  it("carries only viewId, optional viewPath, and label fields", () => {
    for (const [matcherId, target] of Object.entries(SHARED_NAV_TARGETS)) {
      for (const key of Object.keys(target)) {
        expect(
          ["viewId", "viewPath", "label"],
          `${matcherId}.${key}`,
        ).toContain(key);
      }
    }
  });

  it("marks only host-owned cloud-apps with a canonical path", () => {
    const withViewPath = Object.entries(SHARED_NAV_TARGETS)
      .filter(([, target]) => target.viewPath !== undefined)
      .map(([matcherId]) => matcherId);
    expect(withViewPath).toEqual(["cloud-apps"]);
    expect(SHARED_NAV_TARGETS["cloud-apps"].viewPath).toBe("/cloud-apps");
  });

  it("translates the wallet matcher onto the inventory tab", () => {
    const wallet = SHARED_NAV_TARGETS.wallet;
    expect(wallet.viewId).not.toBe("wallet");
    expect(wallet.viewId).toBe("inventory");
    expect(wallet.label).toBe("Wallet");
  });

  it("labels the chat target as Home while keeping the chat view id", () => {
    expect(SHARED_NAV_TARGETS.chat).toEqual({ viewId: "chat", label: "Home" });
  });

  it("derives the documents target from the documents vocabulary", () => {
    expect(SHARED_NAV_TARGETS.documents).toEqual({
      viewId: DOCUMENTS_NAV_VOCABULARY.viewId,
      label: DOCUMENTS_NAV_VOCABULARY.label,
    });
  });

  it("omits matchers that have no shared-tier client surface", () => {
    expect("camera" in SHARED_NAV_TARGETS).toBe(false);
    expect("help" in SHARED_NAV_TARGETS).toBe(false);
  });

  it("resolves identity-matched surfaces to their own view id", () => {
    for (const matcherId of EXPECTED_MATCHER_IDS) {
      if (
        matcherId === "wallet" ||
        matcherId === "chat" ||
        matcherId === "documents"
      ) {
        continue;
      }
      expect(SHARED_NAV_TARGETS[matcherId].viewId).toBe(matcherId);
    }
  });
});
