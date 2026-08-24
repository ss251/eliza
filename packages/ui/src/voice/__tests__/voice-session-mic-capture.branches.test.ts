/**
 * Supplementary branch coverage for the voice-session mic capture: typed
 * getUserMedia error mapping, abort-before/after-start teardown edges, the
 * AudioWorklet uplink data path, and framing/resampler corner inputs. Drives
 * the real capture through the shared fakes and pairs with
 * voice-session-mic-capture.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hasAudioWorkletSupport,
  startVoiceMicCapture,
  VoiceMicCaptureError,
} from "../voice-session-mic-capture";
import { int16BytesToFloatPcm } from "../voice-session-pcm";
import {
  FakeMicAudioContext,
  FakeMicWorkletAudioContext,
  FakeVoiceAudioWorkletNode,
  fakeGetUserMedia,
} from "./voice-session-fakes";

/** No-op visibility source that never reports hidden. */
function visibleVisibility(): {
  addListener: (l: () => void) => void;
  removeListener: (l: () => void) => void;
  isHidden: () => boolean;
} {
  return {
    addListener() {},
    removeListener() {},
    isHidden: () => false,
  };
}

/** A getUserMedia double that rejects with a DOMError-style named error. */
function gumRejecting(
  name: string,
): (constraints: MediaStreamConstraints) => Promise<MediaStream> {
  return async () => {
    const err = new Error(`${name} raised by host`);
    err.name = name;
    throw err;
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeVoiceAudioWorkletNode.reset();
});

