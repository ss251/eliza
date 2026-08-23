/**
 * Behavioral coverage for model-resolution: primary-model lookup and
 * preferred-provider / plugin-package derivation from ElizaConfig.
 * Drives the real module — empty config, a single route, transport-order
 * ties, missing-item fallbacks, and alias/slash hint comparators — with no
 * mocks of the resolvers or the first-run catalog they consult.
 */
import { describe, expect, it } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import {
  resolvePreferredProviderId,
  resolvePreferredProviderPluginName,
  resolvePrimaryModel,
} from "./model-resolution.ts";

function withPrimary(
  primary: string | undefined,
  fallbacks?: string[],
): ElizaConfig {
  return {
    agents: {
      defaults: {
        model: {
          ...(primary !== undefined ? { primary } : {}),
          ...(fallbacks ? { fallbacks } : {}),
        },
      },
    },
  };
}

function withLlmText(llmText: {
  transport?: "direct" | "remote" | "cloud-proxy";
  backend?: string;
  primaryModel?: string;
}): ElizaConfig {
  return {
    serviceRouting: {
      llmText,
    },
  };
}

describe("resolvePrimaryModel", () => {
  it("returns undefined for an empty config queue", () => {
    expect(resolvePrimaryModel({})).toBeUndefined();
    expect(resolvePrimaryModel({ agents: {} })).toBeUndefined();
    expect(resolvePrimaryModel({ agents: { defaults: {} } })).toBeUndefined();
  });

  it("returns undefined when the model object is missing or has no primary", () => {
    expect(
      resolvePrimaryModel({ agents: { defaults: { model: {} } } }),
    ).toBeUndefined();
    expect(resolvePrimaryModel(withPrimary(undefined))).toBeUndefined();
  });

  it("ignores fallbacks when primary is absent — missing-item, not overflow", () => {
    expect(
      resolvePrimaryModel(withPrimary(undefined, ["gpt-4o", "claude-3"])),
    ).toBeUndefined();
  });

  it("returns the single configured primary as-is, including empty and untrimmed values", () => {
    expect(resolvePrimaryModel(withPrimary("gpt-4o"))).toBe("gpt-4o");
    expect(resolvePrimaryModel(withPrimary(""))).toBe("");
    expect(resolvePrimaryModel(withPrimary("  claude-3-5-sonnet  "))).toBe(
      "  claude-3-5-sonnet  ",
    );
  });

  it("keeps primary when fallbacks are also present", () => {
    expect(
      resolvePrimaryModel(withPrimary("gpt-4o", ["claude-3", "gemini-2.0"])),
    ).toBe("gpt-4o");
  });
});

