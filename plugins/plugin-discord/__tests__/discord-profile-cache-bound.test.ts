import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
	getDiscordProfileCacheSizes,
	resolveDiscordMessageAuthorProfile,
	resolveDiscordUserProfile,
} from "../discord-profiles";

/**
 * Written as a literal on purpose. Importing the exported
 * DISCORD_PROFILE_CACHE_MAX_ENTRIES would make every assertion below vacuous
 * against unpatched code: there the export does not exist, so each bound
 * silently becomes `undefined` and each loop count becomes `NaN` — the loops
 * never run and the test "fails" without ever exercising the cache.
 */
const EXPECTED_MAX_ENTRIES = 512;

/**
 * The profile caches are keyed by `channelId:messageId` and by user id, and
 * their TTL is enforced only lazily on a read of the SAME key. A message id is
 * essentially never read twice, so before the bound every resolved message
 * left a permanent module-scoped entry.
 */

function makeRuntime(): AgentRuntime {
	const client = {
		channels: {
			cache: {
				get: (channelId: string) => ({
					messages: {
						fetch: async (messageId: string) => ({
							author: {
								id: `user-${messageId}`,
								username: `name-${messageId}`,
								globalName: `Global ${messageId}`,
								displayAvatarURL: () =>
									`https://cdn.discordapp.com/avatars/${channelId}/${messageId}.png`,
							},
							member: null,
						}),
					},
				}),
			},
		},
		users: {
			fetch: async (userId: string) => ({
				id: userId,
				username: `name-${userId}`,
				globalName: `Global ${userId}`,
				displayAvatarURL: () =>
					`https://cdn.discordapp.com/avatars/${userId}.png`,
			}),
		},
	};

	return {
		getService: (name: string) => (name === "discord" ? { client } : undefined),
	} as unknown as AgentRuntime;
}

describe("discord profile cache bounds", () => {
	it("keeps the message-author cache bounded across many distinct messages", async () => {
		const runtime = makeRuntime();
		const total = EXPECTED_MAX_ENTRIES * 4;

		for (let i = 0; i < total; i += 1) {
			await resolveDiscordMessageAuthorProfile(
				runtime,
				"channel-bound",
				`msg-bound-${i}`,
			);
		}

		expect(getDiscordProfileCacheSizes().messageAuthors).toBeLessThanOrEqual(
			EXPECTED_MAX_ENTRIES,
		);
	});

	it("keeps the user cache bounded across many distinct users", async () => {
		const runtime = makeRuntime();
		const total = EXPECTED_MAX_ENTRIES * 4;

		for (let i = 0; i < total; i += 1) {
			await resolveDiscordUserProfile(runtime, `user-bound-${i}`);
		}

		expect(getDiscordProfileCacheSizes().users).toBeLessThanOrEqual(
			EXPECTED_MAX_ENTRIES,
		);
	});

	it("bounds the cache even when every fetch fails and caches a null", async () => {
		const failingRuntime = {
			getService: () => ({
				client: {
					channels: {
						cache: {
							get: () => ({
								messages: {
									fetch: async () => {
										throw new Error("unknown message");
									},
								},
							}),
						},
					},
					users: {
						fetch: async () => {
							throw new Error("unknown user");
						},
					},
				},
			}),
		} as unknown as AgentRuntime;

		const total = EXPECTED_MAX_ENTRIES * 3;
		for (let i = 0; i < total; i += 1) {
			await resolveDiscordMessageAuthorProfile(
				failingRuntime,
				"channel-null",
				`msg-null-${i}`,
			);
			await resolveDiscordUserProfile(failingRuntime, `user-null-${i}`);
		}

		const sizes = getDiscordProfileCacheSizes();
		expect(sizes.messageAuthors).toBeLessThanOrEqual(EXPECTED_MAX_ENTRIES);
		expect(sizes.users).toBeLessThanOrEqual(EXPECTED_MAX_ENTRIES);
	});

	// --- compatibility: previously-valid behaviour is unchanged ---

	it("still resolves the same profile values it resolved before the bound", async () => {
		const runtime = makeRuntime();

		const author = await resolveDiscordMessageAuthorProfile(
			runtime,
			"channel-compat",
			"msg-compat",
		);
		expect(author).toEqual({
			displayName: "Global msg-compat",
			username: "name-msg-compat",
			avatarUrl:
				"https://cdn.discordapp.com/avatars/channel-compat/msg-compat.png",
			rawUserId: "user-msg-compat",
		});

		const user = await resolveDiscordUserProfile(runtime, "user-compat");
		expect(user).toEqual({
			displayName: "Global user-compat",
			username: "name-user-compat",
			avatarUrl: "https://cdn.discordapp.com/avatars/user-compat.png",
		});
	});

	it("still serves a cache hit without re-fetching", async () => {
		let fetches = 0;
		const countingRuntime = {
			getService: () => ({
				client: {
					users: {
						fetch: async (userId: string) => {
							fetches += 1;
							return {
								id: userId,
								username: `name-${userId}`,
								globalName: `Global ${userId}`,
								displayAvatarURL: () => "https://cdn.discordapp.com/a.png",
							};
						},
					},
				},
			}),
		} as unknown as AgentRuntime;

		const first = await resolveDiscordUserProfile(countingRuntime, "user-hit");
		const second = await resolveDiscordUserProfile(countingRuntime, "user-hit");

		expect(fetches).toBe(1);
		expect(second).toEqual(first);
	});

	it("still serves a cached null without re-fetching", async () => {
		let fetches = 0;
		const failingRuntime = {
			getService: () => ({
				client: {
					users: {
						fetch: async () => {
							fetches += 1;
							throw new Error("unknown user");
						},
					},
				},
			}),
		} as unknown as AgentRuntime;

		expect(
			await resolveDiscordUserProfile(failingRuntime, "user-null-hit"),
		).toBeNull();
		expect(
			await resolveDiscordUserProfile(failingRuntime, "user-null-hit"),
		).toBeNull();
		expect(fetches).toBe(1);
	});

	/**
	 * The behaviourally load-bearing case: it touches only exports that already
	 * existed before this change, so it is a real observation of the defect
	 * rather than an artefact of a newly added introspection helper. Against
	 * unpatched code nothing is ever evicted, so the oldest key is still a cache
	 * hit and the final assertion fails.
	 */
	it("evicts the oldest entry once the cache is full", async () => {
		const total = EXPECTED_MAX_ENTRIES * 2;

		let fetches = 0;
		const countingRuntime = {
			getService: () => ({
				client: {
					users: {
						fetch: async (userId: string) => {
							fetches += 1;
							return {
								id: userId,
								username: `name-${userId}`,
								globalName: `Global ${userId}`,
								displayAvatarURL: () => "https://cdn.discordapp.com/a.png",
							};
						},
					},
				},
			}),
		} as unknown as AgentRuntime;

		for (let i = 0; i < total; i += 1) {
			await resolveDiscordUserProfile(countingRuntime, `user-lru-${i}`);
		}
		const afterFill = fetches;

		expect(afterFill).toBe(total);

		// The newest entry must still be a cache hit...
		await resolveDiscordUserProfile(countingRuntime, `user-lru-${total - 1}`);
		expect(fetches).toBe(afterFill);

		// ...and the oldest must have been evicted, forcing a re-fetch. Without
		// a bound this is still cached and no re-fetch happens.
		await resolveDiscordUserProfile(countingRuntime, "user-lru-0");
		expect(fetches).toBe(afterFill + 1);
	});
});
