/**
 * Unit tests for ConfidenceDecayManager (deterministic, no mocks, no runtime):
 * grace-period passthrough, half-life decay, per-type and per-domain config
 * multipliers, the reinforcement filter's threshold/floor bounds, boost
 * capping, and the confidence-trend shape. Recall ranking consumes these
 * numbers, so the floors and multipliers are pinned exactly.
 */
import { describe, expect, it } from "vitest";
import type { Experience } from "../types";
import { ExperienceType, OutcomeType } from "../types";
import { ConfidenceDecayManager } from "./confidenceDecay.ts";

const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_HALF_LIFE = 30 * DAY;
const DEFAULT_MIN_CONFIDENCE = 0.1;
const GRACE_PERIOD = 7 * DAY;

const NOW = Date.now();
const ageDaysAgo = (days: number) => NOW - days * DAY;
const futureStamp = () => NOW + DAY;

const exp = (o: Partial<Experience>): Experience =>
	({
		type: ExperienceType.SUCCESS,
		outcome: OutcomeType.POSITIVE,
		domain: "general",
		action: "do_thing",
		context: "ctx",
		result: "res",
		learning: "learned something useful",
		confidence: 0.8,
		importance: 0.5,
		tags: [],
		keywords: [],
		createdAt: ageDaysAgo(1),
		updatedAt: ageDaysAgo(1),
		accessCount: 0,
		id: "00000000-0000-4000-8000-000000000001",
		agentId: "00000000-0000-4000-8000-000000000002",
		associatedEntityIds: [],
		...o,
	}) as unknown as Experience;

describe("getDomainSpecificDecay", () => {
	it("returns the default config untouched for a plain success", () => {
		const config = new ConfidenceDecayManager().getDomainSpecificDecay(exp({}));
		expect(config).toEqual({
			halfLife: DEFAULT_HALF_LIFE,
			minConfidence: DEFAULT_MIN_CONFIDENCE,
			decayStartDelay: GRACE_PERIOD,
		});
	});

	it("doubles the half-life for discoveries and learnings", () => {
		const manager = new ConfidenceDecayManager();
		for (const type of [ExperienceType.DISCOVERY, ExperienceType.LEARNING]) {
			expect(manager.getDomainSpecificDecay(exp({ type })).halfLife).toBe(
				DEFAULT_HALF_LIFE * 2,
			);
		}
	});

	it("slows warnings and corrections and raises their floor to 0.2", () => {
		const manager = new ConfidenceDecayManager();
		for (const type of [ExperienceType.WARNING, ExperienceType.CORRECTION]) {
			const config = manager.getDomainSpecificDecay(exp({ type }));
			expect(config.halfLife).toBe(DEFAULT_HALF_LIFE * 1.5);
			expect(config.minConfidence).toBe(0.2);
		}
	});

	it("triples the half-life and raises the floor to 0.3 for safety domains", () => {
		const manager = new ConfidenceDecayManager();
		for (const domain of ["security", "safety"]) {
			const config = manager.getDomainSpecificDecay(exp({ domain }));
			expect(config.halfLife).toBe(DEFAULT_HALF_LIFE * 3);
			expect(config.minConfidence).toBe(0.3);
		}
	});

	it("lets the security domain override a warning's raised floor", () => {
		const config = new ConfidenceDecayManager().getDomainSpecificDecay(
			exp({ type: ExperienceType.WARNING, domain: "security" }),
		);
		expect(config.halfLife).toBe(DEFAULT_HALF_LIFE * 1.5 * 3);
		expect(config.minConfidence).toBe(0.3);
	});

	it("halves the half-life for performance and shortens it for user_preference", () => {
		const manager = new ConfidenceDecayManager();
		expect(
			manager.getDomainSpecificDecay(exp({ domain: "performance" })).halfLife,
		).toBe(DEFAULT_HALF_LIFE * 0.5);
		expect(
			manager.getDomainSpecificDecay(exp({ domain: "user_preference" }))
				.halfLife,
		).toBe(DEFAULT_HALF_LIFE * 0.7);
	});

	it("applies multipliers on top of constructor-provided config values", () => {
		const config = new ConfidenceDecayManager({
			halfLife: 1000,
			minConfidence: 0.05,
			decayStartDelay: 500,
		}).getDomainSpecificDecay(exp({ type: ExperienceType.DISCOVERY }));
		expect(config.halfLife).toBe(2000);
		expect(config.minConfidence).toBe(0.05);
		expect(config.decayStartDelay).toBe(500);
	});

	it("returns a copy that does not leak mutations into later calls", () => {
		const manager = new ConfidenceDecayManager();
		const first = manager.getDomainSpecificDecay(
			exp({ type: ExperienceType.DISCOVERY }),
		);
		first.halfLife = 1;
		first.minConfidence = 0.99;
		const second = manager.getDomainSpecificDecay(
			exp({ type: ExperienceType.DISCOVERY }),
		);
		expect(second.halfLife).toBe(DEFAULT_HALF_LIFE * 2);
		expect(second.minConfidence).toBe(DEFAULT_MIN_CONFIDENCE);
	});
});

