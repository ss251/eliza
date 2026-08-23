/**
 * Verifies the portable entity-resolution schemas preserve generated primary
 * keys, provenance nullability, ordered lookup indexes, cascading ownership,
 * and pending-first merge/fact lifecycles exactly as adapters materialize
 * them.
 */

import { describe, expect, it } from "vitest";
import {
	entityIdentitySchema,
	entityMergeCandidateSchema,
	factCandidateSchema,
} from "./entity-identity";

describe("entity resolution schemas", () => {
	it("registers three portable entity-resolution tables", () => {
		expect(entityIdentitySchema.name).toBe("entity_identities");
		expect(entityMergeCandidateSchema.name).toBe("entity_merge_candidates");
		expect(factCandidateSchema.name).toBe("fact_candidates");
		expect(entityIdentitySchema.schema).toBe("");
		expect(entityMergeCandidateSchema.schema).toBe("");
		expect(factCandidateSchema.schema).toBe("");
	});

	it("anchors every row on a generated uuid primary key", () => {
		for (const table of [
			entityIdentitySchema,
			entityMergeCandidateSchema,
			factCandidateSchema,
		]) {
			const id = table.columns.id;
			expect(id?.primaryKey).toBe(true);
			expect(id?.notNull).toBe(true);
			expect(id?.type).toBe("uuid");
			expect(id?.default).toBe("gen_random_uuid()");
		}
	});

	it("requires identity claims while leaving optional provenance nullable", () => {
		const columns = entityIdentitySchema.columns;
		for (const required of [
			"entity_id",
			"agent_id",
			"platform",
			"handle",
			"verified",
			"confidence",
			"first_seen",
			"last_seen",
			"created_at",
		]) {
			expect(columns[required as keyof typeof columns]?.notNull).toBe(true);
		}
		expect(columns.source?.notNull).toBeUndefined();
		expect(columns.evidence_message_ids?.notNull).toBeUndefined();
		expect(columns.verified?.type).toBe("boolean");
		expect(columns.verified?.default).toBe(false);
		expect(columns.confidence?.type).toBe("real");
		expect(columns.confidence?.default).toBe(0);
		expect(columns.first_seen?.default).toBe("now()");
		expect(columns.last_seen?.default).toBe("now()");
		expect(columns.created_at?.default).toBe("now()");
	});

	it("indexes lookups in stable column order without imposing uniqueness", () => {
		expect(
			entityIdentitySchema.indexes.idx_entity_identities_entity?.columns,
		).toEqual([{ expression: "entity_id", isExpression: false }]);
		expect(
			entityIdentitySchema.indexes.idx_entity_identities_platform_handle
				?.columns,
		).toEqual([
			{ expression: "platform", isExpression: false },
			{ expression: "handle", isExpression: false },
		]);
		for (const index of Object.values(entityIdentitySchema.indexes)) {
			expect(index.isUnique).toBe(false);
		}
	});

	it("cascades claim deletion from owning entities and agents", () => {
		const foreignKeys = entityIdentitySchema.foreignKeys;
		expect(foreignKeys.fk_entity_identities_entity).toMatchObject({
			tableTo: "entities",
			columnsFrom: ["entity_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
		});
		expect(foreignKeys.fk_entity_identities_agent).toMatchObject({
			tableTo: "agents",
			columnsFrom: ["agent_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
		});
		expect(
			entityIdentitySchema.uniqueConstraints.unique_entity_identity?.columns,
		).toEqual(["entity_id", "platform", "handle", "agent_id"]);
		expect(entityIdentitySchema.compositePrimaryKeys).toEqual({});
		expect(entityIdentitySchema.checkConstraints).toEqual({});
	});

	it("stages merge proposals as pending until a human resolves them", () => {
		const columns = entityMergeCandidateSchema.columns;
		expect(columns.status?.notNull).toBe(true);
		expect(columns.status?.default).toBe("'pending'");
		expect(columns.entity_a?.notNull).toBe(true);
		expect(columns.entity_b?.notNull).toBe(true);
		expect(columns.resolved_at?.notNull).toBeUndefined();
		expect(
			entityMergeCandidateSchema.indexes.idx_entity_merge_candidates_pair
				?.columns,
		).toEqual([
			{ expression: "entity_a", isExpression: false },
			{ expression: "entity_b", isExpression: false },
		]);
		expect(
			entityMergeCandidateSchema.foreignKeys.fk_entity_merge_candidates_a
				?.onDelete,
		).toBe("cascade");
		expect(
			entityMergeCandidateSchema.foreignKeys.fk_entity_merge_candidates_b
				?.onDelete,
		).toBe("cascade");
		expect(
			entityMergeCandidateSchema.foreignKeys.fk_entity_merge_candidates_agent
				?.tableTo,
		).toBe("agents");
		expect(entityMergeCandidateSchema.uniqueConstraints).toEqual({});
	});

	it("queues fact refinements against the contradicted fact", () => {
		const columns = factCandidateSchema.columns;
		expect(columns.kind?.notNull).toBe(true);
		expect(columns.proposed_text?.notNull).toBe(true);
		expect(columns.existing_fact_id?.notNull).toBeUndefined();
		expect(columns.confidence?.default).toBe(0);
		expect(columns.status?.default).toBe("'pending'");
		expect(columns.resolved_at?.notNull).toBeUndefined();
		expect(
			factCandidateSchema.foreignKeys.fk_fact_candidates_entity,
		).toMatchObject({
			tableTo: "entities",
			columnsFrom: ["entity_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
		});
		expect(
			factCandidateSchema.foreignKeys.fk_fact_candidates_agent?.tableTo,
		).toBe("agents");
		expect(factCandidateSchema.compositePrimaryKeys).toEqual({});
	});
});
