/**
 * Unit coverage for the local-inference engine fallback surface: GPU-layer
 * resolution from load args, and the renderer no-op engine that always
 * reports unavailable and rejects load/generate with the registration hint.
 * Real module under vitest, node environment, no mocks or filesystem.
 */
import { describe, expect, it } from "vitest";
import {
  gpuLayersForKvOffload,
  LocalInferenceEngine,
  localInferenceEngine,
  resolveGpuLayersForLoad,
} from "./engine";

describe("gpuLayersForKvOffload", () => {
  it("maps the cpu placement to zero offloaded layers", () => {
    expect(gpuLayersForKvOffload("cpu")).toBe(0);
  });

  it("maps the gpu placement to max offloaded layers", () => {
    expect(gpuLayersForKvOffload("gpu")).toBe("max");
  });

  it("maps the split placement to backend-probed auto", () => {
    expect(gpuLayersForKvOffload("split")).toBe("auto");
  });

  it("passes an explicit layer count through unchanged", () => {
    expect(gpuLayersForKvOffload({ gpuLayers: 16 })).toBe(16);
    expect(gpuLayersForKvOffload({ gpuLayers: 0 })).toBe(0);
  });
});

describe("resolveGpuLayersForLoad", () => {
  it("falls back to auto when nothing was resolved", () => {
    expect(resolveGpuLayersForLoad(undefined)).toBe("auto");
  });

  it("falls back to auto for a resolution without any gpu hints", () => {
    expect(resolveGpuLayersForLoad({ modelPath: "/models/qwen.gguf" })).toBe(
      "auto",
    );
  });

  it("honours an explicit layer count", () => {
    expect(
      resolveGpuLayersForLoad({
        modelPath: "/models/qwen.gguf",
        gpuLayers: 32,
      }),
    ).toBe(32);
  });

  it("honours an explicit layer count of zero", () => {
    expect(
      resolveGpuLayersForLoad({ modelPath: "/models/qwen.gguf", gpuLayers: 0 }),
    ).toBe(0);
  });

  it.each(["cpu", "gpu", "split"] as const)(
    "derives the layer count from a %s kv-offload placement",
    (mode) => {
      expect(
        resolveGpuLayersForLoad({
          modelPath: "/models/qwen.gguf",
          kvOffload: mode,
        }),
      ).toBe(gpuLayersForKvOffload(mode));
    },
  );

  it("derives the layer count from an object kv-offload placement", () => {
    expect(
      resolveGpuLayersForLoad({
        modelPath: "/models/qwen.gguf",
        kvOffload: { gpuLayers: 8 },
      }),
    ).toBe(8);
  });

  it("prefers an explicit layer count over the kv-offload placement", () => {
    expect(
      resolveGpuLayersForLoad({
        modelPath: "/models/qwen.gguf",
        gpuLayers: 4,
        kvOffload: "cpu",
      }),
    ).toBe(4);
  });

  it("maps useGpu=false to zero layers", () => {
    expect(
      resolveGpuLayersForLoad({
        modelPath: "/models/qwen.gguf",
        useGpu: false,
      }),
    ).toBe(0);
  });

  it("resolves useGpu=true to backend-probed auto", () => {
    expect(
      resolveGpuLayersForLoad({ modelPath: "/models/qwen.gguf", useGpu: true }),
    ).toBe("auto");
  });

  it("prefers the kv-offload placement over useGpu=false", () => {
    expect(
      resolveGpuLayersForLoad({
        modelPath: "/models/qwen.gguf",
        kvOffload: "gpu",
        useGpu: false,
      }),
    ).toBe("max");
  });
});

describe("LocalInferenceEngine renderer fallback", () => {
  it("reports itself unavailable", async () => {
    const engine = new LocalInferenceEngine();

    await expect(engine.available()).resolves.toBe(false);
  });

  it("reports no current model path and no loaded model", () => {
    const engine = new LocalInferenceEngine();

    expect(engine.currentModelPath()).toBeNull();
    expect(engine.hasLoadedModel()).toBe(false);
  });

  it("unloads cleanly even though nothing was loaded", async () => {
    const engine = new LocalInferenceEngine();

    await expect(engine.unload()).resolves.toBeUndefined();
  });

  it("rejects load with the register-a-loader guidance", async () => {
    const engine = new LocalInferenceEngine();

    await expect(engine.load("/models/qwen.gguf")).rejects.toThrowError(
      /Local inference runs in the Eliza agent/,
    );
  });

  it("rejects load with resolved args using the same guidance", async () => {
    const engine = new LocalInferenceEngine();
    const loadPromise = engine.load("/models/qwen.gguf", {
      modelPath: "/models/qwen.gguf",
      gpuLayers: 8,
    });
    const generatePromise = engine.generate({ prompt: "hello" });

    await expect(loadPromise).rejects.toThrowError(
      /Local inference runs in the Eliza agent/,
    );
    await expect(generatePromise).rejects.toThrowError(
      /Local inference runs in the Eliza agent/,
    );
  });

  it("exposes the shared singleton with the same unavailable fallback", async () => {
    expect(localInferenceEngine).toBeInstanceOf(LocalInferenceEngine);
    await expect(localInferenceEngine.available()).resolves.toBe(false);
    expect(localInferenceEngine.currentModelPath()).toBeNull();
    await expect(
      localInferenceEngine.generate({ prompt: "hello", maxTokens: 8 }),
    ).rejects.toThrowError(/Local inference runs in the Eliza agent/);
  });
});