describe("getDecayedConfidence", () => {
	it("returns the original confidence during the grace period", () => {
		expect(
			new ConfidenceDecayManager().getDecayedConfidence(
				exp({ confidence: 0.55, createdAt: ageDaysAgo(6) }),
			),
		).toBe(0.55);
	});

	it("treats a future createdAt as inside the grace period", () => {
		expect(
			new ConfidenceDecayManager().getDecayedConfidence(
				exp({ confidence: 0.42, createdAt: futureStamp() }),
			),
		).toBe(0.42);
	});

	it("decays past the grace period along the half-life curve", () => {
		const decayed = new ConfidenceDecayManager().getDecayedConfidence(
			exp({ confidence: 0.8, createdAt: ageDaysAgo(8) }),
		);
		expect(decayed).toBeCloseTo(0.8 * 0.5 ** (DAY / DEFAULT_HALF_LIFE), 4);
	});

	it("halves the confidence one half-life after the grace period ends", () => {
		const decayed = new ConfidenceDecayManager().getDecayedConfidence(
			exp({ confidence: 0.8, createdAt: ageDaysAgo(37) }),
		);
		expect(decayed).toBeCloseTo(0.4, 4);
	});

	it("never decays below the configured minimum", () => {
		expect(
			new ConfidenceDecayManager().getDecayedConfidence(
				exp({ confidence: 0.8, createdAt: ageDaysAgo(3650) }),
			),
		).toBe(DEFAULT_MIN_CONFIDENCE);
	});

	it("honors a custom constructor floor", () => {
		const manager = new ConfidenceDecayManager({
			halfLife: DAY,
			minConfidence: 0.25,
		});
		expect(
			manager.getDecayedConfidence(
				exp({ confidence: 0.9, createdAt: ageDaysAgo(3650) }),
			),
		).toBe(0.25);
	});

	it("applies the raised warning floor to heavily aged warnings", () => {
		expect(
			new ConfidenceDecayManager().getDecayedConfidence(
				exp({
					type: ExperienceType.WARNING,
					confidence: 0.9,
					createdAt: ageDaysAgo(3650),
				}),
			),
		).toBe(0.2);
	});
});

describe("getExperiencesNeedingReinforcement", () => {
	it("returns an empty list for an empty set", () => {
		expect(
			new ConfidenceDecayManager().getExperiencesNeedingReinforcement([]),
		).toEqual([]);
	});

	it("keeps experiences whose decayed confidence fell below the threshold but above the floor", () => {
		const stale = exp({ confidence: 0.8, createdAt: ageDaysAgo(50) });
		const fresh = exp({ confidence: 0.8, createdAt: ageDaysAgo(1) });
		const filtered =
			new ConfidenceDecayManager().getExperiencesNeedingReinforcement([
				fresh,
				stale,
			]);
		expect(filtered).toHaveLength(1);
		expect(filtered[0]).toBe(stale);
	});

	it("drops experiences that have already decayed down to the floor", () => {
		const floored = exp({ confidence: 0.8, createdAt: ageDaysAgo(3650) });
		expect(
			new ConfidenceDecayManager().getExperiencesNeedingReinforcement([
				floored,
			]),
		).toEqual([]);
	});

	it("preserves input order across multiple matches", () => {
		// both decay into the (floor, threshold) band: ~0.235 and ~0.183
		const first = exp({ confidence: 0.8, createdAt: ageDaysAgo(60) });
		const second = exp({ confidence: 0.7, createdAt: ageDaysAgo(65) });
		const filtered =
			new ConfidenceDecayManager().getExperiencesNeedingReinforcement([
				first,
				exp({ createdAt: ageDaysAgo(0) }),
				second,
			]);
		expect(filtered).toEqual([first, second]);
	});

	it("accepts a custom threshold", () => {
		const moderatelyAged = exp({ confidence: 0.8, createdAt: ageDaysAgo(12) });
		const filtered =
			new ConfidenceDecayManager().getExperiencesNeedingReinforcement(
				[moderatelyAged],
				0.75,
			);
		expect(filtered).toEqual([moderatelyAged]);
	});
});

