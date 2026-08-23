/**
 * Unit coverage for the ATTACHMENT action's exported surface that no sibling
 * suite records yet: the remaining readAttachmentActionKind normalization
 * edges (`op` alias, alias precedence, case/space folding, non-string input),
 * the completeAttachmentContent identity pass-through, and the static action
 * metadata contract (role gate, delivery suppression, parameter schemas).
 * Pure-function assertions against the real module — no runtime or model.
 */
import { describe, expect, it } from "vitest";
import {
	completeAttachmentContent,
	readAttachmentAction,
	default as readAttachmentActionDefault,
	readAttachmentActionKind,
} from "./readAttachmentAction.ts";

describe("readAttachmentActionKind alias resolution", () => {
	it("resolves the operation from the `op` alias key alone", () => {
		expect(readAttachmentActionKind({ op: "read" })).toBe("read");
		expect(readAttachmentActionKind({ op: "save_as_document" })).toBe(
			"save_as_document",
		);
	});

	it("prefers `action` over `subaction` over `op` when several are present", () => {
		expect(
			readAttachmentActionKind({
				action: "read",
				subaction: "save_as_document",
				op: "save_as_document",
			}),
		).toBe("read");
		expect(
			readAttachmentActionKind({
				subaction: "save_as_document",
				op: "read",
			}),
		).toBe("save_as_document");
	});

	it("folds casing, surrounding whitespace, and separators into the enum", () => {
		expect(readAttachmentActionKind({ action: "READ" })).toBe("read");
		expect(readAttachmentActionKind({ action: "  read  " })).toBe("read");
		expect(readAttachmentActionKind({ action: "Save As Document" })).toBe(
			"save_as_document",
		);
		expect(readAttachmentActionKind({ action: "SAVE-as-document" })).toBe(
			"save_as_document",
		);
	});

	it("treats non-string action values as absent and defaults to read", () => {
		expect(readAttachmentActionKind({ action: 42 })).toBe("read");
		expect(readAttachmentActionKind({ action: true })).toBe("read");
		expect(readAttachmentActionKind({ action: null })).toBe("read");
		expect(readAttachmentActionKind({ action: ["read"] })).toBe("read");
	});
});

describe("completeAttachmentContent passes content through unchanged", () => {
	it("returns prose byte-for-byte", () => {
		const page = "First line of extracted text.\nSecond line.\n\nTail.";
		expect(completeAttachmentContent(page)).toBe(page);
	});

	it("preserves the empty string and multibyte content exactly", () => {
		expect(completeAttachmentContent("")).toBe("");
		const multibyte = "héllo — 世界 🌍 transcript";
		expect(completeAttachmentContent(multibyte)).toBe(multibyte);
	});
});

describe("readAttachmentAction static surface contract", () => {
	it("is the same object as the default export, named ATTACHMENT", () => {
		expect(readAttachmentActionDefault).toBe(readAttachmentAction);
		expect(readAttachmentAction.name).toBe("ATTACHMENT");
	});

	it("keeps the ADMIN role gate and single-delivery turn control", () => {
		expect(readAttachmentAction.roleGate).toEqual({ minRole: "ADMIN" });
		expect(readAttachmentAction.suppressPostActionContinuation).toBe(true);
	});

	it("declares its routing contexts and similes verbatim", () => {
		expect(readAttachmentAction.contexts).toEqual([
			"general",
			"files",
			"media",
			"messaging",
			"documents",
			"web",
		]);
		expect(readAttachmentAction.similes).toEqual([
			"SAVE_ATTACHMENT_AS_DOCUMENT",
			"OPEN_ATTACHMENT",
			"INSPECT_ATTACHMENT",
			"READ_URL",
			"OPEN_URL",
			"READ_WEBPAGE",
		]);
	});

	it("publishes the planner-facing parameter schemas", () => {
		const byName = new Map(
			readAttachmentAction.parameters.map((parameter) => [
				parameter.name,
				parameter,
			]),
		);
		expect([...byName.keys()]).toEqual([
			"action",
			"attachmentId",
			"offset",
			"limit",
			"expectedRevision",
			"addToClipboard",
		]);
		expect(byName.get("action")?.schema).toEqual({
			type: "string",
			enum: ["read", "save_as_document"],
		});
		expect(byName.get("attachmentId")?.schema).toEqual({ type: "string" });
		expect(byName.get("offset")?.schema).toEqual({
			type: "number",
			minimum: 0,
		});
		expect(byName.get("limit")?.schema).toEqual({
			type: "number",
			minimum: 1,
			maximum: 64 * 1024,
		});
		expect(byName.get("expectedRevision")?.schema).toEqual({
			type: "string",
		});
		expect(byName.get("addToClipboard")?.schema).toEqual({
			type: "boolean",
			default: false,
		});
	});
});
