/**
 * Deterministic tests for `getEntityDetails` component-data merge on the real
 * module. Origin Object.assign last-wins dropped earlier array values; the
 * intended per-key union must keep every scalar, array member, and nested
 * object field. An id-less persisted entity must fail with a typed integrity
 * error instead of disappearing from model context. Adapter seams are stubbed;
 * getEntityDetails is not replaced.
 */
import { describe, expect, it } from "vitest";
import {
	ENTITY_DETAILS_MISSING_ID,
	EntityDetailsIntegrityError,
	getEntityDetails,
} from "./entities";
import type { Entity, IAgentRuntime, UUID } from "./types";

const AGENT = "00000000-0000-0000-0000-0000000000aa" as UUID;
const ALICE = "00000000-0000-0000-0000-0000000000a1" as UUID;
const ROOM = "00000000-0000-0000-0000-0000000000c0" as UUID;

function component(
	id: string,
	data: Record<string, unknown>,
): NonNullable<Entity["components"]>[number] {
	return {
		id: id as UUID,
		entityId: ALICE,
		agentId: AGENT,
		roomId: ROOM,
		worldId: ROOM,
		sourceEntityId: AGENT,
		type: "profile",
		createdAt: 1,
		data,
	};
}

describe("getEntityDetails component merge", () => {
	it("unions array values across components instead of keeping only the last", async () => {
		const runtime = {
			agentId: AGENT,
			getRoom: async () => ({ id: ROOM, source: "discord" }),
			getEntitiesForRoom: async () => [
				{
					id: ALICE,
					agentId: AGENT,
					names: ["Alice"],
					metadata: {},
					components: [
						component("00000000-0000-0000-0000-0000000000e1", {
							emails: ["alice@home.example"],
							tags: ["home"],
							enabled: false,
						}),
						component("00000000-0000-0000-0000-0000000000e2", {
							emails: ["alice@work.example"],
							tags: ["work"],
							enabled: true,
						}),
					],
				} as Entity,
			],
		} as unknown as IAgentRuntime;

		const details = await getEntityDetails({ runtime, roomId: ROOM });
		expect(details).toHaveLength(1);
		const data = JSON.parse(String(details[0]?.data));
		expect(data.emails).toEqual(
			expect.arrayContaining(["alice@home.example", "alice@work.example"]),
		);
		expect(data.tags).toEqual(expect.arrayContaining(["home", "work"]));
		expect(data.enabled).toBe(true);
	});

	it("keeps a previously-valid scalar last-write and nested object merge", async () => {
		const runtime = {
			agentId: AGENT,
			getRoom: async () => ({ id: ROOM, source: "discord" }),
			getEntitiesForRoom: async () => [
				{
					id: ALICE,
					agentId: AGENT,
					names: ["Alice"],
					metadata: {},
					components: [
						component("00000000-0000-0000-0000-0000000000e1", {
							handle: "alice",
							profile: { city: "Oslo", tz: "Europe/Oslo" },
						}),
						component("00000000-0000-0000-0000-0000000000e2", {
							handle: "alice_w",
							profile: { title: "eng" },
						}),
					],
				} as Entity,
			],
		} as unknown as IAgentRuntime;

		const details = await getEntityDetails({ runtime, roomId: ROOM });
		const data = JSON.parse(String(details[0]?.data));
		expect(data.handle).toBe("alice_w");
		expect(data.profile).toEqual({
			city: "Oslo",
			tz: "Europe/Oslo",
			title: "eng",
		});
	});

	it("still lists every named room participant in sorted order", async () => {
		const runtime = {
			agentId: AGENT,
			getRoom: async () => ({ id: ROOM }),
			getEntitiesForRoom: async () => [
				{
					id: "00000000-0000-0000-0000-0000000000b0" as UUID,
					agentId: AGENT,
					names: ["Bob"],
					metadata: {},
					components: [],
				} as Entity,
				{
					id: ALICE,
					agentId: AGENT,
					names: ["Alice"],
					metadata: {},
					components: [],
				} as Entity,
			],
		} as unknown as IAgentRuntime;

		const details = await getEntityDetails({ runtime, roomId: ROOM });
		expect(details.map((row) => row.names[0])).toEqual(["Alice", "Bob"]);
	});

	it("rejects an id-less room entity instead of silently dropping it", async () => {
		const runtime = {
			agentId: AGENT,
			getRoom: async () => ({ id: ROOM }),
			getEntitiesForRoom: async () => [
				{
					id: ALICE,
					agentId: AGENT,
					names: ["Alice"],
					components: [],
				} as Entity,
				{
					agentId: AGENT,
					names: ["Unsaved Bob"],
					components: [],
				} as Entity,
			],
		} as unknown as IAgentRuntime;

		const pending = getEntityDetails({ runtime, roomId: ROOM });
		await expect(pending).rejects.toBeInstanceOf(EntityDetailsIntegrityError);
		await expect(pending).rejects.toMatchObject({
			code: ENTITY_DETAILS_MISSING_ID,
			context: { roomId: ROOM, entityIndex: 1 },
		});
	});
});
