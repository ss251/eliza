// @vitest-environment jsdom
/**
 * Exercises content-pack application against the real module and a real jsdom
 * document: the bundled-index vs custom-VRM branches of applyContentPack,
 * background/world/personality setter effects with exact call ordering, and
 * applyColorScheme's CSS-variable mapping, url() sanitization, custom-property
 * naming, cleanup, and full-theme precedence.
 */

import type {
  ContentPackColorScheme,
  ContentPackPersonality,
  ResolvedContentPack,
  ThemeDefinition,
} from "@elizaos/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { ContentPackApplyDeps } from "./apply-pack";
import { applyColorScheme, applyContentPack } from "./apply-pack";

type SetterCall = [keyof ContentPackApplyDeps, string | number];

function makeDeps(): { calls: SetterCall[]; deps: ContentPackApplyDeps } {
  const calls: SetterCall[] = [];
  const deps: ContentPackApplyDeps = {
    setCustomVrmUrl: (url) => calls.push(["setCustomVrmUrl", url]),
    setCustomVrmPreviewUrl: (url) =>
      calls.push(["setCustomVrmPreviewUrl", url]),
    setCustomBackgroundUrl: (url) =>
      calls.push(["setCustomBackgroundUrl", url]),
    setCustomWorldUrl: (url) => calls.push(["setCustomWorldUrl", url]),
    setSelectedVrmIndex: (index) => calls.push(["setSelectedVrmIndex", index]),
    setFirstRunName: (name) => calls.push(["setFirstRunName", name]),
    setFirstRunStyle: (style) => calls.push(["setFirstRunStyle", style]),
    setCustomCatchphrase: (phrase) =>
      calls.push(["setCustomCatchphrase", phrase]),
    setCustomVoicePresetId: (id) => calls.push(["setCustomVoicePresetId", id]),
  };
  return { calls, deps };
}

interface PackFields {
  manifestId?: string;
  theme?: ThemeDefinition;
  vrmUrl?: string;
  avatarIndex?: number;
  vrmPreviewUrl?: string;
  backgroundUrl?: string;
  worldUrl?: string;
  personality?: ContentPackPersonality;
}

function makePack(fields: PackFields = {}): ResolvedContentPack {
  const manifest = {
    id: fields.manifestId ?? "test-pack",
    name: "Test Pack",
    version: "1.0.0",
    assets: fields.theme ? { theme: fields.theme } : {},
  };
  const pack: ResolvedContentPack = {
    manifest,
    source: { kind: "bundled", id: manifest.id },
  };
  if (fields.vrmUrl !== undefined) pack.vrmUrl = fields.vrmUrl;
  if (fields.avatarIndex !== undefined) pack.avatarIndex = fields.avatarIndex;
  if (fields.vrmPreviewUrl !== undefined) {
    pack.vrmPreviewUrl = fields.vrmPreviewUrl;
  }
  if (fields.backgroundUrl !== undefined) {
    pack.backgroundUrl = fields.backgroundUrl;
  }
  if (fields.worldUrl !== undefined) pack.worldUrl = fields.worldUrl;
  if (fields.personality !== undefined) pack.personality = fields.personality;
  return pack;
}

afterEach(() => {
  const root = document.documentElement;
  root.removeAttribute("data-theme");
  root.style.cssText = "";
});