describe("resolvePreferredProviderId", () => {
  it("returns undefined when routing and model hints are both empty", () => {
    expect(resolvePreferredProviderId({})).toBeUndefined();
    expect(resolvePreferredProviderId({ agents: {} })).toBeUndefined();
    expect(resolvePreferredProviderId({ serviceRouting: {} })).toBeUndefined();
  });

  it("returns elizacloud for cloud-proxy transport with an elizacloud backend", () => {
    expect(
      resolvePreferredProviderId(
        withLlmText({ transport: "cloud-proxy", backend: "elizacloud" }),
      ),
    ).toBe("elizacloud");
    expect(
      resolvePreferredProviderId(
        withLlmText({
          transport: "cloud-proxy",
          backend: "ELIZACLOUD",
          primaryModel: "openai",
        }),
      ),
    ).toBe("elizacloud");
    expect(
      resolvePreferredProviderId(
        withLlmText({
          transport: "cloud-proxy",
          backend: "@elizaos/plugin-elizacloud",
        }),
      ),
    ).toBe("elizacloud");
  });

  it("does not treat cloud-proxy as elizacloud when the backend is a different provider", () => {
    const config: ElizaConfig = {
      serviceRouting: {
        llmText: { transport: "cloud-proxy", backend: "anthropic" },
      },
      agents: { defaults: { model: { primary: "openai" } } },
    };
    expect(resolvePreferredProviderId(config)).toBe("openai");
  });

  it("returns the direct backend when it is a local provider, even if a model hint disagrees", () => {
    const config: ElizaConfig = {
      serviceRouting: {
        llmText: {
          transport: "direct",
          backend: "anthropic",
          primaryModel: "openai/gpt-4o",
        },
      },
      agents: { defaults: { model: { primary: "grok" } } },
    };
    expect(resolvePreferredProviderId(config)).toBe("anthropic");
  });

  it("falls back to the direct primaryModel hint when the backend is missing or elizacloud", () => {
    expect(
      resolvePreferredProviderId(
        withLlmText({
          transport: "direct",
          backend: "elizacloud",
          primaryModel: "openai/gpt-4o",
        }),
      ),
    ).toBe("openai");
    expect(
      resolvePreferredProviderId(
        withLlmText({
          transport: "direct",
          primaryModel: "  xai/grok-4  ",
        }),
      ),
    ).toBe("grok");
  });

  it("returns the remote backend when it is a local provider", () => {
    expect(
      resolvePreferredProviderId(
        withLlmText({ transport: "remote", backend: "together" }),
      ),
    ).toBe("together");
    expect(
      resolvePreferredProviderId(
        withLlmText({ transport: "remote", backend: "google" }),
      ),
    ).toBe("gemini");
  });

  it("falls back to the remote primaryModel hint when the backend is missing or elizacloud", () => {
    expect(
      resolvePreferredProviderId(
        withLlmText({
          transport: "remote",
          backend: "elizacloud",
          primaryModel: "anthropic",
        }),
      ),
    ).toBe("anthropic");
    expect(
      resolvePreferredProviderId(
        withLlmText({
          transport: "remote",
          primaryModel: "@elizaos/plugin-xai",
        }),
      ),
    ).toBe("grok");
  });

  it("ignores a backend that has no recognized transport and uses the primary-model hint instead", () => {
    const config: ElizaConfig = {
      serviceRouting: {
        llmText: { backend: "anthropic" },
      },
      agents: { defaults: { model: { primary: "openai" } } },
    };
    expect(resolvePreferredProviderId(config)).toBe("openai");
  });

  it("uses the primary-model hint when no llmText route is present", () => {
    expect(resolvePreferredProviderId(withPrimary("openai"))).toBe("openai");
    expect(resolvePreferredProviderId(withPrimary("OpenAI"))).toBe("openai");
    expect(resolvePreferredProviderId(withPrimary("gemini/gemini-2.0"))).toBe(
      "gemini",
    );
    expect(
      resolvePreferredProviderId(withPrimary("@elizaos/plugin-anthropic")),
    ).toBe("anthropic");
  });

  it("trims a padded primary before treating it as a provider hint", () => {
    expect(resolvePrimaryModel(withPrimary("  grok  "))).toBe("  grok  ");
    expect(resolvePreferredProviderId(withPrimary("  grok  "))).toBe("grok");
  });

  it("returns undefined for unknown, empty, and whitespace-only hints", () => {
    expect(resolvePreferredProviderId(withPrimary(""))).toBeUndefined();
    expect(resolvePreferredProviderId(withPrimary("   "))).toBeUndefined();
    expect(
      resolvePreferredProviderId(withPrimary("not-a-provider")),
    ).toBeUndefined();
    expect(
      resolvePreferredProviderId(withPrimary("unknown/model-name")),
    ).toBeUndefined();
    expect(
      resolvePreferredProviderId(
        withLlmText({ transport: "direct", primaryModel: "   " }),
      ),
    ).toBeUndefined();
  });

  it("prefers the api-key catalog id when a plugin package backs both subscription and key flows", () => {
    expect(
      resolvePreferredProviderId(
        withLlmText({
          transport: "direct",
          backend: "@elizaos/plugin-anthropic",
        }),
      ),
    ).toBe("anthropic");
    expect(
      resolvePreferredProviderId(
        withLlmText({
          transport: "direct",
          backend: "@elizaos/plugin-openai",
        }),
      ),
    ).toBe("openai");
  });

  it("lets an explicit llmText route win over a derived subscriptionProvider signal", () => {
    const config: ElizaConfig = {
      serviceRouting: {
        llmText: { transport: "direct", backend: "anthropic" },
      },
      agents: { defaults: { subscriptionProvider: "openai-subscription" } },
    };
    expect(resolvePreferredProviderId(config)).toBe("anthropic");
  });

  it("synthesizes a direct openai-subscription route from a single stored subscriptionProvider", () => {
    const config: ElizaConfig = {
      agents: { defaults: { subscriptionProvider: "openai-subscription" } },
    };
    expect(resolvePreferredProviderId(config)).toBe("openai-subscription");
  });

  it("does not synthesize from subscriptionProvider when an empty canonical serviceRouting is present", () => {
    const config: ElizaConfig = {
      serviceRouting: {},
      agents: {
        defaults: {
          subscriptionProvider: "openai-subscription",
          model: { primary: "grok" },
        },
      },
    };
    expect(resolvePreferredProviderId(config)).toBe("grok");
  });

  it("does not synthesize anthropic-subscription as a local backend (requires an additional runtime provider)", () => {
    const config: ElizaConfig = {
      agents: {
        defaults: {
          subscriptionProvider: "anthropic-subscription",
          model: { primary: "openai" },
        },
      },
    };
    expect(resolvePreferredProviderId(config)).toBe("openai");
  });
});

describe("resolvePreferredProviderPluginName", () => {
  it("returns undefined when no provider can be resolved", () => {
    expect(resolvePreferredProviderPluginName({})).toBeUndefined();
    expect(
      resolvePreferredProviderPluginName(withPrimary("not-a-provider")),
    ).toBeUndefined();
  });

  it("maps a single resolved provider to its catalog plugin package", () => {
    expect(
      resolvePreferredProviderPluginName(
        withLlmText({ transport: "direct", backend: "anthropic" }),
      ),
    ).toBe("@elizaos/plugin-anthropic");
    expect(
      resolvePreferredProviderPluginName(
        withLlmText({ transport: "cloud-proxy", backend: "elizacloud" }),
      ),
    ).toBe("@elizaos/plugin-elizacloud");
    expect(resolvePreferredProviderPluginName(withPrimary("xai"))).toBe(
      "@elizaos/plugin-xai",
    );
    expect(resolvePreferredProviderPluginName(withPrimary("google"))).toBe(
      "@elizaos/plugin-google-genai",
    );
  });

  it("maps cerebras to the openai plugin package, distinct from the openai provider id", () => {
    expect(
      resolvePreferredProviderId(
        withLlmText({ transport: "direct", backend: "cerebras" }),
      ),
    ).toBe("cerebras");
    expect(
      resolvePreferredProviderPluginName(
        withLlmText({ transport: "direct", backend: "cerebras" }),
      ),
    ).toBe("@elizaos/plugin-openai");
    expect(
      resolvePreferredProviderPluginName(
        withLlmText({ transport: "direct", backend: "openai" }),
      ),
    ).toBe("@elizaos/plugin-openai");
  });
});
