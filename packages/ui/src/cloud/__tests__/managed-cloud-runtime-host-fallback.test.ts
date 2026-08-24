/**
 * Unit tests for the app-mode host fallback arm of isManagedCloudRuntime:
 * a non-cloud-managed RuntimeTarget must resolve as managed purely because
 * the document is served from an app-mode host, and every real union member
 * must resolve as unmanaged when the document is not. Harness: deterministic
 * unit suite under the package vitest config (node environment); the
 * app-mode hostname collaborator is mocked so the fallback branch is
 * reachable without a browser origin.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isManagedCloudRuntime } from "../managed-cloud-runtime.ts";

const appModeHostState = { enabled: false };

vi.mock("../app-mode/app-mode", () => ({
  isAppModeHost: (): boolean => appModeHostState.enabled,
}));

describe("managed-cloud-runtime runtime target members", () => {
  beforeEach(() => {
    appModeHostState.enabled = false;
  });

  it("returns false for the embedded-local target when the document is not an app-mode host", () => {
    expect(isManagedCloudRuntime("embedded-local")).toBe(false);
  });

  it("returns false for the remote-backend target when the document is not an app-mode host", () => {
    expect(isManagedCloudRuntime("remote-backend")).toBe(false);
  });
});

describe("managed-cloud-runtime app-mode host fallback", () => {
  beforeEach(() => {
    appModeHostState.enabled = true;
  });

  it("returns true for the embedded-local target when the document is served from an app-mode host", () => {
    expect(isManagedCloudRuntime("embedded-local")).toBe(true);
  });

  it("returns true for the remote-backend target when the document is served from an app-mode host", () => {
    expect(isManagedCloudRuntime("remote-backend")).toBe(true);
  });

  it("returns true for a null target when the document is served from an app-mode host", () => {
    expect(isManagedCloudRuntime(null)).toBe(true);
  });

  it("returns true for an undefined target when the document is served from an app-mode host", () => {
    expect(isManagedCloudRuntime(undefined)).toBe(true);
  });

  it("returns true when the persisted target and the app-mode host agree", () => {
    expect(isManagedCloudRuntime("cloud-managed")).toBe(true);
  });
});
