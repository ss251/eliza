import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  markDeferredBootPhase: vi.fn(),
}));

vi.mock("@elizaos/core", () => ({
  logger: { info: vi.fn() },
}));
vi.mock("@elizaos/agent/runtime/deferred-boot-status", () => ({
  markDeferredBootPhase: mocks.markDeferredBootPhase,
}));

import {
  createRuntimeBootResources,
  type PostReadyBootSteps,
  runPostReadyBootTail,
} from "./startup/post-ready.ts";

function makeSteps(order: string[]): PostReadyBootSteps {
  return {
    registerAppRoutePlugins: async () => {
      order.push("appRoutes");
    },
    registerRuntimeHooks: async () => {
      order.push("runtimeHooks");
    },
    registerCoreSensitiveRequestAdapters: () => order.push("sensitive"),
    registerSubAgentCredentialBridgeAdapter: () => {
      order.push("credentialBridgeAdapter");
      return true;
    },
    registerSubAgentCredentialBridge: async () => {
      order.push("credentialBridgeWiring");
    },
    ensureTriggerEventBridge: async () => {
      order.push("triggerBridge");
    },
    ensureConnectorTargetCatalog: async () => {
      order.push("catalog");
    },
    startDeferredVoiceWarmup: () => order.push("voiceWarmup"),
  };
}

describe("post-ready tail liveness", () => {
  beforeEach(() => {
    mocks.markDeferredBootPhase.mockClear();
  });

  it("stops after an awaited contributor when teardown clears ownership", async () => {
    const runtime = {} as never;
    const resources = createRuntimeBootResources();
    resources.tailRuntime = runtime;
    const order: string[] = [];
    const steps = makeSteps(order);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    steps.registerAppRoutePlugins = async () => {
      order.push("appRoutes:start");
      await firstGate;
      order.push("appRoutes:end");
    };

    const tail = runPostReadyBootTail(runtime, steps, resources);
    await vi.waitFor(() => expect(order).toEqual(["appRoutes:start"]));
    resources.tailRuntime = null;
    releaseFirst();
    await tail;

    expect(order).toEqual(["appRoutes:start", "appRoutes:end"]);
    expect(mocks.markDeferredBootPhase).not.toHaveBeenCalled();
  });

  it("ignores a contributor rejection that settles after teardown", async () => {
    const runtime = {} as never;
    const resources = createRuntimeBootResources();
    resources.tailRuntime = runtime;
    const order: string[] = [];
    const steps = makeSteps(order);
    let rejectFirst!: (error: Error) => void;
    const firstGate = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    steps.registerAppRoutePlugins = async () => {
      order.push("appRoutes:start");
      await firstGate;
    };

    const tail = runPostReadyBootTail(runtime, steps, resources);
    await vi.waitFor(() => expect(order).toEqual(["appRoutes:start"]));
    resources.tailRuntime = null;
    rejectFirst(new Error("stale app-route failure"));

    await expect(tail).resolves.toBeUndefined();
    expect(order).toEqual(["appRoutes:start"]);
    expect(mocks.markDeferredBootPhase).not.toHaveBeenCalled();
  });

  it("preserves the complete and initially-superseded valid-input corpus", async () => {
    const outputs: Array<{
      case: string;
      order: string[];
      completions: number;
    }> = [];
    for (const currentOwner of [true, true, false]) {
      mocks.markDeferredBootPhase.mockClear();
      const runtime = {} as never;
      const resources = createRuntimeBootResources();
      resources.tailRuntime = currentOwner ? runtime : ({} as never);
      const order: string[] = [];

      await runPostReadyBootTail(runtime, makeSteps(order), resources);
      outputs.push({
        case: currentOwner ? `live-${outputs.length + 1}` : "superseded",
        order,
        completions: mocks.markDeferredBootPhase.mock.calls.length,
      });
    }

    console.log(JSON.stringify(outputs));
    expect(outputs).toEqual([
      {
        case: "live-1",
        order: [
          "appRoutes",
          "runtimeHooks",
          "sensitive",
          "credentialBridgeAdapter",
          "credentialBridgeWiring",
          "triggerBridge",
          "catalog",
          "voiceWarmup",
        ],
        completions: 1,
      },
      {
        case: "live-2",
        order: [
          "appRoutes",
          "runtimeHooks",
          "sensitive",
          "credentialBridgeAdapter",
          "credentialBridgeWiring",
          "triggerBridge",
          "catalog",
          "voiceWarmup",
        ],
        completions: 1,
      },
      { case: "superseded", order: [], completions: 0 },
    ]);
  });
});
