/**
 * Verifies production service startup ordering and ownership with real runtime
 * lifecycle calls. Implementations launch concurrently, readiness drains the
 * whole set, and plugin teardown targets instances by class rather than timing.
 */

import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../runtime";
import { Service } from "../types/service";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

describe("AgentRuntime service startup", () => {
	it("starts cross-plugin siblings once in parallel and preserves registration order", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
		const firstStartup = deferred<FirstService>();
		const secondStartup = deferred<SecondService>();
		const starts: string[] = [];
		const stops: string[] = [];

		class FirstService extends Service {
			static override serviceType = "parallel-start-test";
			static override allowsMultiple = true;
			capabilityDescription = "first registered implementation";

			static override async start(): Promise<FirstService> {
				starts.push("first");
				return firstStartup.promise;
			}

			override async stop(): Promise<void> {
				stops.push("first");
			}
		}

		class SecondService extends Service {
			static override serviceType = "parallel-start-test";
			static override allowsMultiple = true;
			capabilityDescription = "second registered implementation";

			static override async start(): Promise<SecondService> {
				starts.push("second");
				return secondStartup.promise;
			}

			override async stop(): Promise<void> {
				stops.push("second");
			}
		}

		try {
			await runtime.registerPlugin({
				name: "parallel-start-first",
				description: "Registers the first implementation",
				services: [FirstService],
			});
			await runtime.registerPlugin({
				name: "parallel-start-second",
				description: "Registers the second implementation",
				services: [SecondService],
			});

			const firstLoad = runtime.getServiceLoadPromise(FirstService.serviceType);
			const concurrentLoad = runtime.getServiceLoadPromise(
				FirstService.serviceType,
			);
			await Promise.resolve();
			expect(starts.sort()).toEqual(["first", "second"]);

			let ready = false;
			void firstLoad.then(() => {
				ready = true;
			});
			const second = new SecondService(runtime);
			secondStartup.resolve(second);
			await secondStartup.promise;
			await Promise.resolve();
			expect(ready).toBe(false);

			const first = new FirstService(runtime);
			firstStartup.resolve(first);
			await expect(Promise.all([firstLoad, concurrentLoad])).resolves.toEqual([
				first,
				first,
			]);
			expect(runtime.getServicesByType(FirstService.serviceType)).toEqual([
				first,
				second,
			]);
			expect(starts.sort()).toEqual(["first", "second"]);

			await runtime.unloadPlugin("parallel-start-first");
			expect(stops).toEqual(["first"]);
			expect(runtime.getServicesByType(FirstService.serviceType)).toEqual([
				second,
			]);
		} finally {
			await runtime.stop({ fast: true });
		}
	});
});
