/**
 * Verifies the join flow's Cloud connection resolution: the direct-cloud
 * API-base fallback chain and the Steward auth-token lookup.
 */
// @vitest-environment jsdom

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BOOT_CONFIG,
  setBootConfig,
} from "../../../config/boot-config";
import {
  resolveJoinAuthToken,
  resolveJoinCloudApiBase,
} from "./resolve-cloud-connection";

// Obviously-fake, low-entropy stand-in for the opaque Steward session JWT
// (a realistic random UUID here trips the gitleaks generic-api-key rule).
const TOKEN = "aaaaaaaa-test-test-test-tokentoken01";

afterEach(() => {
  setBootConfig(DEFAULT_BOOT_CONFIG);
  window.localStorage.clear();
});

describe("resolveJoinCloudApiBase", () => {
  it("returns the boot-configured direct-cloud origin", () => {
    setBootConfig({
      branding: {},
      cloudApiBase: "https://cloud.join.example",
    });
    expect(resolveJoinCloudApiBase()).toBe("https://cloud.join.example");
  });

  it("trims surrounding whitespace off the configured origin", () => {
    setBootConfig({
      branding: {},
      cloudApiBase: "  https://cloud.trim.example  ",
    });
    expect(resolveJoinCloudApiBase()).toBe("https://cloud.trim.example");
  });

  it("falls back to the public Eliza Cloud origin when none is configured", () => {
    setBootConfig({ branding: {} });
    expect(resolveJoinCloudApiBase()).toBe("https://api.eliza.app");
  });

  it("falls back when the configured origin is empty or whitespace-only", () => {
    setBootConfig({ branding: {}, cloudApiBase: "" });
    expect(resolveJoinCloudApiBase()).toBe("https://api.eliza.app");

    setBootConfig({ branding: {}, cloudApiBase: "   \t " });
    expect(resolveJoinCloudApiBase()).toBe("https://api.eliza.app");
  });

  it("passes the stock DEFAULT_BOOT_CONFIG web origin through unchanged", () => {
    setBootConfig(DEFAULT_BOOT_CONFIG);
    expect(resolveJoinCloudApiBase()).toBe("https://eliza.app");
  });

  it("re-reads the live boot config instead of caching at import time", () => {
    setBootConfig({ branding: {}, cloudApiBase: "https://first.example" });
    expect(resolveJoinCloudApiBase()).toBe("https://first.example");

    setBootConfig({ branding: {}, cloudApiBase: "https://second.example" });
    expect(resolveJoinCloudApiBase()).toBe("https://second.example");
  });
});

describe("resolveJoinAuthToken", () => {
  it("returns the stored Steward session token", () => {
    window.localStorage.setItem(STEWARD_TOKEN_KEY, TOKEN);
    expect(resolveJoinAuthToken()).toBe(TOKEN);
  });

  it("trims surrounding whitespace off the stored token", () => {
    window.localStorage.setItem(STEWARD_TOKEN_KEY, `  ${TOKEN}  `);
    expect(resolveJoinAuthToken()).toBe(TOKEN);
  });

  it("returns null while signed out (no stored token)", () => {
    expect(window.localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
    expect(resolveJoinAuthToken()).toBeNull();
  });

  it("treats a blank stored token as signed out", () => {
    window.localStorage.setItem(STEWARD_TOKEN_KEY, "");
    expect(resolveJoinAuthToken()).toBeNull();

    window.localStorage.setItem(STEWARD_TOKEN_KEY, "   ");
    expect(resolveJoinAuthToken()).toBeNull();
  });
});
