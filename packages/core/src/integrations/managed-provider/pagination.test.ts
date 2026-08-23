/**
 * Exercises the real cursor-pagination walker used by managed-provider
 * adapters: page draining and cursor threading, item/page ceilings, and the
 * typed failures for invalid limits, empty cursors, and repeated provider
 * cursors. Fully deterministic — the page source is an in-memory script, with
 * no network, runtime, or clock involved.
 */

import { describe, expect, it } from "vitest";
import { ManagedProviderError } from "./errors.ts";
import { collectProviderPages, type ProviderPage } from "./pagination.ts";

interface ScriptedPage {
	items: number[];
	nextCursor: string | null;
}

function scriptedPageSource(pages: ScriptedPage[]): {
	fetchPage: (cursor: string | undefined) => Promise<ProviderPage<number>>;
	receivedCursors: () => (string | undefined)[];
	callCount: () => number;
} {
	const receivedCursors: (string | undefined)[] = [];
	let calls = 0;
	return {
		async fetchPage(cursor) {
			const page = pages[calls];
			calls += 1;
			receivedCursors.push(cursor);
			if (!page) {
				throw new Error(`unexpected page fetch #${calls}`);
			}
			return { items: page.items, nextCursor: page.nextCursor };
		},
		receivedCursors: () => [...receivedCursors],
		callCount: () => calls,
	};
}

describe("collectProviderPages", () => {
	it("drains every page in order and threads cursors to fetchPage", async () => {
		const source = scriptedPageSource([
			{ items: [1, 2], nextCursor: "cursor-a" },
			{ items: [3], nextCursor: "cursor-b" },
			{ items: [4, 5], nextCursor: null },
		]);

		const items = await collectProviderPages(source.fetchPage);

		expect(items).toEqual([1, 2, 3, 4, 5]);
		expect(source.receivedCursors()).toEqual([
			undefined,
			"cursor-a",
			"cursor-b",
		]);
		expect(source.callCount()).toBe(3);
	});

	it("returns a single completed page without following another cursor", async () => {
		const source = scriptedPageSource([{ items: ["only"], nextCursor: null }]);

		const items = await collectProviderPages(source.fetchPage);

		expect(items).toEqual(["only"]);
		expect(source.callCount()).toBe(1);
	});

	it("throws INVALID_INPUT without fetching when maxPages is not a positive integer", async () => {
		for (const maxPages of [0, -1, 1.5]) {
			const source = scriptedPageSource([{ items: [1], nextCursor: null }]);
			await expect(
				collectProviderPages(source.fetchPage, { maxPages }),
			).rejects.toMatchObject({
				name: "ManagedProviderError",
				code: "INVALID_INPUT",
			});
			expect(source.callCount()).toBe(0);
		}
	});

	it("throws INVALID_INPUT without fetching when maxItems is not a positive integer", async () => {
		for (const maxItems of [0, -3, 2.5]) {
			const source = scriptedPageSource([{ items: [1], nextCursor: null }]);
			await expect(
				collectProviderPages(source.fetchPage, { maxItems }),
			).rejects.toMatchObject({
				name: "ManagedProviderError",
				code: "INVALID_INPUT",
			});
			expect(source.callCount()).toBe(0);
		}
	});

	it("stops within maxPages and reports the ceiling in the error context", async () => {
		const source = scriptedPageSource([
			{ items: [1], nextCursor: "cursor-a" },
			{ items: [2], nextCursor: "cursor-b" },
			{ items: [3], nextCursor: null },
		]);

		const error = await collectProviderPages(source.fetchPage, {
			maxPages: 2,
		}).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(ManagedProviderError);
		expect(error).toMatchObject({
			code: "PAGINATION_OVERFLOW",
			context: { maxPages: 2 },
		});
		expect(source.callCount()).toBe(2);
	});

	it("allows exactly maxPages pages to complete", async () => {
		const source = scriptedPageSource([
			{ items: [1], nextCursor: "cursor-a" },
			{ items: [2], nextCursor: null },
		]);

		await expect(
			collectProviderPages(source.fetchPage, { maxPages: 2 }),
		).resolves.toEqual([1, 2]);
	});

	it("throws PAGINATION_OVERFLOW when accumulated items exceed maxItems mid-listing", async () => {
		const source = scriptedPageSource([
			{ items: [1, 2], nextCursor: "cursor-a" },
			{ items: [3, 4], nextCursor: "cursor-b" },
		]);

		await expect(
			collectProviderPages(source.fetchPage, { maxItems: 3 }),
		).rejects.toMatchObject({
			name: "ManagedProviderError",
			code: "PAGINATION_OVERFLOW",
			context: { maxItems: 3 },
		});
	});

	it("accepts a listing whose total equals maxItems", async () => {
		const source = scriptedPageSource([
			{ items: [1, 2], nextCursor: "cursor-a" },
			{ items: [3, 4], nextCursor: null },
		]);

		await expect(
			collectProviderPages(source.fetchPage, { maxItems: 4 }),
		).resolves.toEqual([1, 2, 3, 4]);
	});

	it("enforces the default 1000-item ceiling when maxItems is omitted", async () => {
		const fullPage = Array.from({ length: 600 }, (_, i) => i);
		const source = scriptedPageSource([
			{ items: fullPage, nextCursor: "cursor-a" },
			{ items: fullPage, nextCursor: null },
		]);

		await expect(collectProviderPages(source.fetchPage)).rejects.toMatchObject({
			name: "ManagedProviderError",
			code: "PAGINATION_OVERFLOW",
			context: { maxItems: 1000 },
		});
	});

	it("reports an item-limit overflow even when the overflowing page completes the listing", async () => {
		const source = scriptedPageSource([
			{ items: [1, 2], nextCursor: "cursor-a" },
			{ items: [3, 4], nextCursor: null },
		]);

		await expect(
			collectProviderPages(source.fetchPage, { maxItems: 3 }),
		).rejects.toMatchObject({
			code: "PAGINATION_OVERFLOW",
		});
	});

	it("throws MALFORMED_RESPONSE when the provider returns an empty cursor", async () => {
		const source = scriptedPageSource([{ items: [1], nextCursor: "" }]);

		await expect(collectProviderPages(source.fetchPage)).rejects.toMatchObject({
			name: "ManagedProviderError",
			code: "MALFORMED_RESPONSE",
		});
	});

	it("throws MALFORMED_RESPONSE when the provider repeats a cursor", async () => {
		const source = scriptedPageSource([
			{ items: [1], nextCursor: "same-cursor" },
			{ items: [2], nextCursor: "same-cursor" },
		]);

		const error = await collectProviderPages(source.fetchPage).catch(
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(ManagedProviderError);
		expect(error).toMatchObject({ code: "MALFORMED_RESPONSE" });
		expect(source.callCount()).toBe(2);
	});
});