describe("applyContentPack", () => {
  it("applies a bundled avatar pack in setter order and clears custom VRM urls", () => {
    const { calls, deps } = makeDeps();

    applyContentPack(
      makePack({
        avatarIndex: 3,
        backgroundUrl: "https://assets.example/bg.jpg",
        worldUrl: "https://assets.example/world.splat",
        personality: {
          name: "Nova",
          catchphrase: "To the stars",
          voicePresetId: "alice",
        },
      }),
      deps,
    );

    expect(calls).toEqual([
      ["setSelectedVrmIndex", 3],
      ["setCustomVrmUrl", ""],
      ["setCustomVrmPreviewUrl", ""],
      ["setCustomBackgroundUrl", "https://assets.example/bg.jpg"],
      ["setCustomWorldUrl", "https://assets.example/world.splat"],
      ["setFirstRunName", "Nova"],
      ["setCustomCatchphrase", "To the stars"],
      ["setCustomVoicePresetId", "alice"],
      ["setFirstRunStyle", "test-pack"],
    ]);
  });

  it("applies a custom VRM url, resets the selection to 0, and falls the preview back to empty", () => {
    const { calls, deps } = makeDeps();

    applyContentPack(
      makePack({ vrmUrl: "https://assets.example/custom.vrm" }),
      deps,
    );

    expect(calls).toEqual([
      ["setCustomVrmUrl", "https://assets.example/custom.vrm"],
      ["setCustomVrmPreviewUrl", ""],
      ["setSelectedVrmIndex", 0],
      ["setCustomWorldUrl", ""],
    ]);
  });

  it("keeps an explicit preview url for a custom VRM", () => {
    const { calls, deps } = makeDeps();

    applyContentPack(
      makePack({
        vrmUrl: "https://assets.example/custom.vrm",
        vrmPreviewUrl: "https://assets.example/custom.png",
      }),
      deps,
    );

    expect(calls).toContainEqual([
      "setCustomVrmPreviewUrl",
      "https://assets.example/custom.png",
    ]);
  });

  it("treats avatar index 0 as a non-bundled selection", () => {
    const { calls, deps } = makeDeps();

    applyContentPack(
      makePack({ avatarIndex: 0, vrmUrl: "https://assets.example/a.vrm" }),
      deps,
    );

    expect(calls).toEqual([
      ["setCustomVrmUrl", "https://assets.example/a.vrm"],
      ["setCustomVrmPreviewUrl", ""],
      ["setSelectedVrmIndex", 0],
      ["setCustomWorldUrl", ""],
    ]);
  });

  it("leaves VRM state untouched when neither a bundled index nor a custom url is present", () => {
    const { calls, deps } = makeDeps();

    applyContentPack(makePack(), deps);

    expect(calls).not.toContainEqual([
      "setSelectedVrmIndex",
      expect.anything(),
    ]);
    expect(calls).not.toContainEqual(["setCustomVrmUrl", expect.anything()]);
    expect(calls).not.toContainEqual([
      "setCustomVrmPreviewUrl",
      expect.anything(),
    ]);
    expect(calls).toEqual([["setCustomWorldUrl", ""]]);
  });

  it("skips the background setter when no background url is provided", () => {
    const { calls, deps } = makeDeps();

    applyContentPack(makePack(), deps);

    expect(calls).not.toContainEqual([
      "setCustomBackgroundUrl",
      expect.anything(),
    ]);
  });

  it("always writes the companion world url, empty when the pack has none", () => {
    const { calls, deps } = makeDeps();
    applyContentPack(makePack(), deps);
    expect(calls).toEqual([["setCustomWorldUrl", ""]]);

    const withWorld = makeDeps();
    applyContentPack(
      makePack({ worldUrl: "https://assets.example/w.splat" }),
      withWorld.deps,
    );
    expect(withWorld.calls).toEqual([
      ["setCustomWorldUrl", "https://assets.example/w.splat"],
    ]);
  });

  it("applies only the personality fields the pack provides", () => {
    const { calls, deps } = makeDeps();

    applyContentPack(makePack({ personality: { name: "Solo" } }), deps);

    expect(calls).toContainEqual(["setFirstRunName", "Solo"]);
    expect(calls).not.toContainEqual([
      "setCustomCatchphrase",
      expect.anything(),
    ]);
    expect(calls).not.toContainEqual([
      "setCustomVoicePresetId",
      expect.anything(),
    ]);
  });

  it("gates the first-run style on a truthy manifest id for bundled avatars", () => {
    const { calls, deps } = makeDeps();

    applyContentPack(makePack({ avatarIndex: 2, manifestId: "" }), deps);

    expect(calls).not.toContainEqual(["setFirstRunStyle", expect.anything()]);
    expect(calls).toContainEqual(["setSelectedVrmIndex", 2]);
  });
});

