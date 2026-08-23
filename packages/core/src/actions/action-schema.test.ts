/**
 * Covers the Action `parameters` -> JSON Schema conversion that feeds tool
 * definitions, planner grammars, and argument validation.
 *
 * Two properties are load-bearing. `additionalProperties` must default to
 * `false` — the schema gates what a model may emit as tool arguments, so
 * defaulting open would silently accept unmodelled fields. And a parameter
 * schema with neither a `type` nor a `oneOf`/`anyOf` branch must throw with the
 * offending path rather than emit a typeless schema, because a typeless node
 * degrades the generated grammar instead of failing visibly.
 *
 * Pure conversion — no runtime, no model, no IO.
 */
import { describe, expect, it } from "vitest";
import type { Action, ActionParameter, ActionParameterSchema } from "../types";
import {
	actionParameterSchemaToJsonSchema,
	actionParametersToJsonSchema,
	actionToJsonSchema,
	normalizeActionJsonSchema,
} from "./action-schema.ts";

const param = (overrides: Partial<ActionParameter>): ActionParameter =>
	({
		name: "value",
		schema: { type: "string" },
		...overrides,
	}) as ActionParameter;

describe("actionParametersToJsonSchema", () => {
	it("emits an object schema with properties and an empty required list", () => {
		expect(actionParametersToJsonSchema([param({ name: "text" })])).toEqual({
			type: "object",
			properties: { text: { type: "string" } },
			required: [],
			additionalProperties: false,
		});
	});

	it("closes the schema by default and opens it only on explicit opt-in", () => {
		expect(actionParametersToJsonSchema([]).additionalProperties).toBe(false);
		expect(
			actionParametersToJsonSchema([], { allowAdditionalProperties: false })
				.additionalProperties,
		).toBe(false);
		expect(
			actionParametersToJsonSchema([], { allowAdditionalProperties: true })
				.additionalProperties,
		).toBe(true);
	});

	it("lists only required parameters, preserving declaration order", () => {
		const schema = actionParametersToJsonSchema([
			param({ name: "a", required: true }),
			param({ name: "b" }),
			param({ name: "c", required: true }),
		]);
		expect(schema.required).toEqual(["a", "c"]);
		expect(Object.keys(schema.properties)).toEqual(["a", "b", "c"]);
	});

	it("defaults to an empty schema for no parameters", () => {
		expect(actionParametersToJsonSchema()).toEqual({
			type: "object",
			properties: {},
			required: [],
			additionalProperties: false,
		});
	});

	it("folds parameter examples into the description", () => {
		const schema = actionParametersToJsonSchema([
			param({
				name: "text",
				description: "The body",
				examples: ["hello", "hi"],
			} as Partial<ActionParameter>),
		]);
		expect(schema.properties.text?.description).toContain("The body");
		expect(schema.properties.text?.description).toContain("hello");
	});

	it("falls back through description, descriptionCompressed, then compressedDescription", () => {
		const compressed = {
			name: "short",
			descriptionCompressed: "compressed",
			schema: { type: "string" },
		} as ActionParameter;
		const alias = {
			name: "alias",
			compressedDescription: "alias-desc",
			schema: { type: "boolean" },
		} as ActionParameter;

		expect(
			actionParametersToJsonSchema([compressed, alias]).properties,
		).toEqual({
			short: { type: "string", description: "compressed" },
			alias: { type: "boolean", description: "alias-desc" },
		});
	});

	it("appends JSON-stringified object examples and omits empty example strings", () => {
		expect(
			actionParametersToJsonSchema([
				param({
					name: "limit",
					description: "Max results",
					examples: [1, 2, true, { k: "v" }, ""],
				}),
				{
					name: "bare",
					examples: ["only"],
					schema: { type: "string" },
				} as ActionParameter,
				param({
					name: "none",
					description: "No examples",
					examples: [],
				}),
			]).properties,
		).toEqual({
			limit: {
				type: "string",
				description: 'Max results (e.g. 1, 2, true, {"k":"v"})',
			},
			bare: { type: "string", description: "e.g. only" },
			none: { type: "string", description: "No examples" },
		});
	});

	it("does not append examples when the schema already has a description", () => {
		expect(
			actionParametersToJsonSchema([
				param({
					name: "query",
					description: "parameter description",
					examples: ["alpha"],
					schema: { type: "string", description: "schema description" },
				}),
			]).properties.query,
		).toEqual({
			type: "string",
			description: "schema description",
		});
	});

	it("leaves description unchanged when every example stringifies to empty", () => {
		expect(
			actionParametersToJsonSchema([
				param({
					name: "blank",
					description: "kept",
					examples: ["", ""],
				}),
			]).properties.blank,
		).toEqual({ type: "string", description: "kept" });
	});

	it("reads parameter-level options only after schema.enumValues, schema.enum, and schema.options", () => {
		const withSchemaEnum = {
			name: "mode",
			description: "Execution mode",
			options: [
				{ label: "Fast", value: "fast" },
				{ label: "Careful", value: "careful" },
			],
			schema: { type: "string", enum: ["from-schema"] },
		} as ActionParameter & {
			options: Array<{ label: string; value: string }>;
		};
		expect(
			actionParametersToJsonSchema([withSchemaEnum]).properties.mode,
		).toEqual({
			type: "string",
			description: "Execution mode",
			enum: ["from-schema"],
		});

		const fromParameterOptions = {
			name: "mode",
			description: "Execution mode",
			options: [
				{ label: "Fast", value: "fast" },
				{ label: "Careful", value: "careful" },
			],
			schema: { type: "string" },
		} as ActionParameter & {
			options: Array<{ label: string; value: string }>;
		};
		expect(
			actionParametersToJsonSchema([fromParameterOptions]).properties.mode,
		).toEqual({
			type: "string",
			description: "Execution mode",
			enum: ["fast", "careful"],
		});
	});
});

