/**
 * Pins the first-run provider catalog, subscription selection mapping,
 * connection normalization, and legacy runtime-config migration contracts.
 *
 * The harness is deterministic and pure: it drives the real module with
 * plain config objects and asserts observable outputs, with no mocks and
 * no network or filesystem involvement.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import {
	CHARACTER_LANGUAGES,
	type CharacterLanguage,
	DIRECT_ACCOUNT_PROVIDER_BY_FIRST_RUN_PROVIDER,
	deriveFirstRunCredentialPersistencePlan,
	FIRST_RUN_CLOUD_PROVIDER_OPTIONS,
	FIRST_RUN_PROVIDER_CATALOG,
	getDirectAccountProviderForFirstRunProvider,
	getFirstRunProviderFamily,
	getFirstRunProviderOption,
	getFirstRunProviderSignalEnvKeys,
	getProviderOptions,
	getStoredFirstRunProviderId,
	getStoredSubscriptionProvider,
	getStoredSubscriptionProviderForRequest,
	getSubscriptionProviderFamily,
	hasExplicitCanonicalRuntimeConfig,
	inferCompatibilityFirstRunConnection,
	inferFirstRunConnectionFromConfig,
	isCloudInferenceSelectedInConfig,
	isCloudManagedConnection,
	isFirstRunConnectionComplete,
	isLocalProviderConnection,
	isRemoteProviderConnection,
	isSubscriptionProviderSelectionId,
	migrateLegacyRuntimeConfig,
	normalizeFirstRunCredentialInputs,
	normalizeFirstRunProviderId,
	normalizePersistedFirstRunConnection,
	normalizeSubscriptionProviderSelectionId,
	type ProviderOption,
	readFirstRunEnvSecret,
	readFirstRunEnvString,
	registerProviderOption,
	requiresAdditionalRuntimeProvider,
	resolveDeploymentTargetInConfig,
	resolveLinkedAccountsInConfig,
	resolveServiceRoutingInConfig,
	SUBSCRIPTION_PROVIDER_SELECTIONS,
	sortFirstRunProviders,
	stripFirstRunConnectionSecrets,
} from "./first-run-options.ts";

function makeOption(
	overrides: Partial<ProviderOption> & Pick<ProviderOption, "id">,
): ProviderOption {
	return {
		name: overrides.id,
		envKey: null,
		pluginName: `@elizaos/plugin-${overrides.id}`,
		keyPrefix: null,
		description: "",
		family: overrides.id,
		authMode: "api-key",
		group: "local",
		order: 0,
		...overrides,
	};
}

const asSelection = (value: string) =>
	value as unknown as Parameters<typeof getSubscriptionProviderFamily>[0];

describe("catalog constants", () => {
	it("keeps the supported character languages in canonical order", () => {
		expect(CHARACTER_LANGUAGES).toEqual([
			"en",
			"zh-CN",
			"ko",
			"es",
			"pt",
			"vi",
			"tl",
		]);
		expectTypeOf<CharacterLanguage>().toEqualTypeOf<
			(typeof CHARACTER_LANGUAGES)[number]
		>();
	});

	it("publishes well-formed catalog entries with unique ids", () => {
		const ids = FIRST_RUN_PROVIDER_CATALOG.map((provider) => provider.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const provider of FIRST_RUN_PROVIDER_CATALOG) {
			expect(typeof provider.id).toBe("string");
			expect(typeof provider.name).toBe("string");
			expect(typeof provider.pluginName).toBe("string");
			expect(typeof provider.order).toBe("number");
		}
		const elizacloud = FIRST_RUN_PROVIDER_CATALOG.find(
			(provider) => provider.id === "elizacloud",
		);
		expect(elizacloud?.recommended).toBe(true);
		expect(elizacloud?.order).toBe(10);
	});

	it("maps each direct-account provider to its linked-account id", () => {
		expect(DIRECT_ACCOUNT_PROVIDER_BY_FIRST_RUN_PROVIDER).toEqual({
			anthropic: "anthropic-api",
			openai: "openai-api",
			deepseek: "deepseek-api",
			zai: "zai-api",
			moonshot: "moonshot-api",
			cerebras: "cerebras-api",
		});
	});

	it("offers exactly one managed cloud provider", () => {
		expect(FIRST_RUN_CLOUD_PROVIDER_OPTIONS).toHaveLength(1);
		expect(FIRST_RUN_CLOUD_PROVIDER_OPTIONS[0].id).toBe("elizacloud");
	});
});

describe("normalizeFirstRunProviderId", () => {
	it("trims casing and whitespace for direct catalog ids", () => {
		expect(normalizeFirstRunProviderId("openai")).toBe("openai");
		expect(normalizeFirstRunProviderId(" OpenAI ")).toBe("openai");
		expect(normalizeFirstRunProviderId("ELIZACLOUD")).toBe("elizacloud");
	});

	it("resolves legacy and alternate aliases", () => {
		expect(normalizeFirstRunProviderId("google")).toBe("gemini");
		expect(normalizeFirstRunProviderId("google-genai")).toBe("gemini");
		expect(normalizeFirstRunProviderId("xai")).toBe("grok");
		expect(normalizeFirstRunProviderId("together-ai")).toBe("together");
		expect(normalizeFirstRunProviderId("z.ai")).toBe("zai");
		expect(normalizeFirstRunProviderId("kimi")).toBe("moonshot");
		expect(normalizeFirstRunProviderId("moonshotai")).toBe("moonshot");
		expect(normalizeFirstRunProviderId("llama_local")).toBe("ollama");
		expect(normalizeFirstRunProviderId("llama-local")).toBe("ollama");
		expect(normalizeFirstRunProviderId("near.ai")).toBe("nearai");
		expect(normalizeFirstRunProviderId("near-ai-cloud")).toBe("nearai");
		expect(normalizeFirstRunProviderId("cerebras-api")).toBe("cerebras");
	});

	it("normalizes subscription aliases onto their coding-plan selections", () => {
		expect(normalizeFirstRunProviderId("openai-codex")).toBe(
			"openai-subscription",
		);
		expect(normalizeFirstRunProviderId("google-subscription")).toBe(
			"gemini-subscription",
		);
		expect(normalizeFirstRunProviderId("z.ai-coding")).toBe(
			"zai-coding-subscription",
		);
		expect(normalizeFirstRunProviderId("kimi-code")).toBe(
			"kimi-coding-subscription",
		);
		expect(normalizeFirstRunProviderId("deepseek-coding")).toBe(
			"deepseek-coding-subscription",
		);
	});

	it("strips npm scopes and plugin prefixes", () => {
		expect(normalizeFirstRunProviderId("@elizaos/plugin-anthropic")).toBe(
			"anthropic",
		);
		expect(normalizeFirstRunProviderId("@elizaos/plugin-openai")).toBe(
			"openai",
		);
	});

	it("falls back to matching the backing plugin package name", () => {
		expect(normalizeFirstRunProviderId("@elizaos/plugin-zerollama")).toBe(
			"ollama",
		);
	});

	it("rejects non-strings, blanks, and unknown ids", () => {
		expect(normalizeFirstRunProviderId(42)).toBeNull();
		expect(normalizeFirstRunProviderId(null)).toBeNull();
		expect(normalizeFirstRunProviderId(undefined)).toBeNull();
		expect(normalizeFirstRunProviderId({})).toBeNull();
		expect(normalizeFirstRunProviderId("")).toBeNull();
		expect(normalizeFirstRunProviderId("   ")).toBeNull();
		expect(normalizeFirstRunProviderId("definitely-not-a-provider")).toBeNull();
	});
});

describe("provider metadata lookups", () => {
	it("returns full catalog entries by canonical or alias id", () => {
		const option = getFirstRunProviderOption("ANTHROPIC ");
		expect(option?.id).toBe("anthropic");
		expect(option?.envKey).toBe("ANTHROPIC_API_KEY");
		expect(option?.keyPrefix).toBe("sk-ant-");
		expect(getFirstRunProviderOption("google")?.id).toBe("gemini");
		expect(getFirstRunProviderOption("not-a-provider")).toBeNull();
		expect(getFirstRunProviderOption(7)).toBeNull();
	});

	it("reports families only for resolvable providers", () => {
		expect(getFirstRunProviderFamily("groq")).toBe("groq");
		expect(getFirstRunProviderFamily("ollama")).toBe("ollama");
		expect(getFirstRunProviderFamily("elizacloud")).toBe("elizacloud");
		expect(getFirstRunProviderFamily("nope")).toBeNull();
	});

	it("prefers stored subscription ids and falls back to the id itself", () => {
		expect(getStoredFirstRunProviderId("anthropic-subscription")).toBe(
			"anthropic-subscription",
		);
		expect(getStoredFirstRunProviderId("openai")).toBe("openai");
		expect(getStoredFirstRunProviderId("bogus")).toBeNull();
	});

	it("maps only cataloged direct-account providers", () => {
		expect(getDirectAccountProviderForFirstRunProvider("deepseek")).toBe(
			"deepseek-api",
		);
		expect(getDirectAccountProviderForFirstRunProvider("ollama")).toBeNull();
		expect(getDirectAccountProviderForFirstRunProvider("junk")).toBeNull();
		expect(getDirectAccountProviderForFirstRunProvider(null)).toBeNull();
	});
});

describe("sortFirstRunProviders", () => {
	it("orders recommended providers first, then ascending order values", () => {
		const input = [
			makeOption({ id: "a-late", order: 200 }),
			makeOption({ id: "b-rec", order: 500, recommended: true }),
			makeOption({ id: "c-mid", order: 100 }),
		];
		const sorted = sortFirstRunProviders(input);
		expect(sorted.map((provider) => provider.id)).toEqual([
			"b-rec",
			"c-mid",
			"a-late",
		]);
	});

	it("breaks ties deterministically without mutating the input", () => {
		const input = [
			makeOption({ id: "first", order: 10 }),
			makeOption({ id: "second", order: 10 }),
			makeOption({ id: "third", order: 5 }),
		];
		const sorted = sortFirstRunProviders(input);
		expect(sorted.map((provider) => provider.id)).toEqual([
			"third",
			"first",
			"second",
		]);
		expect(input.map((provider) => provider.id)).toEqual([
			"first",
			"second",
			"third",
		]);
	});

	it("handles empty and single-element queues", () => {
		expect(sortFirstRunProviders([])).toEqual([]);
		const single = [makeOption({ id: "only", order: 1 })];
		expect(sortFirstRunProviders(single)).toHaveLength(1);
		expect(sortFirstRunProviders(single)[0].id).toBe("only");
	});
});

describe("subscription selection helpers", () => {
	it("validates exact subscription selection ids", () => {
		for (const selection of SUBSCRIPTION_PROVIDER_SELECTIONS) {
			expect(isSubscriptionProviderSelectionId(selection.id)).toBe(true);
		}
		expect(isSubscriptionProviderSelectionId("openai")).toBe(false);
		expect(isSubscriptionProviderSelectionId("")).toBe(false);
		expect(isSubscriptionProviderSelectionId(null)).toBe(false);
		expect(isSubscriptionProviderSelectionId(5)).toBe(false);
	});

	it("normalizes selection ids through the provider-id pipeline", () => {
		expect(
			normalizeSubscriptionProviderSelectionId(" ANTHROPIC-SUBSCRIPTION "),
		).toBe("anthropic-subscription");
		expect(normalizeSubscriptionProviderSelectionId("gemini-cli")).toBe(
			"gemini-subscription",
		);
		expect(normalizeSubscriptionProviderSelectionId("openai")).toBeNull();
		expect(normalizeSubscriptionProviderSelectionId("nonsense")).toBeNull();
		expect(normalizeSubscriptionProviderSelectionId(3)).toBeNull();
	});

	it("maps selections to their stored provider identifiers", () => {
		expect(getStoredSubscriptionProvider("openai-subscription")).toBe(
			"openai-codex",
		);
		expect(getStoredSubscriptionProvider("gemini-subscription")).toBe(
			"gemini-cli",
		);
		expect(getStoredSubscriptionProvider("zai-coding-subscription")).toBe(
			"zai-coding",
		);
		expect(getStoredSubscriptionProvider("kimi-coding-subscription")).toBe(
			"kimi-coding",
		);
		expect(getStoredSubscriptionProvider("deepseek-coding-subscription")).toBe(
			"deepseek-coding",
		);
	});

	it("resolves stored providers from request ids in either form", () => {
		expect(
			getStoredSubscriptionProviderForRequest("anthropic-subscription"),
		).toBe("anthropic-subscription");
		expect(getStoredSubscriptionProviderForRequest("kimi-code")).toBe(
			"kimi-coding",
		);
		expect(getStoredSubscriptionProviderForRequest("  DEEPSEEK-CODING ")).toBe(
			"deepseek-coding",
		);
		expect(getStoredSubscriptionProviderForRequest("openai")).toBeNull();
		expect(getStoredSubscriptionProviderForRequest("garbage")).toBeNull();
		expect(getStoredSubscriptionProviderForRequest(11)).toBeNull();
	});

	it("reports families and defaults unresolvable ids to anthropic", () => {
		expect(
			getSubscriptionProviderFamily(asSelection("zai-coding-subscription")),
		).toBe("zai");
		expect(
			getSubscriptionProviderFamily(asSelection("kimi-coding-subscription")),
		).toBe("moonshot");
		expect(
			getSubscriptionProviderFamily(
				asSelection("deepseek-coding-subscription"),
			),
		).toBe("deepseek");
		expect(getSubscriptionProviderFamily(asSelection("not-a-selection"))).toBe(
			"anthropic",
		);
	});

	it("requires an extra runtime provider for every plan except openai", () => {
		expect(requiresAdditionalRuntimeProvider("openai-subscription")).toBe(
			false,
		);
		expect(requiresAdditionalRuntimeProvider("anthropic-subscription")).toBe(
			true,
		);
		expect(requiresAdditionalRuntimeProvider("kimi-code")).toBe(true);
		expect(requiresAdditionalRuntimeProvider("openai")).toBe(false);
		expect(requiresAdditionalRuntimeProvider(undefined)).toBe(false);
	});
});

describe("connection kind guards", () => {
	it("narrows each connection kind and rejects absent connections", () => {
		const cloud = {
			kind: "cloud-managed",
			cloudProvider: "elizacloud",
		} as const;
		const remote = {
			kind: "remote-provider",
			remoteApiBase: "https://remote.example",
		} as const;
		const local = { kind: "local-provider", provider: "ollama" } as const;

		expect(isCloudManagedConnection(cloud)).toBe(true);
		expect(isCloudManagedConnection(remote)).toBe(false);
		expect(isCloudManagedConnection(local)).toBe(false);

		expect(isRemoteProviderConnection(remote)).toBe(true);
		expect(isRemoteProviderConnection(cloud)).toBe(false);

		expect(isLocalProviderConnection(local)).toBe(true);
		expect(isLocalProviderConnection(remote)).toBe(false);

		expect(isCloudManagedConnection(null)).toBe(false);
		expect(isLocalProviderConnection(undefined)).toBe(false);
		expect(isRemoteProviderConnection(undefined)).toBe(false);
	});
});

describe("isFirstRunConnectionComplete", () => {
	it("treats absent connections as incomplete", () => {
		expect(isFirstRunConnectionComplete(null)).toBe(false);
		expect(isFirstRunConnectionComplete(undefined)).toBe(false);
	});

	it("accepts local provider connections outright", () => {
		expect(
			isFirstRunConnectionComplete({
				kind: "local-provider",
				provider: "ollama",
			}),
		).toBe(true);
	});

	it("requires a remote API base for remote connections", () => {
		expect(
			isFirstRunConnectionComplete({
				kind: "remote-provider",
				remoteApiBase: "https://runtime.example",
			}),
		).toBe(true);
		expect(
			isFirstRunConnectionComplete({
				kind: "remote-provider",
				remoteApiBase: "",
			}),
		).toBe(false);
	});

	it("requires selected small and large models for cloud connections", () => {
		expect(
			isFirstRunConnectionComplete({
				kind: "cloud-managed",
				cloudProvider: "elizacloud",
				smallModel: "small-model",
				largeModel: "large-model",
			}),
		).toBe(true);
		expect(
			isFirstRunConnectionComplete({
				kind: "cloud-managed",
				cloudProvider: "elizacloud",
				smallModel: "small-model",
			}),
		).toBe(false);
		expect(
			isFirstRunConnectionComplete({
				kind: "cloud-managed",
				cloudProvider: "elizacloud",
			}),
		).toBe(false);
	});
});

describe("environment readers", () => {
	it("reads vars before env inside the env container", () => {
		const config = {
			env: {
				API_KEY: "env-value",
				vars: { API_KEY: "vars-value" },
			},
		};
		expect(readFirstRunEnvString(config, "API_KEY")).toBe("vars-value");

		expect(
			readFirstRunEnvString({ env: { API_KEY: "env-value" } }, "API_KEY"),
		).toBe("env-value");
		expect(readFirstRunEnvString({}, "API_KEY")).toBeUndefined();
		expect(readFirstRunEnvString(null, "API_KEY")).toBeUndefined();
		expect(readFirstRunEnvString(undefined, "API_KEY")).toBeUndefined();

		const typedConfig = { TOP_LEVEL: "ignored" };
		expect(readFirstRunEnvString(typedConfig, "TOP_LEVEL")).toBeUndefined();
	});

	it("trims strings and treats blank or non-string values as absent", () => {
		expect(readFirstRunEnvString({ env: { K: "  padded  " } }, "K")).toBe(
			"padded",
		);
		expect(readFirstRunEnvString({ env: { K: "   " } }, "K")).toBeUndefined();
		expect(readFirstRunEnvString({ env: { K: 5 } }, "K")).toBeUndefined();
	});

	it("drops redacted secrets while returning trimmed real ones", () => {
		expect(
			readFirstRunEnvSecret({ env: { KEY: " sk-live-value " } }, "KEY"),
		).toBe("sk-live-value");
		expect(
			readFirstRunEnvSecret({ env: { KEY: "[REDACTED]" } }, "KEY"),
		).toBeUndefined();
		expect(
			readFirstRunEnvSecret({ env: { KEY: "[redacted]" } }, "KEY"),
		).toBeUndefined();
		expect(
			readFirstRunEnvSecret({ env: { KEY: "  " } }, "KEY"),
		).toBeUndefined();
		expect(readFirstRunEnvSecret({ env: { KEY: 9 } }, "KEY")).toBeUndefined();
	});

	it("reports signal env keys per provider including multi-key z.ai", () => {
		expect(getFirstRunProviderSignalEnvKeys("ollama")).toEqual([
			"OLLAMA_BASE_URL",
		]);
		expect(getFirstRunProviderSignalEnvKeys("zai")).toEqual([
			"ZAI_API_KEY",
			"Z_AI_API_KEY",
		]);
		expect(getFirstRunProviderSignalEnvKeys("anthropic")).toEqual([
			"ANTHROPIC_API_KEY",
		]);
		expect(getFirstRunProviderSignalEnvKeys("mistral")).toEqual([
			"MISTRAL_API_KEY",
		]);
		expect(getFirstRunProviderSignalEnvKeys("elizacloud")).toEqual([]);
	});
});

describe("canonical runtime config detection", () => {
	it("detects explicit canonical keys by ownership, not truthiness", () => {
		expect(hasExplicitCanonicalRuntimeConfig(null)).toBe(false);
		expect(hasExplicitCanonicalRuntimeConfig(undefined)).toBe(false);
		expect(hasExplicitCanonicalRuntimeConfig({})).toBe(false);
		expect(hasExplicitCanonicalRuntimeConfig({ other: true })).toBe(false);
		expect(
			hasExplicitCanonicalRuntimeConfig({ deploymentTarget: undefined }),
		).toBe(true);
		expect(
			hasExplicitCanonicalRuntimeConfig({
				deploymentTarget: { runtime: "local" },
			}),
		).toBe(true);
		expect(hasExplicitCanonicalRuntimeConfig({ linkedAccounts: {} })).toBe(
			true,
		);
		expect(hasExplicitCanonicalRuntimeConfig({ serviceRouting: {} })).toBe(
			true,
		);
	});
});

describe("linked account resolution", () => {
	it("links elizacloud when a cloud api key exists", () => {
		expect(resolveLinkedAccountsInConfig({})).toBeNull();
		expect(resolveLinkedAccountsInConfig({ cloud: {} })).toBeNull();
		expect(resolveLinkedAccountsInConfig({ cloud: { apiKey: "ck" } })).toEqual({
			elizacloud: { status: "linked", source: "api-key" },
		});
	});

	it("keeps explicit account status and source over the api-key default", () => {
		const config = {
			linkedAccounts: { elizacloud: { status: "unlinked" } },
			cloud: { apiKey: "ck" },
		};
		expect(resolveLinkedAccountsInConfig(config)).toEqual({
			elizacloud: { status: "unlinked" },
		});

		const oauthConfig = {
			linkedAccounts: { elizacloud: { status: "linked", source: "oauth" } },
			cloud: { apiKey: "ck" },
		};
		expect(resolveLinkedAccountsInConfig(oauthConfig)).toEqual({
			elizacloud: { status: "linked", source: "oauth" },
		});
	});
});

describe("deployment target resolution", () => {
	it("passes through valid explicit targets", () => {
		expect(
			resolveDeploymentTargetInConfig({
				deploymentTarget: {
					runtime: "remote",
					provider: "remote",
					remoteApiBase: "https://r.example",
					remoteAccessToken: "tok",
				},
			}),
		).toEqual({
			runtime: "remote",
			provider: "remote",
			remoteApiBase: "https://r.example",
			remoteAccessToken: "tok",
		});
	});

	it("defaults missing or invalid targets to local", () => {
		expect(resolveDeploymentTargetInConfig({})).toEqual({ runtime: "local" });
		expect(resolveDeploymentTargetInConfig(null)).toEqual({ runtime: "local" });
		expect(
			resolveDeploymentTargetInConfig({ deploymentTarget: { runtime: "wat" } }),
		).toEqual({ runtime: "local" });
	});
});

describe("service routing resolution", () => {
	it("preserves explicit normalized routes", () => {
		const config = {
			serviceRouting: {
				llmText: { backend: "openai", transport: "direct" },
			},
		};
		expect(resolveServiceRoutingInConfig(config)).toEqual({
			llmText: { backend: "openai", transport: "direct" },
		});
	});

	it("builds a remote route from a remote deployment target", () => {
		const config = {
			deploymentTarget: {
				runtime: "remote",
				provider: "remote",
				remoteApiBase: "https://runtime.example",
			},
			agents: { defaults: { model: { primary: "primary-model" } } },
		};
		expect(resolveServiceRoutingInConfig(config)).toEqual({
			llmText: {
				backend: "remote",
				transport: "remote",
				remoteApiBase: "https://runtime.example",
				primaryModel: "primary-model",
			},
		});
	});

	it("derives a direct route from configured provider signals", () => {
		expect(
			resolveServiceRoutingInConfig({
				env: { vars: { ANTHROPIC_API_KEY: "sk" } },
			}),
		).toEqual({ llmText: { backend: "anthropic", transport: "direct" } });

		expect(
			resolveServiceRoutingInConfig({
				env: { OPENAI_API_KEY: "sk-o" },
				agents: { defaults: { model: { primary: "gpt-x" } } },
			}),
		).toEqual({
			llmText: {
				backend: "openai",
				transport: "direct",
				primaryModel: "gpt-x",
			},
		});
	});

	it("returns null when nothing is configured", () => {
		expect(resolveServiceRoutingInConfig({})).toBeNull();
	});
});

describe("migrateLegacyRuntimeConfig", () => {
	it("leaves fresh local configs implicit and untouched", () => {
		const config: Record<string, unknown> = {};
		const result = migrateLegacyRuntimeConfig(config);
		expect(result).toBe(config);
		expect(result).toEqual({});

		const optOut = migrateLegacyRuntimeConfig({ cloud: { enabled: false } });
		expect(optOut).toEqual({ cloud: { enabled: false } });
	});

	it("promotes a legacy remote cloud block and prunes it", () => {
		const config: Record<string, unknown> = {
			cloud: {
				remoteApiBase: "https://legacy.example",
				remoteAccessToken: "tok",
				provider: "stale-provider",
			},
			connection: { kind: "local-provider", provider: "openai" },
		};
		const result = migrateLegacyRuntimeConfig(config);
		expect(result).toEqual({
			deploymentTarget: {
				runtime: "remote",
				provider: "remote",
				remoteApiBase: "https://legacy.example",
				remoteAccessToken: "tok",
			},
			serviceRouting: {
				llmText: {
					backend: "remote",
					transport: "remote",
					remoteApiBase: "https://legacy.example",
				},
			},
		});
		expect(Object.hasOwn(result, "connection")).toBe(false);
	});

	it("migrates a legacy elizacloud runtime onto a cloud-proxy route", () => {
		const result = migrateLegacyRuntimeConfig({
			cloud: { runtime: "cloud", provider: "elizacloud", agentId: "agent-1" },
			models: { small: "small-model", large: "large-model" },
		});
		expect(result.deploymentTarget).toEqual({
			runtime: "cloud",
			provider: "elizacloud",
		});
		expect(result.serviceRouting).toEqual({
			llmText: {
				backend: "elizacloud",
				transport: "cloud-proxy",
				accountId: "elizacloud",
				smallModel: "small-model",
				largeModel: "large-model",
			},
		});
	});

	it("never prunes the live cloud.enabled opt-out flag", () => {
		const result = migrateLegacyRuntimeConfig({
			cloud: { enabled: false },
			models: { large: "unused-model" },
		});
		expect(result.cloud).toEqual({ enabled: false });
		expect(result.serviceRouting).toBeUndefined();

		const optedIn = migrateLegacyRuntimeConfig({
			cloud: { enabled: true },
			models: { small: "s" },
		});
		expect(optedIn.cloud).toEqual({ enabled: true });
	});
});

describe("normalizePersistedFirstRunConnection", () => {
	it("rejects non-record payloads", () => {
		expect(normalizePersistedFirstRunConnection(null)).toBeNull();
		expect(normalizePersistedFirstRunConnection(42)).toBeNull();
		expect(normalizePersistedFirstRunConnection("cloud-managed")).toBeNull();
		expect(normalizePersistedFirstRunConnection([])).toBeNull();
		expect(normalizePersistedFirstRunConnection({ kind: "other" })).toBeNull();
	});

	it("normalizes cloud-managed connections and drops redacted keys", () => {
		const connection = normalizePersistedFirstRunConnection({
			kind: "cloud-managed",
			apiKey: "[REDACTED]",
			nanoModel: "   ",
			smallModel: " small-model ",
			largeModel: "large-model",
		});
		expect(connection?.kind).toBe("cloud-managed");
		if (isCloudManagedConnection(connection)) {
			expect(connection.apiKey).toBeUndefined();
			expect(connection.nanoModel).toBeUndefined();
			expect(connection.smallModel).toBe("small-model");
			expect(connection.largeModel).toBe("large-model");
		}
	});

	it("validates the local provider and drops invalid ones", () => {
		expect(
			normalizePersistedFirstRunConnection({
				kind: "local-provider",
				provider: "not-a-provider",
			}),
		).toBeNull();
		expect(
			normalizePersistedFirstRunConnection({
				kind: "local-provider",
				provider: "elizacloud",
			}),
		).toBeNull();

		const connection = normalizePersistedFirstRunConnection({
			kind: "local-provider",
			provider: "google",
			apiKey: "[REDACTED]",
			primaryModel: " gemini-pro ",
		});
		if (isLocalProviderConnection(connection)) {
			expect(connection.provider).toBe("gemini");
			expect(connection.apiKey).toBeUndefined();
			expect(connection.primaryModel).toBe("gemini-pro");
		}
	});

	it("requires a remote base and normalizes remote details", () => {
		expect(
			normalizePersistedFirstRunConnection({
				kind: "remote-provider",
				provider: "openai",
			}),
		).toBeNull();

		const connection = normalizePersistedFirstRunConnection({
			kind: "remote-provider",
			remoteApiBase: " https://remote.example ",
			remoteAccessToken: "[REDACTED]",
			provider: "google",
			apiKey: "sk",
			primaryModel: "m",
		});
		if (isRemoteProviderConnection(connection)) {
			expect(connection.remoteApiBase).toBe("https://remote.example");
			expect(connection.remoteAccessToken).toBeUndefined();
			expect(connection.provider).toBe("gemini");
			expect(connection.apiKey).toBe("sk");
			expect(connection.primaryModel).toBe("m");
		}

		expect(
			normalizePersistedFirstRunConnection({
				kind: "remote-provider",
				remoteApiBase: "https://remote.example",
				provider: "elizacloud",
			}),
		).toMatchObject({ provider: undefined });
	});
});

describe("credential input normalization", () => {
	it("keeps only trimmed non-redacted credentials", () => {
		expect(normalizeFirstRunCredentialInputs(null)).toBeNull();
		expect(normalizeFirstRunCredentialInputs({})).toBeNull();
		expect(normalizeFirstRunCredentialInputs({ llmApiKey: "" })).toBeNull();
		expect(
			normalizeFirstRunCredentialInputs({
				llmApiKey: "[REDACTED]",
				cloudApiKey: "   ",
			}),
		).toBeNull();
		expect(normalizeFirstRunCredentialInputs({ llmApiKey: " sk " })).toEqual({
			llmApiKey: "sk",
		});
		expect(normalizeFirstRunCredentialInputs({ cloudApiKey: "ck" })).toEqual({
			cloudApiKey: "ck",
		});
		expect(
			normalizeFirstRunCredentialInputs({ llmApiKey: "lk", cloudApiKey: "ck" }),
		).toEqual({ llmApiKey: "lk", cloudApiKey: "ck" });
	});
});

describe("deriveFirstRunCredentialPersistencePlan", () => {
	it("persists the cloud key onto a cloud-proxy route", () => {
		const plan = deriveFirstRunCredentialPersistencePlan({
			credentialInputs: { cloudApiKey: "cloud-key" },
			serviceRouting: {
				llmText: {
					backend: "elizacloud",
					transport: "cloud-proxy",
					accountId: "elizacloud",
					smallModel: "s",
				},
			},
		});
		expect(plan.cloudApiKey).toBe("cloud-key");
		expect(plan.llmSelection).toEqual({
			backend: "elizacloud",
			transport: "cloud-proxy",
			apiKey: "cloud-key",
			smallModel: "s",
		});
	});

	it("persists direct LLM keys against the routed backend", () => {
		const plan = deriveFirstRunCredentialPersistencePlan({
			credentialInputs: { llmApiKey: "llm-key", cloudApiKey: "cloud-key" },
			serviceRouting: {
				llmText: {
					backend: "anthropic",
					transport: "direct",
					primaryModel: "claude-x",
				},
			},
		});
		expect(plan.llmSelection).toEqual({
			backend: "anthropic",
			transport: "direct",
			apiKey: "llm-key",
			primaryModel: "claude-x",
		});
		expect(plan.cloudApiKey).toBe("cloud-key");
	});

	it("falls back to the deployment target base for remote routes", () => {
		const plan = deriveFirstRunCredentialPersistencePlan({
			credentialInputs: { llmApiKey: "key" },
			deploymentTarget: {
				runtime: "remote",
				provider: "remote",
				remoteApiBase: "https://fallback.example",
				remoteAccessToken: "tok",
			},
			serviceRouting: {
				llmText: { backend: "grok", transport: "remote" },
			},
		});
		expect(plan.llmSelection).toEqual({
			backend: "grok",
			transport: "remote",
			remoteApiBase: "https://fallback.example",
			remoteAccessToken: "tok",
			apiKey: "key",
		});
	});

	it("yields no LLM selection when routing or credentials are missing", () => {
		expect(deriveFirstRunCredentialPersistencePlan({})).toEqual({
			llmSelection: null,
		});
		expect(
			deriveFirstRunCredentialPersistencePlan({
				credentialInputs: {},
				serviceRouting: {
					llmText: { backend: "openai", transport: "direct" },
				},
			}),
		).toEqual({ llmSelection: null });
		expect(
			deriveFirstRunCredentialPersistencePlan({
				credentialInputs: { llmApiKey: "key" },
				serviceRouting: {
					llmText: { backend: "grok", transport: "remote" },
				},
			}),
		).toEqual({ llmSelection: null });
		expect(
			deriveFirstRunCredentialPersistencePlan({
				credentialInputs: { cloudApiKey: "ck" },
				serviceRouting: {
					llmText: { backend: "openai", transport: "direct" },
				},
			}),
		).toEqual({ llmSelection: null, cloudApiKey: "ck" });
	});
});

describe("stripFirstRunConnectionSecrets", () => {
	it("strips secrets from every connection kind while keeping routing data", () => {
		const strippedCloud = stripFirstRunConnectionSecrets({
			kind: "cloud-managed",
			cloudProvider: "elizacloud",
			apiKey: "secret",
			smallModel: "s",
			largeModel: "l",
		});
		if (isCloudManagedConnection(strippedCloud)) {
			expect(strippedCloud.apiKey).toBeUndefined();
			expect(strippedCloud.smallModel).toBe("s");
			expect(strippedCloud.largeModel).toBe("l");
		}

		const strippedLocal = stripFirstRunConnectionSecrets({
			kind: "local-provider",
			provider: "openai",
			apiKey: "secret",
			primaryModel: "gpt-x",
		});
		if (isLocalProviderConnection(strippedLocal)) {
			expect(strippedLocal.provider).toBe("openai");
			expect(strippedLocal.primaryModel).toBe("gpt-x");
			expect(strippedLocal.apiKey).toBeUndefined();
		}

		const strippedRemote = stripFirstRunConnectionSecrets({
			kind: "remote-provider",
			remoteApiBase: "https://remote.example",
			remoteAccessToken: "token",
			provider: "anthropic",
			apiKey: "secret",
			primaryModel: "claude-x",
		});
		if (isRemoteProviderConnection(strippedRemote)) {
			expect(strippedRemote.remoteApiBase).toBe("https://remote.example");
			expect(strippedRemote.remoteAccessToken).toBeUndefined();
			expect(strippedRemote.provider).toBe("anthropic");
			expect(strippedRemote.primaryModel).toBe("claude-x");
			expect(strippedRemote.apiKey).toBeUndefined();
		}
	});
});

describe("inferCompatibilityFirstRunConnection", () => {
	it("prefers a legacy remote base and enriches it from signals", () => {
		expect(
			inferCompatibilityFirstRunConnection({
				cloud: {
					remoteApiBase: "https://legacy.example",
					remoteAccessToken: "t",
				},
				env: { ANTHROPIC_API_KEY: "sk" },
				agents: { defaults: { model: { primary: "p" } } },
			}),
		).toEqual({
			kind: "remote-provider",
			remoteApiBase: "https://legacy.example",
			remoteAccessToken: "t",
			provider: "anthropic",
			apiKey: "sk",
			primaryModel: "p",
		});
	});

	it("infers a cloud-managed connection from enabled flags or model picks", () => {
		const enabled = inferCompatibilityFirstRunConnection({
			cloud: { enabled: true },
			models: { nano: "n", mega: "m" },
		});
		expect(enabled?.kind).toBe("cloud-managed");
		if (isCloudManagedConnection(enabled)) {
			expect(enabled.nanoModel).toBe("n");
			expect(enabled.megaModel).toBe("m");
		}

		const modelsOnly = inferCompatibilityFirstRunConnection({
			models: { medium: "mm" },
		});
		expect(modelsOnly?.kind).toBe("cloud-managed");
	});

	it("honors the cloud opt-out even when models are present", () => {
		expect(
			inferCompatibilityFirstRunConnection({
				cloud: { enabled: false },
				models: { large: "L" },
			}),
		).toBeNull();
	});

	it("falls back to a signaled local provider with its key", () => {
		expect(
			inferCompatibilityFirstRunConnection({
				env: { OPENAI_API_KEY: "sk-openai" },
			}),
		).toEqual({
			kind: "local-provider",
			provider: "openai",
			apiKey: "sk-openai",
			primaryModel: undefined,
		});
		expect(inferCompatibilityFirstRunConnection({})).toBeNull();
	});
});

describe("inferFirstRunConnectionFromConfig", () => {
	it("derives a cloud-managed connection from the canonical route", () => {
		const connection = inferFirstRunConnectionFromConfig({
			serviceRouting: {
				llmText: {
					backend: "elizacloud",
					transport: "cloud-proxy",
					accountId: "elizacloud",
					smallModel: "s",
					largeModel: "l",
				},
			},
		});
		expect(connection?.kind).toBe("cloud-managed");
		if (isCloudManagedConnection(connection)) {
			expect(connection.smallModel).toBe("s");
			expect(connection.largeModel).toBe("l");
		}
	});

	it("derives remote connections from the route plus env signals", () => {
		expect(
			inferFirstRunConnectionFromConfig({
				serviceRouting: {
					llmText: {
						backend: "anthropic",
						transport: "remote",
						remoteApiBase: "https://remote.example",
						primaryModel: "p",
					},
				},
				env: { ANTHROPIC_API_KEY: "sk" },
			}),
		).toEqual({
			kind: "remote-provider",
			remoteApiBase: "https://remote.example",
			provider: "anthropic",
			apiKey: "sk",
			primaryModel: "p",
		});

		expect(
			inferFirstRunConnectionFromConfig({
				serviceRouting: {
					llmText: { backend: "anthropic", transport: "remote" },
				},
			}),
		).toBeNull();
	});

	it("derives local connections with or without an env-backed key", () => {
		expect(
			inferFirstRunConnectionFromConfig({
				serviceRouting: {
					llmText: { backend: "anthropic", transport: "direct" },
				},
				env: { vars: { ANTHROPIC_API_KEY: "sk-vars" } },
			}),
		).toEqual({
			kind: "local-provider",
			provider: "anthropic",
			apiKey: "sk-vars",
		});

		expect(
			inferFirstRunConnectionFromConfig({
				serviceRouting: {
					llmText: {
						backend: "ollama",
						transport: "direct",
						primaryModel: "llama3",
					},
				},
			}),
		).toEqual({
			kind: "local-provider",
			provider: "ollama",
			primaryModel: "llama3",
		});

		expect(
			inferFirstRunConnectionFromConfig({
				serviceRouting: {
					llmText: { backend: "ollama", transport: "direct" },
				},
			}),
		).toEqual({ kind: "local-provider", provider: "ollama" });
	});

	it("falls back to a remote deployment target and otherwise yields null", () => {
		expect(
			inferFirstRunConnectionFromConfig({
				deploymentTarget: {
					runtime: "remote",
					provider: "remote",
					remoteApiBase: "https://target.example",
					remoteAccessToken: "tok",
				},
			}),
		).toEqual({
			kind: "remote-provider",
			remoteApiBase: "https://target.example",
			remoteAccessToken: "tok",
		});
		expect(inferFirstRunConnectionFromConfig({})).toBeNull();
	});
});

describe("isCloudInferenceSelectedInConfig", () => {
	it("is true only for canonical elizacloud cloud-proxy routes", () => {
		expect(
			isCloudInferenceSelectedInConfig({
				serviceRouting: {
					llmText: {
						backend: "elizacloud",
						transport: "cloud-proxy",
						accountId: "elizacloud",
					},
				},
			}),
		).toBe(true);
		expect(
			isCloudInferenceSelectedInConfig({
				serviceRouting: {
					llmText: { backend: "openai", transport: "direct" },
				},
			}),
		).toBe(false);
		expect(isCloudInferenceSelectedInConfig({})).toBe(false);
	});
});

describe("runtime provider registry", () => {
	it("includes the hardcoded catalog by default", () => {
		const options = getProviderOptions();
		const ids = options.map((option) => option.id);
		expect(ids).toContain("elizacloud");
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("registers new providers and replaces same-id registrations", () => {
		registerProviderOption(
			makeOption({ id: "lane-test-provider", order: 900 }),
		);
		expect(
			getProviderOptions().some((option) => option.id === "lane-test-provider"),
		).toBe(true);

		registerProviderOption(
			makeOption({
				id: "lane-test-provider",
				name: "Replaced Lane Provider",
				order: 901,
			}),
		);
		const matches = getProviderOptions().filter(
			(option) => option.id === "lane-test-provider",
		);
		expect(matches).toHaveLength(1);
		expect(matches[0].name).toBe("Replaced Lane Provider");
		expect(matches[0].order).toBe(901);
	});

	it("lets runtime registrations override catalog entries", () => {
		registerProviderOption(
			makeOption({
				id: "ollama",
				name: "Custom Local Runtime",
				authMode: "local",
			}),
		);
		const ollama = getProviderOptions().find(
			(option) => option.id === "ollama",
		);
		expect(ollama?.name).toBe("Custom Local Runtime");
	});
});