describe("applyColorScheme", () => {
  it("maps narrow scheme colors onto pack CSS variables and removes them on cleanup", () => {
    const scheme: ContentPackColorScheme = {
      accent: "#ff5500",
      bg: "#101010",
      card: "#181818",
      border: "#2a2a2a",
      text: "#f5f5f5",
      textMuted: "#a0a0a0",
    };

    const cleanup = applyColorScheme(scheme);
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--pack-accent")).toBe("#ff5500");
    expect(style.getPropertyValue("--pack-bg")).toBe("#101010");
    expect(style.getPropertyValue("--pack-card")).toBe("#181818");
    expect(style.getPropertyValue("--pack-border")).toBe("#2a2a2a");
    expect(style.getPropertyValue("--pack-text")).toBe("#f5f5f5");
    expect(style.getPropertyValue("--pack-text-muted")).toBe("#a0a0a0");

    cleanup();
    expect(style.getPropertyValue("--pack-accent")).toBe("");
    expect(style.getPropertyValue("--pack-bg")).toBe("");
    expect(style.getPropertyValue("--pack-card")).toBe("");
    expect(style.getPropertyValue("--pack-border")).toBe("");
    expect(style.getPropertyValue("--pack-text")).toBe("");
    expect(style.getPropertyValue("--pack-text-muted")).toBe("");
  });

  it("sets only the color fields the scheme provides", () => {
    const cleanup = applyColorScheme({ accent: "#00aa88" });
    const style = document.documentElement.style;

    expect(style.getPropertyValue("--pack-accent")).toBe("#00aa88");
    expect(style.getPropertyValue("--pack-bg")).toBe("");

    cleanup();
    expect(style.getPropertyValue("--pack-accent")).toBe("");
  });

  it("prefixes bare custom property names and keeps already-prefixed ones", () => {
    const cleanup = applyColorScheme({
      customProperties: { radius: "8px", "--brand-glow": "1px" },
    });
    const style = document.documentElement.style;

    expect(style.getPropertyValue("--radius")).toBe("8px");
    expect(style.getPropertyValue("--brand-glow")).toBe("1px");

    cleanup();
    expect(style.getPropertyValue("--radius")).toBe("");
    expect(style.getPropertyValue("--brand-glow")).toBe("");
  });

  it("rejects custom property values containing url() while keeping the rest", () => {
    const cleanup = applyColorScheme({
      accent: "#ff0000",
      customProperties: {
        "bg-image": "url(https://tracker.example/x.png)",
        glow: "uRl (https://tracker.example/y.png)",
      },
    });
    const style = document.documentElement.style;

    expect(style.getPropertyValue("--bg-image")).toBe("");
    expect(style.getPropertyValue("--glow")).toBe("");
    expect(style.getPropertyValue("--pack-accent")).toBe("#ff0000");

    cleanup();
  });

  it("returns a callable no-op cleanup when no scheme is given", () => {
    const cleanup = applyColorScheme(undefined);

    expect(() => cleanup()).not.toThrow();
    expect(
      document.documentElement.style.getPropertyValue("--pack-accent"),
    ).toBe("");
  });

  it("applies the full theme instead of the narrow scheme", () => {
    const theme: ThemeDefinition = {
      id: "neon-dusk",
      name: "Neon Dusk",
      light: { accent: "#101010" },
      dark: { accent: "#202020" },
    };
    const style = document.documentElement.style;

    const cleanup = applyColorScheme(
      { accent: "#ff0000" },
      makePack({ theme }),
    );

    expect(style.getPropertyValue("--accent")).toBe("#202020");
    expect(style.getPropertyValue("--pack-accent")).toBe("");

    cleanup();
    expect(style.getPropertyValue("--accent")).toBe("");
  });

  it("selects the light palette from the document data-theme attribute", () => {
    document.documentElement.setAttribute("data-theme", "light");
    const theme: ThemeDefinition = {
      id: "neon-dusk",
      name: "Neon Dusk",
      light: { accent: "#101010" },
      dark: { accent: "#202020" },
    };
    const style = document.documentElement.style;

    const cleanup = applyColorScheme(undefined, makePack({ theme }));

    expect(style.getPropertyValue("--accent")).toBe("#101010");

    cleanup();
    expect(style.getPropertyValue("--accent")).toBe("");
  });
});