describe("actionParameterSchemaToJsonSchema", () => {
	it("carries scalar constraints through", () => {
		expect(
			actionParameterSchemaToJsonSchema({
				type: "number",
				minimum: 1,
				maximum: 10,
			} as never),
		).toMatchObject({ type: "number", minimum: 1, maximum: 10 });
	});

	it("converts nested object properties", () => {
		const schema = actionParameterSchemaToJsonSchema({
			type: "object",
			properties: { inner: { type: "string" } },
		} as never);
		expect(schema.properties?.inner).toMatchObject({ type: "string" });
	});

	it("converts array item schemas", () => {
		const schema = actionParameterSchemaToJsonSchema({
			type: "array",
			items: { type: "integer" },
		} as never);
		expect(schema.items).toMatchObject({ type: "integer" });
	});

	it("maps oneOf and anyOf branches recursively", () => {
		const anyOf = actionParameterSchemaToJsonSchema({
			anyOf: [{ type: "string" }, { type: "number" }],
		} as never);
		expect(anyOf.anyOf).toHaveLength(2);
		const oneOf = actionParameterSchemaToJsonSchema({
			oneOf: [{ type: "boolean" }],
		} as never);
		expect(oneOf.oneOf).toHaveLength(1);
	});

	it("throws with the offending path when no type or branch is given", () => {
		expect(() =>
			actionParameterSchemaToJsonSchema({} as never, { path: "outer.inner" }),
		).toThrow(/outer\.inner/);
	});

	it("rejects an unsupported type rather than passing it through", () => {
		expect(() =>
			actionParameterSchemaToJsonSchema({ type: "bigint" } as never, {
				path: "p",
			}),
		).toThrow();
	});

	it("emits a typed scalar with description, default, enum, and string constraints", () => {
		expect(
			actionParameterSchemaToJsonSchema({
				type: "string",
				description: "Code",
				minLength: 2,
				maxLength: 8,
				pattern: "^[a-z]+$",
				default: "ab",
				enum: ["ab", "cd"],
			}),
		).toEqual({
			type: "string",
			description: "Code",
			minLength: 2,
			maxLength: 8,
			pattern: "^[a-z]+$",
			default: "ab",
			enum: ["ab", "cd"],
		});
	});

	it("prefers schema.description over the options fallback and omits description when neither is set", () => {
		expect(
			actionParameterSchemaToJsonSchema(
				{ type: "boolean", description: "from schema" },
				{ description: "from options" },
			),
		).toEqual({ type: "boolean", description: "from schema" });
		expect(
			actionParameterSchemaToJsonSchema(
				{ type: "boolean" },
				{ description: "from options" },
			),
		).toEqual({ type: "boolean", description: "from options" });
		expect(actionParameterSchemaToJsonSchema({ type: "boolean" })).toEqual({
			type: "boolean",
		});
	});

	it("defaults the error path to <anonymous> when options.path is omitted", () => {
		expect(() => actionParameterSchemaToJsonSchema({})).toThrow(
			"Action parameter schema at '<anonymous>' must include a 'type' or use 'oneOf' / 'anyOf'",
		);
	});

	it("throws when type is missing and oneOf/anyOf are empty", () => {
		expect(() =>
			actionParameterSchemaToJsonSchema(
				{ oneOf: [], anyOf: [] },
				{ path: "mode" },
			),
		).toThrow(
			"Action parameter schema at 'mode' must include a 'type' or use 'oneOf' / 'anyOf'",
		);
	});

	it("throws for an unsupported schema type using the provided path", () => {
		expect(() =>
			actionParameterSchemaToJsonSchema({ type: "null" }, { path: "payload" }),
		).toThrow("Unsupported schema type 'null' for action parameter 'payload'");
	});

	it("prefers anyOf over oneOf and over a sibling type", () => {
		expect(
			actionParameterSchemaToJsonSchema({
				type: "string",
				description: "id or count",
				anyOf: [{ type: "string" }, { type: "integer" }],
				oneOf: [{ type: "boolean" }],
			}),
		).toEqual({
			description: "id or count",
			anyOf: [{ type: "string" }, { type: "integer" }],
		});
	});

	it("emits oneOf when anyOf is absent, without copying the sibling type", () => {
		expect(
			actionParameterSchemaToJsonSchema({
				type: "string",
				oneOf: [{ type: "string" }, { type: "number" }],
			}),
		).toEqual({
			oneOf: [{ type: "string" }, { type: "number" }],
		});
	});

	it("nests union error paths so a typeless branch names its index", () => {
		expect(() =>
			actionParameterSchemaToJsonSchema(
				{ anyOf: [{ type: "string" }, {}] },
				{ path: "value" },
			),
		).toThrow(
			"Action parameter schema at 'value.anyOf[1]' must include a 'type' or use 'oneOf' / 'anyOf'",
		);
		expect(() =>
			actionParameterSchemaToJsonSchema({ oneOf: [{}] }, { path: "choice" }),
		).toThrow(
			"Action parameter schema at 'choice.oneOf[0]' must include a 'type' or use 'oneOf' / 'anyOf'",
		);
	});

	it("keeps primitive enum values from options.enumValues and does not fall back when that list is empty", () => {
		expect(
			actionParameterSchemaToJsonSchema(
				{ type: "string", enum: ["schema"] },
				{ enumValues: ["from-options", 2, true, { skip: true }] },
			),
		).toEqual({
			type: "string",
			enum: ["from-options", 2, true],
		});

		expect(
			actionParameterSchemaToJsonSchema(
				{ type: "string", enum: ["schema"] },
				{ enumValues: [] },
			),
		).toEqual({ type: "string" });
	});

	it("reads enum from schema.enumValues, then schema.enum, then schema.options, skipping empty or invalid lists", () => {
		expect(
			actionParameterSchemaToJsonSchema({
				type: "string",
				enumValues: ["first"],
				enum: ["second"],
			}),
		).toEqual({ type: "string", enum: ["first"] });

		expect(
			actionParameterSchemaToJsonSchema({
				type: "string",
				enumValues: [{ no: "value" }],
				enum: ["second"],
			} as ActionParameterSchema),
		).toEqual({ type: "string", enum: ["second"] });

		expect(
			actionParameterSchemaToJsonSchema({
				type: "string",
				enum: "not-an-array",
				options: [
					{ label: "Fast", value: "fast" },
					{ label: "Careful", value: "careful" },
					{ label: "skipped" },
					"direct",
					null,
				],
			} as ActionParameterSchema),
		).toEqual({
			type: "string",
			enum: ["fast", "careful", "direct"],
		});
	});

	it("accepts numeric and boolean enum entries, including option-object values", () => {
		expect(
			actionParameterSchemaToJsonSchema({
				type: "number",
				enum: [0, 1, false, true] as unknown as string[],
			}),
		).toEqual({ type: "number", enum: [0, 1, false, true] });

		expect(
			actionParameterSchemaToJsonSchema({
				type: "string",
				options: [{ value: 0 }, { value: true }, { value: { nested: true } }],
			} as ActionParameterSchema),
		).toEqual({ type: "string", enum: [0, true] });
	});

	it("uses legacy defaultValue only when default is absent, and copies null/false/0 defaults", () => {
		expect(
			actionParameterSchemaToJsonSchema({
				type: "string",
				default: "canonical",
				defaultValue: "legacy",
			} as ActionParameterSchema),
		).toEqual({ type: "string", default: "canonical" });

		expect(
			actionParameterSchemaToJsonSchema({
				type: "string",
				defaultValue: "legacy",
			} as ActionParameterSchema),
		).toEqual({ type: "string", default: "legacy" });

		expect(
			actionParameterSchemaToJsonSchema({
				type: "boolean",
				default: false,
			}),
		).toEqual({ type: "boolean", default: false });
		expect(
			actionParameterSchemaToJsonSchema({ type: "number", default: 0 }),
		).toEqual({ type: "number", default: 0 });
		expect(
			actionParameterSchemaToJsonSchema({ type: "string", default: null }),
		).toEqual({ type: "string", default: null });
	});

	it("builds object properties, required names, and additionalProperties", () => {
		const schema = actionParameterSchemaToJsonSchema({
			type: "object",
			properties: {
				name: { type: "string" },
				count: { type: "integer", required: true } as ActionParameterSchema,
				skip: { type: "boolean" },
			},
			required: ["name", 1 as unknown as string, "missing"],
		});

		expect(schema).toEqual({
			type: "object",
			properties: {
				name: { type: "string" },
				count: { type: "integer" },
				skip: { type: "boolean" },
			},
			required: ["name", "count"],
			additionalProperties: false,
		});
	});

	it("defaults object properties to {} when omitted and honors additionalProperties true/false/schema", () => {
		expect(actionParameterSchemaToJsonSchema({ type: "object" })).toEqual({
			type: "object",
			properties: {},
			required: [],
			additionalProperties: false,
		});

		expect(
			actionParameterSchemaToJsonSchema({
				type: "object",
				additionalProperties: true,
			}),
		).toEqual({
			type: "object",
			properties: {},
			required: [],
			additionalProperties: true,
		});

		expect(
			actionParameterSchemaToJsonSchema(
				{
					type: "object",
					additionalProperties: { type: "string", minLength: 1 },
				},
				{ path: "bag" },
			),
		).toEqual({
			type: "object",
			properties: {},
			required: [],
			additionalProperties: { type: "string", minLength: 1 },
		});

		expect(() =>
			actionParameterSchemaToJsonSchema(
				{
					type: "object",
					additionalProperties: { type: "date" },
				},
				{ path: "bag" },
			),
		).toThrow("Unsupported schema type 'date' for action parameter 'bag.*'");
	});

	it("does not treat a boolean required on the object itself as a required-name list", () => {
		expect(
			actionParameterSchemaToJsonSchema({
				type: "object",
				required: true,
				properties: { name: { type: "string" } },
			} as unknown as ActionParameterSchema),
		).toEqual({
			type: "object",
			properties: { name: { type: "string" } },
			required: [],
			additionalProperties: false,
		});
	});

	it("recurses into nested objects and names child paths in errors", () => {
		expect(
			actionParameterSchemaToJsonSchema(
				{
					type: "object",
					properties: {
						window: {
							type: "object",
							properties: { days: { type: "integer" } },
							required: ["days"],
						},
					},
				},
				{ path: "config" },
			),
		).toEqual({
			type: "object",
			properties: {
				window: {
					type: "object",
					properties: { days: { type: "integer" } },
					required: ["days"],
					additionalProperties: false,
				},
			},
			required: [],
			additionalProperties: false,
		});

		expect(() =>
			actionParameterSchemaToJsonSchema(
				{
					type: "object",
					properties: { inner: { type: "date" } },
				},
				{ path: "config" },
			),
		).toThrow(
			"Unsupported schema type 'date' for action parameter 'config.inner'",
		);
	});

	it("converts array items, defaulting missing items to string, and names item paths", () => {
		expect(actionParameterSchemaToJsonSchema({ type: "array" })).toEqual({
			type: "array",
			items: { type: "string" },
		});

		expect(() =>
			actionParameterSchemaToJsonSchema(
				{ type: "array", items: { type: "date" } },
				{ path: "tags" },
			),
		).toThrow("Unsupported schema type 'date' for action parameter 'tags[]'");
	});
});

