/**
 * Unit tests for the `embeddings` table descriptor (`embeddingSchema`) backing
 * memory similarity search — one row per memory enforced by
 * `unique_embedding_memory`, with a dedicated vector column per supported
 * width (384–3072). Pure declarative-shape assertions over the real exported
 * object — no mocks, no DB: the descriptor itself is the contract the
 * plugin-sql / localdb adapters materialize. Covers table identity, the full
 * nine-column set including every vector width in declaration order, the
 * non-covering lookup index, the cascading foreign key to memories, and the
 * unique/check constraints the ON CONFLICT upsert depends on.
 */
import { describe, expect, it } from "vitest";
import { embeddingSchema } from "./embedding";

describe("embeddingSchema table identity", () => {
	it("names the embeddings table in the default schema", () => {
		expect(embeddingSchema.name).toBe("embeddings");
		expect(embeddingSchema.schema).toBe("");
	});
});

describe("embeddingSchema columns", () => {
	it("declares exactly the nine embedding columns", () => {
		expect(Object.keys(embeddingSchema.columns).sort()).toEqual([
			"created_at",
			"dim_1024",
			"dim_1536",
			"dim_3072",
			"dim_384",
			"dim_512",
			"dim_768",
			"id",
			"memory_id",
		]);
	});

	it("declares the vector columns in ascending width order after the base columns", () => {
		expect(Object.keys(embeddingSchema.columns)).toEqual([
			"id",
			"memory_id",
			"created_at",
			"dim_384",
			"dim_512",
			"dim_768",
			"dim_1024",
			"dim_1536",
			"dim_3072",
		]);
	});

	it("keeps every column key consistent with its own name field", () => {
		for (const [key, column] of Object.entries(embeddingSchema.columns)) {
			expect(column.name).toBe(key);
		}
	});

	it("types id as a primary-key uuid defaulting to defaultRandom()", () => {
		expect(embeddingSchema.columns.id).toEqual({
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
			default: "defaultRandom()",
		});
	});

	it("leaves memory_id nullable so the check constraint owns the NOT NULL rule", () => {
		expect(embeddingSchema.columns.memory_id).toEqual({
			name: "memory_id",
			type: "uuid",
		});
	});

	it("types created_at as a non-null timestamp defaulting to now()", () => {
		expect(embeddingSchema.columns.created_at).toEqual({
			name: "created_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		});
	});

	it("covers every supported dimension width exactly once, ascending", () => {
		const vectorColumns = Object.entries(embeddingSchema.columns).filter(
			([key]) => key.startsWith("dim_"),
		);
		expect(vectorColumns.map(([key]) => Number(key.slice(4)))).toEqual([
			384, 512, 768, 1024, 1536, 3072,
		]);
		for (const [, column] of vectorColumns) {
			const width = Number(column.name.slice(4));
			expect(column.type).toBe(`vector(${width})`);
		}
	});

	it("keeps vector columns plain typed storage — no nullability, defaults, or keys", () => {
		for (const column of Object.values(embeddingSchema.columns)) {
			if (!column.name.startsWith("dim_")) continue;
			expect(column.notNull).toBeUndefined();
			expect(column.default).toBeUndefined();
			expect(column.primaryKey).toBeUndefined();
		}
	});
});

describe("embeddingSchema indexes", () => {
	it("declares exactly one explicit index", () => {
		expect(Object.keys(embeddingSchema.indexes)).toEqual([
			"idx_embedding_memory",
		]);
	});

	it("keeps idx_embedding_memory a non-unique single-column lookup on memory_id", () => {
		const index = embeddingSchema.indexes.idx_embedding_memory;
		expect(index.name).toBe("idx_embedding_memory");
		expect(index.isUnique).toBe(false);
		expect(index.columns.map((column) => column.expression)).toEqual([
			"memory_id",
		]);
		expect(index.columns.every((column) => column.isExpression === false)).toBe(
			true,
		);
	});

	it("references only columns that exist on the table", () => {
		for (const index of Object.values(embeddingSchema.indexes)) {
			for (const column of index.columns) {
				expect(embeddingSchema.columns[column.expression]).toBeDefined();
			}
		}
	});
});

describe("embeddingSchema foreignKeys", () => {
	it("cascades memory deletion through fk_embedding_memory to memories.id", () => {
		expect(embeddingSchema.foreignKeys.fk_embedding_memory).toEqual({
			name: "fk_embedding_memory",
			tableFrom: "embeddings",
			tableTo: "memories",
			columnsFrom: ["memory_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		});
	});

	it("declares no foreign keys beyond the memories link", () => {
		expect(Object.keys(embeddingSchema.foreignKeys)).toEqual([
			"fk_embedding_memory",
		]);
	});
});

describe("embeddingSchema constraint maps", () => {
	it("uses the uuid default as implicit primary key — no composite keys", () => {
		expect(embeddingSchema.compositePrimaryKeys).toEqual({});
	});

	it("enforces 1:1 memory-to-embedding through unique_embedding_memory", () => {
		expect(Object.keys(embeddingSchema.uniqueConstraints)).toEqual([
			"unique_embedding_memory",
		]);
		expect(embeddingSchema.uniqueConstraints.unique_embedding_memory).toEqual({
			name: "unique_embedding_memory",
			columns: ["memory_id"],
		});
	});

	it("backs the ON CONFLICT upsert target with a declared column", () => {
		const conflictTarget =
			embeddingSchema.uniqueConstraints.unique_embedding_memory.columns;
		for (const columnName of conflictTarget) {
			expect(embeddingSchema.columns[columnName]).toBeDefined();
		}
	});

	it("requires a non-null memory_id via embedding_source_check", () => {
		expect(Object.keys(embeddingSchema.checkConstraints)).toEqual([
			"embedding_source_check",
		]);
		expect(embeddingSchema.checkConstraints.embedding_source_check).toEqual({
			name: "embedding_source_check",
			value: '"memory_id" IS NOT NULL',
		});
	});
});