describe("voice-session mic capture — supplementary branches", () => {
  it("maps a NotFoundError rejection to the typed no_device error", async () => {
    await expect(
      startVoiceMicCapture({
        onFrame: () => {},
        getUserMedia: gumRejecting("NotFoundError"),
        visibility: visibleVisibility(),
      }),
    ).rejects.toMatchObject({
      name: "VoiceMicCaptureError",
      code: "no_device",
    });
  });

  it("maps an OverconstrainedError rejection to the typed no_device error", async () => {
    await expect(
      startVoiceMicCapture({
        onFrame: () => {},
        getUserMedia: gumRejecting("OverconstrainedError"),
        visibility: visibleVisibility(),
      }),
    ).rejects.toMatchObject({
      name: "VoiceMicCaptureError",
      code: "no_device",
    });
  });

  it("maps a SecurityError rejection to permission_denied", async () => {
    await expect(
      startVoiceMicCapture({
        onFrame: () => {},
        getUserMedia: gumRejecting("SecurityError"),
        visibility: visibleVisibility(),
      }),
    ).rejects.toMatchObject({
      name: "VoiceMicCaptureError",
      code: "permission_denied",
    });
  });

  it("wraps an unknown getUserMedia failure as start_failed and preserves the cause", async () => {
    const failure = await startVoiceMicCapture({
      onFrame: () => {},
      getUserMedia: gumRejecting("SomeWeirdHostError"),
      visibility: visibleVisibility(),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(VoiceMicCaptureError);
    const captureError = failure as VoiceMicCaptureError;
    expect(captureError.code).toBe("start_failed");
    expect((captureError.cause as Error | undefined)?.message).toBe(
      "SomeWeirdHostError raised by host",
    );
  });

  it("rejects before touching getUserMedia when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const gum = vi.fn(fakeGetUserMedia());

    await expect(
      startVoiceMicCapture({
        onFrame: () => {},
        getUserMedia: gum,
        signal: controller.signal,
        visibility: visibleVisibility(),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(gum).not.toHaveBeenCalled();
  });

  it("stops the tracks of a stream that resolves after cancellation", async () => {
    const controller = new AbortController();
    const stopTrack = vi.fn();
    let resolveGum!: (stream: MediaStream) => void;
    const gum = vi.fn(
      (): Promise<MediaStream> =>
        new Promise((resolve) => {
          resolveGum = resolve;
        }),
    );

    const starting = startVoiceMicCapture({
      onFrame: () => {},
      getUserMedia: gum,
      signal: controller.signal,
    });
    controller.abort();
    await expect(starting).rejects.toMatchObject({ name: "AbortError" });

    resolveGum({
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream);
    await vi.waitFor(() => expect(stopTrack).toHaveBeenCalledTimes(1));
  });

  it("frames PCM delivered over the AudioWorklet port and ignores non-PCM payloads", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeVoiceAudioWorkletNode);
    const ctx = new FakeMicWorkletAudioContext(16_000);
    const frames: Uint8Array[] = [];
    const capture = await startVoiceMicCapture({
      onFrame: (b) => frames.push(b),
      frameMs: 100,
      getUserMedia: fakeGetUserMedia(),
      createAudioContext: () => ctx,
      visibility: visibleVisibility(),
    });
    expect(capture.backend).toBe("audioworklet");

    const node = FakeVoiceAudioWorkletNode.instances[0];
    if (!node?.port.onmessage) throw new Error("uplink worklet not wired");
    node.port.onmessage({ data: { pcm: new Float32Array(1600).fill(0.25) } });
    node.port.onmessage({ data: { pcm: new Float32Array(1600).fill(0.25) } });
    // A sub-frame remainder is buffered, not emitted as a short frame.
    node.port.onmessage({ data: { pcm: new Float32Array(100).fill(0.25) } });
    // Non-PCM payloads must be dropped without throwing or emitting.
    node.port.onmessage({ data: "junk" });
    node.port.onmessage({ data: {} });

    expect(frames.length).toBe(2);
    expect(frames[0].byteLength).toBe(3200);
    const decoded = int16BytesToFloatPcm(frames[0]);
    expect(decoded[0]).toBeCloseTo(0.25, 2);
    await capture.stop();
  });

  it("still starts when the context's initial resume is denied", async () => {
    const ctx = new FakeMicAudioContext(16_000);
    ctx.resume = async () => {
      throw new Error("resume denied by host");
    };

    const capture = await startVoiceMicCapture({
      onFrame: () => {},
      getUserMedia: fakeGetUserMedia(),
      createAudioContext: () => ctx,
      visibility: visibleVisibility(),
    });
    expect(capture.backend).toBe("scriptprocessor");
    await capture.stop();
    expect(ctx.closed).toBe(true);
  });

  it("keeps stop idempotent and ignores visibility changes after teardown", async () => {
    const ctx = new FakeMicAudioContext(16_000);
    let closes = 0;
    ctx.close = async () => {
      closes += 1;
    };
    const stopTrack = vi.fn();
    const listeners: Array<() => void> = [];
    let hidden = false;
    const onSuspend = vi.fn();

    const capture = await startVoiceMicCapture({
      onFrame: () => {},
      frameMs: 100,
      getUserMedia: async () =>
        ({ getTracks: () => [{ stop: stopTrack }] }) as unknown as MediaStream,
      createAudioContext: () => ctx,
      onSuspend,
      visibility: {
        addListener: (l) => {
          listeners.push(l);
        },
        removeListener() {},
        isHidden: () => hidden,
      },
    });
    expect(capture.active).toBe(true);

    await capture.stop();
    await capture.stop();

    expect(closes).toBe(1);
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(capture.active).toBe(false);

    hidden = true;
    for (const listener of [...listeners]) listener();
    expect(onSuspend).not.toHaveBeenCalled();
  });

  it("honours a custom frameMs of 320ms across accumulated feeds", async () => {
    const ctx = new FakeMicAudioContext(16_000);
    const frames: Uint8Array[] = [];
    const capture = await startVoiceMicCapture({
      onFrame: (b) => frames.push(b),
      frameMs: 320, // 5120 samples → 10240 bytes/frame
      getUserMedia: fakeGetUserMedia(),
      createAudioContext: () => ctx,
      visibility: visibleVisibility(),
    });
    const node = ctx.scriptNode;
    if (!node) throw new Error("no script node created");

    node.feed(new Float32Array(4096).fill(0.5));
    expect(frames.length).toBe(0);
    node.feed(new Float32Array(4096).fill(0.5));
    node.feed(new Float32Array(4096).fill(0.5));

    expect(frames.length).toBe(2);
    for (const frame of frames) expect(frame.byteLength).toBe(10240);
    const decoded = int16BytesToFloatPcm(frames[0]);
    expect(decoded[100]).toBeCloseTo(0.5, 3);
    await capture.stop();
  });

  it("drops empty ScriptProcessor blocks at non-native rates without breaking later frames", async () => {
    const ctx = new FakeMicAudioContext(48_000);
    const frames: Uint8Array[] = [];
    const capture = await startVoiceMicCapture({
      onFrame: (b) => frames.push(b),
      frameMs: 100,
      getUserMedia: fakeGetUserMedia(),
      createAudioContext: () => ctx,
      visibility: visibleVisibility(),
    });
    const node = ctx.scriptNode;
    if (!node) throw new Error("no script node created");

    node.feed(new Float32Array(0));
    node.feed(new Float32Array(0));
    expect(frames.length).toBe(0);

    node.feed(new Float32Array(9600).fill(0.25));
    expect(frames.length).toBeGreaterThanOrEqual(2);
    for (const frame of frames) expect(frame.byteLength).toBe(3200);
    const decoded = int16BytesToFloatPcm(frames[0]);
    expect(decoded[10]).toBeCloseTo(0.25, 2);
    await capture.stop();
  });

  it("probes AudioWorklet support from both the context capability and the global node", () => {
    const bare = new FakeMicAudioContext(16_000);
    const workletCtx = new FakeMicWorkletAudioContext(16_000);

    expect(hasAudioWorkletSupport(bare)).toBe(false);
    expect(hasAudioWorkletSupport(workletCtx)).toBe(false);

    vi.stubGlobal("AudioWorkletNode", FakeVoiceAudioWorkletNode);
    expect(hasAudioWorkletSupport(workletCtx)).toBe(true);
    expect(hasAudioWorkletSupport(bare)).toBe(false);

    vi.unstubAllGlobals();
    expect(hasAudioWorkletSupport(workletCtx)).toBe(false);
  });
});