describe("actionToJsonSchema", () => {
	it("uses the action's parameters and additional-parameter policy", () => {
		const action = {
			name: "SEND",
			parameters: [param({ name: "text", required: true })],
			allowAdditionalParameters: true,
		} as unknown as Action;
		expect(actionToJsonSchema(action)).toMatchObject({
			type: "object",
			required: ["text"],
			additionalProperties: true,
		});
	});

	it("treats an action with no parameters as a closed empty object", () => {
		expect(actionToJsonSchema({ name: "NOOP" } as unknown as Action)).toEqual({
			type: "object",
			properties: {},
			required: [],
			additionalProperties: false,
		});
	});

	it("does not treat a non-true allowAdditionalParameters as open", () => {
		expect(
			actionToJsonSchema({
				name: "CLOSED",
				allowAdditionalParameters: false,
				parameters: [],
			} as unknown as Action).additionalProperties,
		).toBe(false);
	});
});

describe("normalizeActionJsonSchema", () => {
	it("re-emits an action's parameters in the core shape without losing structure", () => {
		const normalized = normalizeActionJsonSchema({
			parameters: [
				param({ name: "text", required: true, description: "body" }),
				param({
					name: "count",
					schema: { type: "integer" },
				} as Partial<ActionParameter>),
			],
		} as Pick<Action, "parameters" | "allowAdditionalParameters">);
		expect(normalized).toMatchObject({
			type: "object",
			required: ["text"],
			properties: {
				text: { type: "string" },
				count: { type: "integer" },
			},
		});
	});

	it("preserves nested array item structure", () => {
		const normalized = normalizeActionJsonSchema({
			parameters: [
				param({
					name: "items",
					schema: { type: "array", items: { type: "string" } },
				} as Partial<ActionParameter>),
			],
		} as Pick<Action, "parameters" | "allowAdditionalParameters">);
		expect(
			(normalized.properties as Record<string, { items?: unknown }>).items
				?.items,
		).toMatchObject({ type: "string" });
	});

	it("carries the additional-parameter policy through", () => {
		expect(
			normalizeActionJsonSchema({
				parameters: [],
				allowAdditionalParameters: true,
			} as Pick<Action, "parameters" | "allowAdditionalParameters">)
				.additionalProperties,
		).toBe(true);
		expect(
			normalizeActionJsonSchema({ parameters: [] } as Pick<
				Action,
				"parameters" | "allowAdditionalParameters"
			>).additionalProperties,
		).toBe(false);
	});

	it("re-emits nested objects, unions, and additionalProperties schemas", () => {
		const schema = normalizeActionJsonSchema({
			allowAdditionalParameters: false,
			parameters: [
				{
					name: "config",
					description: "cfg",
					required: true,
					schema: {
						type: "object",
						properties: {
							name: { type: "string", minLength: 1 },
							choice: {
								oneOf: [{ type: "string" }, { type: "integer" }],
							},
							flag: {
								anyOf: [{ type: "boolean" }, { type: "string" }],
							},
						},
						required: ["name"],
						additionalProperties: { type: "number", minimum: 0 },
					},
				},
				{
					name: "tags",
					description: "tags",
					schema: {
						type: "array",
						items: { type: "string", enum: ["a", "b"] },
					},
				},
			],
		});

		expect(schema.type).toBe("object");
		expect(schema.additionalProperties).toBe(false);
		expect(schema.required).toEqual(["config"]);

		const config = schema.properties?.config as {
			type?: string;
			required?: string[];
			additionalProperties?: { type?: string; minimum?: number };
			properties?: Record<string, unknown>;
		};
		expect(config.type).toBe("object");
		expect(config.required).toEqual(["name"]);
		expect(config.additionalProperties).toEqual({
			type: "number",
			minimum: 0,
		});
		expect(config.properties?.choice).toEqual({
			oneOf: [{ type: "string" }, { type: "integer" }],
		});
		expect(config.properties?.flag).toEqual({
			anyOf: [{ type: "boolean" }, { type: "string" }],
		});
		expect(schema.properties?.tags).toEqual({
			type: "array",
			description: "tags",
			items: { type: "string", enum: ["a", "b"] },
		});
	});

	it("copies defaults, numeric bounds, and pattern through the core JSONSchema walk", () => {
		const schema = normalizeActionJsonSchema({
			parameters: [
				{
					name: "count",
					description: "n",
					schema: {
						type: "integer",
						minimum: 1,
						maximum: 9,
						default: 3,
					},
				},
				{
					name: "code",
					description: "c",
					schema: {
						type: "string",
						minLength: 2,
						maxLength: 4,
						pattern: "^[A-Z]+$",
						default: "AB",
					},
				},
			],
		});
		expect(schema.properties?.count).toEqual({
			type: "integer",
			description: "n",
			minimum: 1,
			maximum: 9,
			default: 3,
		});
		expect(schema.properties?.code).toEqual({
			type: "string",
			description: "c",
			minLength: 2,
			maxLength: 4,
			pattern: "^[A-Z]+$",
			default: "AB",
		});
	});
});