describe("calculateReinforcementBoost", () => {
	it("leaves fully confident experiences unchanged", () => {
		expect(
			new ConfidenceDecayManager().calculateReinforcementBoost(
				exp({ confidence: 1, createdAt: ageDaysAgo(1) }),
			),
		).toBe(1);
	});

	it("adds half the gap to full confidence for a fresh experience", () => {
		expect(
			new ConfidenceDecayManager().calculateReinforcementBoost(
				exp({ confidence: 0.6, createdAt: ageDaysAgo(1) }),
			),
		).toBeCloseTo(0.8, 10);
	});

	it("boosts from the decayed confidence, not the stored one", () => {
		const boosted = new ConfidenceDecayManager().calculateReinforcementBoost(
			exp({ confidence: 0.8, createdAt: ageDaysAgo(37) }),
		);
		expect(boosted).toBeCloseTo(0.7, 4);
	});

	it("caps the boosted confidence at 1", () => {
		expect(
			new ConfidenceDecayManager().calculateReinforcementBoost(
				exp({ confidence: 0.6, createdAt: ageDaysAgo(1) }),
				3,
			),
		).toBe(1);
	});

	it("scales linearly with validation strength", () => {
		expect(
			new ConfidenceDecayManager().calculateReinforcementBoost(
				exp({ confidence: 0.6, createdAt: ageDaysAgo(1) }),
				2,
			),
		).toBeCloseTo(1, 10);
	});
});

describe("getConfidenceTrend", () => {
	it("produces the requested number of evenly spaced points ending at now", () => {
		const createdAt = ageDaysAgo(20);
		const trend = new ConfidenceDecayManager().getConfidenceTrend(
			exp({ confidence: 0.8, createdAt }),
		);
		expect(trend).toHaveLength(10);
		const interval = (Date.now() - createdAt) / 9;
		expect(trend[0].timestamp).toBeCloseTo(createdAt, -3);
		expect(trend[9].timestamp).toBeCloseTo(createdAt + interval * 9, -3);
		for (let i = 1; i < trend.length; i++) {
			expect(trend[i].timestamp).toBeGreaterThan(trend[i - 1].timestamp);
		}
	});

	it("starts flat at the original confidence before the grace period ends", () => {
		const createdAt = ageDaysAgo(20);
		const trend = new ConfidenceDecayManager().getConfidenceTrend(
			exp({ confidence: 0.8, createdAt }),
			21,
		);
		expect(trend).toHaveLength(21);
		expect(trend[3].confidence).toBe(0.8);
		// the boundary sample sits a hair past the grace period, so it has
		// already begun decaying by an amount far below assertion precision
		expect(trend[7].confidence).toBeCloseTo(0.8, 6);
		expect(trend[8].confidence).toBeLessThan(0.8);
	});

	it("ends at the current decayed confidence", () => {
		const experience = exp({ confidence: 0.8, createdAt: ageDaysAgo(37) });
		const manager = new ConfidenceDecayManager();
		const trend = manager.getConfidenceTrend(experience);
		expect(trend[trend.length - 1].confidence).toBeCloseTo(
			manager.getDecayedConfidence(experience),
			4,
		);
	});

	it("is monotonically non-increasing once decay starts", () => {
		const trend = new ConfidenceDecayManager().getConfidenceTrend(
			exp({ confidence: 0.9, createdAt: ageDaysAgo(90) }),
		);
		for (let i = 1; i < trend.length; i++) {
			expect(trend[i].confidence).toBeLessThanOrEqual(trend[i - 1].confidence);
		}
	});

	it("respects a custom point count", () => {
		const trend = new ConfidenceDecayManager().getConfidenceTrend(
			exp({ createdAt: ageDaysAgo(10) }),
			3,
		);
		expect(trend).toHaveLength(3);
	});
});
