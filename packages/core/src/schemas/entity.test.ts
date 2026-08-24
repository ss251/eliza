/**
 * Unit tests for the `entities` table descriptor (`entitySchema`) — the
 * per-agent record of the people and things an agent knows, keyed uniquely by
 * (id, agent_id). Pure declarative-shape assertions over the real exported
 * object — no mocks, no DB: the descriptor itself is the contract adapters
 * materialize. Covers table identity, the full five-column set with nullability
 * and defaults (including the raw text[]/jsonb defaults), the uuid primary key,
 * the agent-scoping foreign key with its cascade delete, the plain agent_id
 * lookup index, and the (id, agent_id) uniqueness that makes an entity
 * per-agent rather than global.
 */
import { describe, expect, it } from "vitest";
import { entitySchema } from "./entity";

describe("entitySchema table identity", () => {
	it("names the entities table in the default schema", () => {
		expect(entitySchema.name).toBe("entities");
		expect(entitySchema.schema).toBe("");
	});
});

describe("entitySchema columns", () => {
	it("declares exactly the five entity columns", () => {
		expect(Object.keys(entitySchema.columns).sort()).toEqual([
			"agent_id",
			"created_at",
			"id",
			"metadata",
			"names",
		]);
	});

	it("keeps every column key consistent with its own name field", () => {
		for (const [key, column] of Object.entries(entitySchema.columns)) {
			expect(column.name).toBe(key);
		}
	});

	it("types id as a non-null uuid primary key with no server-side default", () => {
		expect(entitySchema.columns.id).toEqual({
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
		});
		expect(entitySchema.columns.id.default).toBeUndefined();
	});

	it("flags no column other than id as a primary key", () => {
		const primaryKeys = Object.entries(entitySchema.columns)
			.filter(([, column]) => column.primaryKey === true)
			.map(([key]) => key);
		expect(primaryKeys).toEqual(["id"]);
	});

	it("marks no column as explicitly unique at the column level", () => {
		for (const column of Object.values(entitySchema.columns)) {
			expect(column.isUnique).toBeUndefined();
			expect(column.uniqueName).toBeUndefined();
			expect(column.uniqueType).toBeUndefined();
		}
	});

	it("scopes every entity to its owning agent via a non-null agent_id uuid", () => {
		expect(entitySchema.columns.agent_id).toEqual({
			name: "agent_id",
			type: "uuid",
			notNull: true,
		});
		expect(entitySchema.columns.agent_id.primaryKey).toBeUndefined();
		expect(entitySchema.columns.agent_id.default).toBeUndefined();
	});

	it("timestamps created_at as a non-null now()-defaulted column", () => {
		expect(entitySchema.columns.created_at).toEqual({
			name: "created_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		});
	});

	it("stores names as a non-null text array defaulting to []", () => {
		expect(entitySchema.columns.names).toEqual({
			name: "names",
			type: "text[]",
			notNull: true,
			default: "[]",
		});
		expect(entitySchema.columns.names.default).toBe("[]");
	});

	it("stores metadata as a non-null jsonb object map defaulting to {}", () => {
		expect(entitySchema.columns.metadata).toEqual({
			name: "metadata",
			type: "jsonb",
			notNull: true,
			default: "{}",
		});
		expect(entitySchema.columns.metadata.default).toBe("{}");
	});

	it("marks all five columns non-null", () => {
		const notNullColumns = Object.entries(entitySchema.columns)
			.filter(([, column]) => column.notNull === true)
			.map(([key]) => key)
			.sort();
		expect(notNullColumns).toEqual([
			"agent_id",
			"created_at",
			"id",
			"metadata",
			"names",
		]);
	});

	it("requires explicit values for exactly id and agent_id", () => {
		const withoutDefault = Object.entries(entitySchema.columns)
			.filter(([, column]) => column.default === undefined)
			.map(([key]) => key)
			.sort();
		expect(withoutDefault).toEqual(["agent_id", "id"]);
	});
});

describe("entitySchema indexes and constraints", () => {
	it("declares exactly one index: a plain non-unique scan index on agent_id alone", () => {
		expect(Object.keys(entitySchema.indexes)).toEqual(["idx_entities_agent"]);
		expect(entitySchema.indexes.idx_entities_agent).toMatchObject({
			name: "idx_entities_agent",
			isUnique: false,
		});
	});

	it("indexes the bare agent_id column, not an expression", () => {
		expect(entitySchema.indexes.idx_entities_agent.columns).toEqual([
			{ expression: "agent_id", isExpression: false },
		]);
	});

	it("cascades entity deletion when its owning agent row is removed", () => {
		expect(Object.keys(entitySchema.foreignKeys)).toEqual(["fk_entity_agent"]);
		expect(entitySchema.foreignKeys.fk_entity_agent).toEqual({
			name: "fk_entity_agent",
			tableFrom: "entities",
			tableTo: "agents",
			columnsFrom: ["agent_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		});
	});

	it("leaves the foreign key source schema unset", () => {
		expect(entitySchema.foreignKeys.fk_entity_agent.schemaFrom).toBeUndefined();
	});

	it("uses the single-column id primary key — no composite keys", () => {
		expect(entitySchema.compositePrimaryKeys).toEqual({});
	});

	it("enforces per-agent uniqueness through the (id, agent_id) constraint", () => {
		expect(Object.keys(entitySchema.uniqueConstraints)).toEqual([
			"id_agent_id_unique",
		]);
		expect(entitySchema.uniqueConstraints.id_agent_id_unique).toEqual({
			name: "id_agent_id_unique",
			columns: ["id", "agent_id"],
		});
	});

	it("declares no check constraints", () => {
		expect(entitySchema.checkConstraints).toEqual({});
	});
});
