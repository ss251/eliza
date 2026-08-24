/**
 * Unit tests for voice audio-utils: feature detection and recording-MIME selection.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSupportedMimeType,
  supportsGetUserMedia,
  supportsMediaRecorder,
} from "./audio-utils.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("audio-utils", () => {
  describe("supportsMediaRecorder", () => {
    it("returns true when window exposes MediaRecorder", () => {
      vi.stubGlobal("window", { MediaRecorder: class {} });
      expect(supportsMediaRecorder()).toBe(true);
    });

    it("returns false when window exists without MediaRecorder", () => {
      vi.stubGlobal("window", {});
      expect(supportsMediaRecorder()).toBe(false);
    });

    it("returns false when window is undefined", () => {
      vi.stubGlobal("window", undefined);
      expect(supportsMediaRecorder()).toBe(false);
    });
  });

  describe("supportsGetUserMedia", () => {
    it("returns true when navigator.mediaDevices.getUserMedia exists", () => {
      vi.stubGlobal("window", {});
      vi.stubGlobal("navigator", {
        mediaDevices: { getUserMedia: () => Promise.resolve({}) },
      });
      expect(supportsGetUserMedia()).toBe(true);
    });

    it("returns false when navigator.mediaDevices is missing", () => {
      vi.stubGlobal("window", {});
      vi.stubGlobal("navigator", {});
      expect(supportsGetUserMedia()).toBe(false);
    });

    it("returns false when mediaDevices lacks getUserMedia", () => {
      vi.stubGlobal("window", {});
      vi.stubGlobal("navigator", { mediaDevices: {} });
      expect(supportsGetUserMedia()).toBe(false);
    });

    it("returns false when window is undefined even with full support", () => {
      vi.stubGlobal("window", undefined);
      vi.stubGlobal("navigator", {
        mediaDevices: { getUserMedia: () => Promise.resolve({}) },
      });
      expect(supportsGetUserMedia()).toBe(false);
    });
  });

  describe("getSupportedMimeType", () => {
    it("returns the highest-priority type when every candidate is supported", () => {
      vi.stubGlobal("MediaRecorder", { isTypeSupported: () => true });
      expect(getSupportedMimeType()).toBe("audio/webm;codecs=opus");
    });

    it("skips unsupported candidates and returns the first supported one", () => {
      const supported = new Set(["audio/mp4"]);
      vi.stubGlobal("MediaRecorder", {
        isTypeSupported: (type: string) => supported.has(type),
      });
      expect(getSupportedMimeType()).toBe("audio/mp4");
    });

    it("ranks the opus-codec ogg variant above plain ogg", () => {
      const supported = new Set(["audio/ogg"]);
      vi.stubGlobal("MediaRecorder", {
        isTypeSupported: (type: string) => supported.has(type),
      });
      expect(getSupportedMimeType()).toBe("audio/ogg");
    });

    it("falls through to the last candidate when only wav is supported", () => {
      const supported = new Set(["audio/wav"]);
      vi.stubGlobal("MediaRecorder", {
        isTypeSupported: (type: string) => supported.has(type),
      });
      expect(getSupportedMimeType()).toBe("audio/wav");
    });

    it("returns an empty string when no candidate is supported", () => {
      vi.stubGlobal("MediaRecorder", { isTypeSupported: () => false });
      expect(getSupportedMimeType()).toBe("");
    });
  });
});
