/**
 * Boot-time TEXT_EMBEDDING dimension-probe semantics (#10702 / #8769), driven
 * against a real AgentRuntime + InMemoryDatabaseAdapter with canned/broken
 * embedding handlers registered via registerModel (no live model):
 *
 * 1. The probe fails over across eligible registered TEXT_EMBEDDING providers
 *    in priority order — any probe error advances, first success wins, sizes
 *    the vector column, and pins that provider for later embedding calls.
 *    EMBEDDING_PROVIDER=local is a strict ownership boundary: only the local
 *    router/on-device handlers are eligible and cloud is never probed.
 * 2. When every probe fails, a typed EmbeddingDimensionProbeError carries each
 *    provider's failure, and the runtime enters a coherent degraded mode:
 *    memory writes skip vector generation (warn once) instead of emitting
 *    vectors the SQL adapter would silently drop on dimension mismatch
 *    (plugins/plugin-sql/src/base.ts insert/update guards).
 * 3. A later successful re-probe (the deferred boot re-probe) clears the flag
 *    and embedding writes resume at the newly probed dimension.
 * 4. A canonical embedding-provider setting selects that provider even when a
 *    different handler has higher plugin priority.
 * 5. runtime.initialize() survives a total probe failure — boot stays alive in
 *    the degraded mode instead of crashing (#10702's original symptom).
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import type { ElizaError } from "../../errors";
import {
	AgentRuntime,
	EmbeddingDimensionProbeError,
	NoModelProviderConfiguredError,
} from "../../runtime";
import { type Character, type Memory, ModelType, type UUID } from "../../types";

const ROOM_ID = "00000000-0000-0000-0000-000000000001" as UUID;

function makeRuntime(
	options: {
		embeddingProvider?: string;
		ELIZA_EMBEDDING_PROVIDER?: string;
	} = {},
): AgentRuntime {
	return new AgentRuntime({
		character: {
			name: "EmbeddingProbeAgent",
			bio: "test",
			settings: options?.embeddingProvider
				? { EMBEDDING_PROVIDER: options.embeddingProvider }
				: {},
		} as Character,
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
		settings: options.ELIZA_EMBEDDING_PROVIDER
			? { ELIZA_EMBEDDING_PROVIDER: options.ELIZA_EMBEDDING_PROVIDER }
			: {},
	});
}

function makeMemory(text: string): Memory {
	return {
		entityId: "00000000-0000-0000-0000-000000000002" as UUID,
		roomId: ROOM_ID,
		content: { text },
	};
}

describe("AgentRuntime.ensureEmbeddingDimension provider failover", () => {
	it("pins the canonically routed embedding provider instead of plugin priority", async () => {
		const runtime = makeRuntime({ ELIZA_EMBEDDING_PROVIDER: "direct" });
		const cloudHandler = vi.fn(async () => new Array(1536).fill(0));
		const directHandler = vi.fn(async () => new Array(384).fill(0));

		runtime.registerModel(ModelType.TEXT_EMBEDDING, cloudHandler, "cloud", 100);
		runtime.registerModel(ModelType.TEXT_EMBEDDING, directHandler, "direct", 0);
		const ensureDim = vi.spyOn(runtime.adapter, "ensureEmbeddingDimension");

		await expect(runtime.ensureEmbeddingDimension()).resolves.toBeUndefined();
		expect(cloudHandler).not.toHaveBeenCalled();
		expect(directHandler).toHaveBeenCalledTimes(1);
		expect(ensureDim).toHaveBeenCalledWith(384);
	});

	it("regenerates empty vectors while preserving non-empty idempotency", async () => {
		const runtime = makeRuntime();
		const embedHandler = vi.fn(async () => [0.25, 0.5]);
		runtime.registerModel(ModelType.TEXT_EMBEDDING, embedHandler, "direct", 0);

		const empty = makeMemory("empty vector");
		empty.embedding = [];
		await expect(runtime.addEmbeddingToMemory(empty)).resolves.toBe(empty);
		expect(empty.embedding).toEqual([0.25, 0.5]);

		const existing = makeMemory("existing vector");
		existing.embedding = [9];
		await expect(runtime.addEmbeddingToMemory(existing)).resolves.toBe(
			existing,
		);
		expect(existing.embedding).toEqual([9]);
		expect(embedHandler).toHaveBeenCalledTimes(1);
	});

	it("rejects an empty provider result before a caller can persist the memory", async () => {
		const runtime = makeRuntime();
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING,
			async () => [],
			"direct",
			0,
		);
		const memory = {
			...makeMemory("provider returned no vector"),
			id: "00000000-0000-0000-0000-000000000003" as UUID,
		};
		const createMemory = vi.spyOn(runtime, "createMemory");

		const embedThenPersist = async (): Promise<void> => {
			await runtime.addEmbeddingToMemory(memory);
			await runtime.createMemory(memory, "documents");
		};

		await expect(embedThenPersist()).rejects.toMatchObject<Partial<ElizaError>>(
			{
				code: "EMBEDDING_MODEL_OUTPUT_INVALID",
				severity: "fatal",
				context: {
					memoryId: memory.id,
					outputKind: "empty-array",
				},
			},
		);
		expect(createMemory).not.toHaveBeenCalled();
		await expect(runtime.getMemoryById(memory.id)).resolves.toBeNull();
	});

	it("queues empty vectors while skipping non-empty vectors", async () => {
		const runtime = makeRuntime();
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING,
			async () => [0.25],
			"direct",
			0,
		);
		const emitEvent = vi.spyOn(runtime, "emitEvent");

		const empty = makeMemory("queue empty vector");
		empty.embedding = [];
		await runtime.queueEmbeddingGeneration(empty);
		expect(emitEvent).toHaveBeenCalledTimes(1);

		const existing = makeMemory("queue existing vector");
		existing.embedding = [9];
		await runtime.queueEmbeddingGeneration(existing);
		expect(emitEvent).toHaveBeenCalledTimes(1);
	});

	it("fails over past a broken provider on a non-rate-limit probe error and pins the working provider", async () => {
		const runtime = makeRuntime();
		const brokenHandler = vi.fn(async () => {
			throw new Error("Not Implemented");
		});
		const healthyHandler = vi.fn(async () => new Array(768).fill(0));

		runtime.registerModel(
			ModelType.TEXT_EMBEDDING,
			brokenHandler,
			"ollama",
			100,
		);
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING,
			healthyHandler,
			"elizacloud",
			10,
		);
		const ensureDim = vi.spyOn(runtime.adapter, "ensureEmbeddingDimension");

		await expect(runtime.ensureEmbeddingDimension()).resolves.toBeUndefined();

		expect(brokenHandler).toHaveBeenCalledTimes(1);
		expect(healthyHandler).toHaveBeenCalledTimes(1);
		expect(ensureDim).toHaveBeenCalledWith(768);
		expect(runtime.isEmbeddingGenerationDisabled()).toBe(false);

		// The column was sized from elizacloud's output, so later embedding
		// calls are pinned to it — the higher-priority broken provider must NOT
		// be retried (its vectors could have a different width and would be
		// silently dropped by the SQL adapter's dimension guard).
		const memory = await runtime.addEmbeddingToMemory(makeMemory("hello"));
		expect(memory.embedding).toHaveLength(768);
		expect(brokenHandler).toHaveBeenCalledTimes(1);
		expect(healthyHandler).toHaveBeenCalledTimes(2);
	});

	it("never probes a remote provider when EMBEDDING_PROVIDER=local", async () => {
		const runtime = makeRuntime({ embeddingProvider: "local" });
		const localRouter = vi.fn(async () => {
			throw new Error("local GGUF is still staging");
		});
		const cloudHandler = vi.fn(async () => new Array(1536).fill(0));

		runtime.registerModel(
			ModelType.TEXT_EMBEDDING,
			cloudHandler,
			"elizacloud",
			100,
		);
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING,
			localRouter,
			"eliza-router",
			Number.MAX_SAFE_INTEGER,
		);

		const error: unknown = await runtime
			.ensureEmbeddingDimension()
			.catch((err: unknown) => err);

		expect(error).toBeInstanceOf(EmbeddingDimensionProbeError);
		expect((error as EmbeddingDimensionProbeError).attempts).toEqual([
			{
				provider: "eliza-router",
				modelKey: ModelType.TEXT_EMBEDDING,
				error: "local GGUF is still staging",
			},
		]);
		expect(localRouter).toHaveBeenCalledTimes(1);
		expect(cloudHandler).not.toHaveBeenCalled();
		expect(runtime.isEmbeddingGenerationDisabled()).toBe(true);
	});

	it("fails closed when local ownership is configured without an on-device handler", async () => {
		const runtime = makeRuntime({ embeddingProvider: "local" });
		const cloudHandler = vi.fn(async () => new Array(1536).fill(0));
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING,
			cloudHandler,
			"elizacloud",
			100,
		);

		const error: unknown = await runtime
			.ensureEmbeddingDimension()
			.catch((err: unknown) => err);

		expect(error).toBeInstanceOf(EmbeddingDimensionProbeError);
		expect((error as EmbeddingDimensionProbeError).attempts[0]).toMatchObject({
			provider: "local",
			error: expect.stringContaining("no on-device embedding handler"),
		});
		expect(cloudHandler).not.toHaveBeenCalled();
		expect(runtime.isEmbeddingGenerationDisabled()).toBe(true);
	});

	it("treats an invalid probe embedding as a failed attempt and advances", async () => {
		const runtime = makeRuntime();
		const emptyHandler = vi.fn(async () => []);
		const healthyHandler = vi.fn(async () => new Array(384).fill(0));

		runtime.registerModel(ModelType.TEXT_EMBEDDING, emptyHandler, "empty", 50);
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING,
			healthyHandler,
			"healthy",
			10,
		);
		const ensureDim = vi.spyOn(runtime.adapter, "ensureEmbeddingDimension");

		await expect(runtime.ensureEmbeddingDimension()).resolves.toBeUndefined();
		expect(ensureDim).toHaveBeenCalledWith(384);
		expect(runtime.isEmbeddingGenerationDisabled()).toBe(false);
	});

	it("throws a typed error carrying every provider's failure when all probes fail, and gates memory writes with a single warning", async () => {
		const runtime = makeRuntime();
		const ollamaHandler = vi.fn(async () => {
			throw new Error("Not Implemented");
		});
		const cloudHandler = vi.fn(async () => {
			throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
		});

		runtime.registerModel(
			ModelType.TEXT_EMBEDDING,
			ollamaHandler,
			"ollama",
			100,
		);
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING,
			cloudHandler,
			"elizacloud",
			10,
		);
		const ensureDim = vi.spyOn(runtime.adapter, "ensureEmbeddingDimension");

		const error: unknown = await runtime
			.ensureEmbeddingDimension()
			.catch((err: unknown) => err);
		expect(error).toBeInstanceOf(EmbeddingDimensionProbeError);
		const probeError = error as EmbeddingDimensionProbeError;
		expect(probeError.attempts).toEqual([
			{
				provider: "ollama",
				modelKey: ModelType.TEXT_EMBEDDING,
				error: "Not Implemented",
			},
			{
				provider: "elizacloud",
				modelKey: ModelType.TEXT_EMBEDDING,
				error: "connect ECONNREFUSED 127.0.0.1:11434",
			},
		]);
		expect(probeError.message).toContain("ollama: Not Implemented");
		expect(probeError.message).toContain(
			"elizacloud: connect ECONNREFUSED 127.0.0.1:11434",
		);

		// Coherent degraded mode: no dimension was pinned, and the write path
		// skips embedding generation instead of calling a broken provider (or
		// writing vectors a default-sized column would silently drop).
		expect(ensureDim).not.toHaveBeenCalled();
		expect(runtime.isEmbeddingGenerationDisabled()).toBe(true);

		const warn = vi.spyOn(runtime.logger, "warn");
		const first = await runtime.addEmbeddingToMemory(makeMemory("hello"));
		const second = await runtime.addEmbeddingToMemory(makeMemory("world"));
		expect(first.embedding).toBeUndefined();
		expect(second.embedding).toBeUndefined();
		expect(ollamaHandler).toHaveBeenCalledTimes(1); // probe only, no per-write calls
		expect(cloudHandler).toHaveBeenCalledTimes(1);

		// queueEmbeddingGeneration must also skip: no embedding event is emitted.
		const emitEvent = vi.spyOn(runtime, "emitEvent");
		await runtime.queueEmbeddingGeneration(makeMemory("queued"));
		expect(emitEvent).not.toHaveBeenCalled();

		// Once-latch: exactly one skip warning across all three writes.
		const skipWarnings = warn.mock.calls.filter(([, message]) =>
			String(message).includes("Embedding generation is disabled"),
		);
		expect(skipWarnings).toHaveLength(1);
	});

	it("re-enables embedding writes at the correct dimension after a successful re-probe (recovery)", async () => {
		const runtime = makeRuntime();
		let recovered = false;
		const flakyHandler = vi.fn(async () => {
			if (!recovered) {
				throw new Error("Not Implemented");
			}
			return new Array(1536).fill(0);
		});

		runtime.registerModel(
			ModelType.TEXT_EMBEDDING,
			flakyHandler,
			"elizacloud",
			100,
		);
		const ensureDim = vi.spyOn(runtime.adapter, "ensureEmbeddingDimension");

		// Boot-time probe: provider down → degraded mode, writes skip vectors.
		await expect(runtime.ensureEmbeddingDimension()).rejects.toBeInstanceOf(
			EmbeddingDimensionProbeError,
		);
		expect(runtime.isEmbeddingGenerationDisabled()).toBe(true);
		const degraded = await runtime.addEmbeddingToMemory(makeMemory("early"));
		expect(degraded.embedding).toBeUndefined();

		// Provider recovers; the deferred re-probe (packages/agent runDeferredBoot)
		// calls ensureEmbeddingDimension again.
		recovered = true;
		await expect(runtime.ensureEmbeddingDimension()).resolves.toBeUndefined();

		expect(runtime.isEmbeddingGenerationDisabled()).toBe(false);
		expect(ensureDim).toHaveBeenCalledWith(1536);

		// No silent drop after recovery: the write resumes and its vector width
		// matches the dimension the adapter column was just configured with, so
		// the plugin-sql dimension guard cannot drop it.
		const restored = await runtime.addEmbeddingToMemory(makeMemory("late"));
		expect(restored.embedding).toHaveLength(1536);
		expect(ensureDim).toHaveBeenLastCalledWith(1536);
	});

	it("keeps the benign skip when every handler reports no backing provider configured", async () => {
		const runtime = makeRuntime();
		const proxyHandler = vi.fn(async () => {
			throw new NoModelProviderConfiguredError();
		});
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING,
			proxyHandler,
			"elizacloud",
			100,
		);
		const ensureDim = vi.spyOn(runtime.adapter, "ensureEmbeddingDimension");

		// "No backing provider at all" means nothing will ever emit vectors, so
		// a default-width column cannot cause a mismatch — not a degradation.
		await expect(runtime.ensureEmbeddingDimension()).resolves.toBeUndefined();
		expect(ensureDim).not.toHaveBeenCalled();
		expect(runtime.isEmbeddingGenerationDisabled()).toBe(false);
	});

	it("pins TEXT_EMBEDDING_BATCH to the probe provider so a higher-priority batch cannot emit a different width", async () => {
		const runtime = makeRuntime();
		const localEmbed = vi.fn(async () => new Array(384).fill(0));
		const localBatch = vi.fn(
			async (_runtime: AgentRuntime, params: { texts: string[] }) =>
				params.texts.map(() => new Array(384).fill(0)),
		);
		const cloudBatch = vi.fn(
			async (_runtime: AgentRuntime, params: { texts: string[] }) =>
				params.texts.map(() => new Array(1536).fill(1)),
		);
		runtime.registerModel(ModelType.TEXT_EMBEDDING, localEmbed, "local", 100);
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING_BATCH,
			localBatch,
			"local",
			0,
		);
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING_BATCH,
			cloudBatch,
			"cloud",
			100,
		);

		await runtime.ensureEmbeddingDimension();
		const vectors = await runtime.useModel(ModelType.TEXT_EMBEDDING_BATCH, {
			texts: ["hello"],
		});

		expect(cloudBatch).not.toHaveBeenCalled();
		expect(localBatch).toHaveBeenCalledTimes(1);
		expect(vectors[0]).toHaveLength(384);
	});

	it("rejects a single embedding whose width changes after the dimension probe", async () => {
		const runtime = makeRuntime();
		let calls = 0;
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING,
			async () => new Array(calls++ === 0 ? 384 : 1536).fill(0),
			"local",
			100,
		);

		await runtime.ensureEmbeddingDimension();

		await expect(
			runtime.useModel(ModelType.TEXT_EMBEDDING, "hello"),
		).rejects.toMatchObject<Partial<ElizaError>>({
			code: "EMBEDDING_DIMENSION_MISMATCH",
			severity: "fatal",
			context: {
				modelType: ModelType.TEXT_EMBEDDING,
				provider: "local",
				expectedDimension: 384,
				actualDimension: 1536,
			},
		});
	});

	it("rejects a pinned batch when any vector has the wrong width", async () => {
		const runtime = makeRuntime();
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING,
			async () => new Array(384).fill(0),
			"local",
			100,
		);
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING_BATCH,
			async () => [new Array(384).fill(0), new Array(1536).fill(0)],
			"local",
			100,
		);

		await runtime.ensureEmbeddingDimension();

		await expect(
			runtime.useModel(ModelType.TEXT_EMBEDDING_BATCH, {
				texts: ["first", "second"],
			}),
		).rejects.toMatchObject<Partial<ElizaError>>({
			code: "EMBEDDING_DIMENSION_MISMATCH",
			severity: "fatal",
			context: {
				modelType: ModelType.TEXT_EMBEDDING_BATCH,
				provider: "local",
				expectedDimension: 384,
				actualDimension: 1536,
				vectorIndex: 1,
			},
		});
	});

	it("rejects a batch whose vector count does not match its input count", async () => {
		const runtime = makeRuntime();
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING,
			async () => new Array(384).fill(0),
			"local",
			100,
		);
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING_BATCH,
			async () => [new Array(384).fill(0)],
			"local",
			100,
		);

		await runtime.ensureEmbeddingDimension();

		await expect(
			runtime.useModel(ModelType.TEXT_EMBEDDING_BATCH, {
				texts: ["first", "second"],
			}),
		).rejects.toMatchObject<Partial<ElizaError>>({
			code: "EMBEDDING_MODEL_OUTPUT_INVALID",
			severity: "fatal",
			context: {
				modelType: ModelType.TEXT_EMBEDDING_BATCH,
				provider: "local",
				expectedCount: 2,
				actualCount: 1,
			},
		});
	});

	it("rejects non-finite embedding elements before callers can persist them", async () => {
		const runtime = makeRuntime();
		let calls = 0;
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING,
			async () => {
				const vector = new Array(384).fill(0);
				if (calls++ > 0) vector[7] = Number.NaN;
				return vector;
			},
			"local",
			100,
		);

		await runtime.ensureEmbeddingDimension();

		await expect(
			runtime.useModel(ModelType.TEXT_EMBEDDING, "hello"),
		).rejects.toMatchObject<Partial<ElizaError>>({
			code: "EMBEDDING_MODEL_OUTPUT_INVALID",
			severity: "fatal",
			context: {
				modelType: ModelType.TEXT_EMBEDDING,
				provider: "local",
				valueIndex: 7,
			},
		});
	});

	it("rejects a wrong-width result even when the caller explicitly selects another provider", async () => {
		const runtime = makeRuntime();
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING,
			async () => new Array(384).fill(0),
			"local",
			100,
		);
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING_BATCH,
			async () => [new Array(1536).fill(0)],
			"cloud",
			100,
		);

		await runtime.ensureEmbeddingDimension();

		await expect(
			runtime.useModel(
				ModelType.TEXT_EMBEDDING_BATCH,
				{ texts: ["hello"] },
				"cloud",
			),
		).rejects.toMatchObject<Partial<ElizaError>>({
			code: "EMBEDDING_DIMENSION_MISMATCH",
			severity: "fatal",
			context: {
				modelType: ModelType.TEXT_EMBEDDING_BATCH,
				provider: "cloud",
				expectedDimension: 384,
				actualDimension: 1536,
				vectorIndex: 0,
			},
		});
	});

	it("keeps ordinary calls on the old width until a call-scoped re-probe commits the new dimension", async () => {
		const runtime = makeRuntime();
		let dimension = 384;
		let holdProbe = false;
		let releaseProbe: (() => void) | undefined;
		let announceProbeStarted: (() => void) | undefined;
		const probeGate = new Promise<void>((resolve) => {
			releaseProbe = resolve;
		});
		const probeStarted = new Promise<void>((resolve) => {
			announceProbeStarted = resolve;
		});
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING,
			async (_modelRuntime, input) => {
				if (input === null && holdProbe) {
					announceProbeStarted?.();
					await probeGate;
				}
				return new Array(dimension).fill(0);
			},
			"local",
			100,
		);
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING_BATCH,
			async (_modelRuntime, params: { texts: string[] }) =>
				params.texts.map(() => new Array(dimension).fill(0)),
			"local",
			100,
		);
		const ensureDim = vi.spyOn(runtime.adapter, "ensureEmbeddingDimension");

		await runtime.ensureEmbeddingDimension();
		expect(ensureDim).toHaveBeenLastCalledWith(384);

		dimension = 1536;
		holdProbe = true;
		const migration = runtime.ensureEmbeddingDimension();
		await probeStarted;

		let ordinarySettled = false;
		const ordinary = runtime
			.useModel(ModelType.TEXT_EMBEDDING, "during migration")
			.then(
				(value) => ({ status: "fulfilled" as const, value }),
				(error: unknown) => ({ status: "rejected" as const, error }),
			)
			.finally(() => {
				ordinarySettled = true;
			});
		await Promise.resolve();
		await Promise.resolve();
		const settledBeforeMigrationCommitted = ordinarySettled;
		expect(ensureDim).toHaveBeenCalledTimes(1);

		releaseProbe?.();
		await expect(migration).resolves.toBeUndefined();
		expect(ensureDim).toHaveBeenLastCalledWith(1536);
		const ordinaryOutcome = await ordinary;
		expect(settledBeforeMigrationCommitted).toBe(false);
		expect(ordinaryOutcome.status).toBe("fulfilled");
		if (ordinaryOutcome.status === "fulfilled") {
			expect(ordinaryOutcome.value).toHaveLength(1536);
		}

		await expect(
			runtime.useModel(ModelType.TEXT_EMBEDDING, "after migration"),
		).resolves.toHaveLength(1536);
		const batch = await runtime.useModel(ModelType.TEXT_EMBEDDING_BATCH, {
			texts: ["after", "migration"],
		});
		expect(batch).toHaveLength(2);
		expect(batch[0]).toHaveLength(1536);
		expect(batch[1]).toHaveLength(1536);
	});

	it("rejects an old-width memory atomically if persistence races a dimension migration", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const runtime = new AgentRuntime({
			character: {
				name: "EmbeddingMigrationAgent",
				bio: "test",
			} as Character,
			adapter,
			logLevel: "fatal",
		});
		let dimension = 384;
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING,
			async () => new Array(dimension).fill(0),
			"local",
			100,
		);
		await runtime.ensureEmbeddingDimension();

		const oldWidthMemory = {
			...makeMemory("generated before migration"),
			id: "00000000-0000-0000-0000-000000000004" as UUID,
		};
		await runtime.addEmbeddingToMemory(oldWidthMemory);
		expect(oldWidthMemory.embedding).toHaveLength(384);

		let announceAdapterSwitched: (() => void) | undefined;
		let releaseAdapter: (() => void) | undefined;
		const adapterSwitched = new Promise<void>((resolve) => {
			announceAdapterSwitched = resolve;
		});
		const adapterGate = new Promise<void>((resolve) => {
			releaseAdapter = resolve;
		});
		const originalEnsure = adapter.ensureEmbeddingDimension.bind(adapter);
		vi.spyOn(adapter, "ensureEmbeddingDimension").mockImplementation(
			async (nextDimension) => {
				await originalEnsure(nextDimension);
				if (nextDimension === 1536) {
					announceAdapterSwitched?.();
					await adapterGate;
				}
			},
		);

		dimension = 1536;
		const migration = runtime.ensureEmbeddingDimension();
		await adapterSwitched;

		const persistenceOutcome = await runtime
			.createMemory(oldWidthMemory, "documents")
			.then(
				() => ({ status: "fulfilled" as const }),
				(error: unknown) => ({ status: "rejected" as const, error }),
			);
		releaseAdapter?.();
		await expect(migration).resolves.toBeUndefined();

		expect(persistenceOutcome.status).toBe("rejected");
		if (persistenceOutcome.status === "rejected") {
			expect(persistenceOutcome.error).toMatchObject<Partial<ElizaError>>({
				code: "EMBEDDING_DIMENSION_MISMATCH",
				severity: "fatal",
				context: {
					expectedDimension: 1536,
					actualDimension: 384,
					memoryId: oldWidthMemory.id,
				},
			});
		}
		await expect(runtime.getMemoryById(oldWidthMemory.id)).resolves.toBeNull();
	});

	it("does not commit a new runtime pin when the adapter rejects the probed dimension", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const runtime = new AgentRuntime({
			character: {
				name: "EmbeddingUnsupportedAgent",
				bio: "test",
			} as Character,
			adapter,
			logLevel: "fatal",
		});
		let dimension = 384;
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING,
			async () => new Array(dimension).fill(0),
			"local",
			100,
		);
		await runtime.ensureEmbeddingDimension();

		const originalEnsure = adapter.ensureEmbeddingDimension.bind(adapter);
		vi.spyOn(adapter, "ensureEmbeddingDimension").mockImplementation(
			async (nextDimension) => {
				if (nextDimension === 123) {
					throw Object.assign(new Error("unsupported embedding dimension"), {
						code: "EMBEDDING_DIMENSION_UNSUPPORTED",
					});
				}
				return originalEnsure(nextDimension);
			},
		);

		dimension = 123;
		await expect(runtime.ensureEmbeddingDimension()).rejects.toMatchObject({
			code: "EMBEDDING_DIMENSION_UNSUPPORTED",
		});
		expect(runtime.isEmbeddingGenerationDisabled()).toBe(false);
		await expect(
			runtime.useModel(ModelType.TEXT_EMBEDDING, "after rejected migration"),
		).rejects.toMatchObject<Partial<ElizaError>>({
			code: "EMBEDDING_DIMENSION_MISMATCH",
			context: { expectedDimension: 384, actualDimension: 123 },
		});
	});

	it("revalidates embedding width after post-model hooks", async () => {
		const runtime = makeRuntime();
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING,
			async () => new Array(384).fill(0),
			"local",
			100,
		);
		runtime.registerPipelineHook({
			id: "wrong-width-embedding-output",
			phase: "post_model",
			handler: (_hookRuntime, context) => {
				if (
					context.phase === "post_model" &&
					context.requestedModelType === ModelType.TEXT_EMBEDDING &&
					context.params !== null
				) {
					context.result.current = new Array(1536).fill(0);
				}
			},
		});

		await runtime.ensureEmbeddingDimension();

		await expect(
			runtime.useModel(ModelType.TEXT_EMBEDDING, "hello"),
		).rejects.toMatchObject<Partial<ElizaError>>({
			code: "EMBEDDING_DIMENSION_MISMATCH",
			severity: "fatal",
			context: {
				modelType: ModelType.TEXT_EMBEDDING,
				provider: "local",
				expectedDimension: 384,
				actualDimension: 1536,
			},
		});
	});
});

describe("AgentRuntime.initialize with a broken TEXT_EMBEDDING provider (#10702)", () => {
	it("treats the pre-plugin local handler gap as expected startup sequencing", async () => {
		const runtime = makeRuntime({ embeddingProvider: "local" });
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING,
			async () => new Array(1536).fill(0),
			"elizacloud",
			100,
		);
		const reportError = vi.spyOn(runtime, "reportError");
		const errorLog = vi.spyOn(runtime.logger, "error");

		await expect(runtime.initialize()).resolves.toBeUndefined();

		expect(runtime.isEmbeddingGenerationDisabled()).toBe(true);
		expect(reportError).not.toHaveBeenCalled();
		expect(errorLog).not.toHaveBeenCalled();
	});

	it("boots in degraded mode when the only provider fails the probe, instead of crashing", async () => {
		const runtime = makeRuntime();
		const ollamaHandler = vi.fn(async () => {
			throw new Error("Not Implemented");
		});
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING,
			ollamaHandler,
			"ollama",
			100,
		);

		// #10702's original symptom: this rejected and killed agent boot.
		await expect(runtime.initialize()).resolves.toBeUndefined();

		// The degraded mode is explicit, not silent: embedding generation is
		// flagged off and memory writes persist without vectors instead of the
		// SQL adapter silently dropping mismatched ones.
		expect(runtime.isEmbeddingGenerationDisabled()).toBe(true);
		const memory = await runtime.addEmbeddingToMemory(makeMemory("post-boot"));
		expect(memory.embedding).toBeUndefined();
	});
});
