/**
 * Exercises the opt-in `processBatch` path on BatchQueue that lets the
 * embedding-drain embed N texts in one request. Per-item callers (no
 * `processBatch`) are unaffected; with it set, a drain calls it ONCE and sends
 * failed outcomes through the same per-item retry and exhaustion path used by
 * a batch-wide throw.
 */

import { describe, expect, test } from "vitest";
import { BatchQueue } from "./index";

describe("BatchQueue processBatch", () => {
	function makeQueue(opts: {
		process: (item: number) => Promise<void>;
		processBatch?: (
			items: number[],
		) => Promise<{ item: number; success: boolean; retryCount: number }[]>;
	}) {
		return new BatchQueue<number>({
			name: "TEST_DRAIN",
			batchSize: 10,
			drainIntervalMs: 100,
			getPriority: () => "normal",
			maxParallel: 5,
			process: opts.process,
			processBatch: opts.processBatch,
		});
	}

	test("a drain calls processBatch ONCE with the whole slice, not process per-item", async () => {
		const perItem: number[] = [];
		const batched: number[][] = [];
		const q = makeQueue({
			process: async (item) => {
				perItem.push(item);
			},
			processBatch: async (items) => {
				batched.push([...items]);
				return items.map((item) => ({ item, success: true, retryCount: 0 }));
			},
		});

		q.enqueue(1);
		q.enqueue(2);
		q.enqueue(3);
		await q.drain();

		// One batched call for all three; the per-item path never ran.
		expect(batched).toEqual([[1, 2, 3]]);
		expect(perItem).toEqual([]);
	});

	test("a batch-wide failure falls back to the per-item process path", async () => {
		const perItem: number[] = [];
		const q = makeQueue({
			process: async (item) => {
				perItem.push(item);
			},
			processBatch: async () => {
				throw new Error("batch endpoint down");
			},
		});

		q.enqueue(1);
		q.enqueue(2);
		await q.drain();

		// processBatch threw -> every item was processed individually (retry path).
		expect(perItem.sort()).toEqual([1, 2]);
	});

	test("failed batch outcomes retry per-item and report exhaustion", async () => {
		const perItem: number[] = [];
		const exhausted: number[] = [];
		const outcomesSeen: { item: number; success: boolean }[][] = [];
		const q = new BatchQueue<number>({
			name: "TEST_DRAIN",
			batchSize: 10,
			drainIntervalMs: 100,
			getPriority: () => "normal",
			maxParallel: 1,
			maxRetriesAfterFailure: 1,
			retryPolicy: { minDelayMs: 0, maxDelayMs: 0 },
			process: async (item) => {
				perItem.push(item);
				if (item === 3) {
					throw new Error("still unavailable");
				}
			},
			processBatch: async (items) =>
				items.map((item) => ({
					item,
					success: item === 1,
					error: item === 1 ? undefined : new Error("batch write failed"),
					retryCount: 0,
				})),
			onExhausted: (item) => {
				exhausted.push(item);
			},
			onDrainBatchOutcomes: (outcomes) => {
				outcomesSeen.push(outcomes);
			},
		});

		q.enqueue(1);
		q.enqueue(2);
		q.enqueue(3);
		await q.drain();

		expect(perItem).toEqual([2, 3, 3]);
		expect(exhausted).toEqual([3]);
		expect(outcomesSeen).toHaveLength(1);
		expect(
			outcomesSeen[0]?.map(({ item, success }) => ({ item, success })),
		).toEqual([
			{ item: 1, success: true },
			{ item: 2, success: true },
			{ item: 3, success: false },
		]);
	});

	test("without processBatch, behavior is unchanged (per-item only)", async () => {
		const perItem: number[] = [];
		const q = makeQueue({
			process: async (item) => {
				perItem.push(item);
			},
		});

		q.enqueue(7);
		q.enqueue(8);
		await q.drain();

		expect(perItem.sort()).toEqual([7, 8]);
	});
});
