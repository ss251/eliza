/**
 * Real-process teardown tests for the `dashboard` command's dev-server
 * lifecycle. The harness spawns an actual `bun run dev` tree (a package.json
 * script whose process spawns a long-lived grandchild, mirroring Vite under
 * `bun run`) and proves stopDashboardDevServer ends the ENTIRE tree, not just
 * the direct child. No mocks stand in for the process tree.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  spawnDashboardDevServer,
  stopDashboardDevServer,
} from "./register.dashboard";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("dashboard dev server teardown", () => {
  let appDir: string;

  beforeEach(() => {
    appDir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-teardown-"));
    // Mirror the production shape: `bun run dev` -> node parent -> grandchild.
    fs.writeFileSync(
      path.join(appDir, "package.json"),
      JSON.stringify({ scripts: { dev: "node dev-parent.cjs" } }),
    );
    fs.writeFileSync(
      path.join(appDir, "dev-parent.cjs"),
      [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        "const pids = [process.pid];",
        "const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });",
        "pids.push(child.pid);",
        "fs.writeFileSync(process.env.DEV_PARENT_PIDFILE, JSON.stringify(pids));",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
  });

  afterEach(() => {
    delete process.env.DEV_PARENT_PIDFILE;
    fs.rmSync(appDir, { recursive: true, force: true });
  });

  it("kills the whole bun run tree including the grandchild", async () => {
    const pidFile = path.join(appDir, "pids.json");
    process.env.DEV_PARENT_PIDFILE = pidFile;
    const child = spawnDashboardDevServer(appDir);

    let treePids: number[] = [];
    await waitFor(() => {
      try {
        treePids = JSON.parse(fs.readFileSync(pidFile, "utf8"));
        return (
          Array.isArray(treePids) &&
          treePids.length === 2 &&
          treePids.every((pid) => typeof pid === "number" && isAlive(pid))
        );
      } catch {
        return false;
      }
    });

    const rootPid = child.pid;
    expect(rootPid).toBeTruthy();
    // `bun run` spawns the script as a separate process rather than exec'ing
    // it, so the recorded dev-parent pid may differ from child.pid — exactly
    // why killing only the direct child strands the real dev-server tree.
    if (rootPid !== null && !treePids.includes(rootPid)) {
      expect(isAlive(rootPid)).toBe(true);
    }

    stopDashboardDevServer(child);

    await waitFor(
      () =>
        treePids.every((pid) => !isAlive(pid)) &&
        (rootPid === null || rootPid === undefined || !isAlive(rootPid)),
      10_000,
    );
    for (const pid of treePids) {
      expect(isAlive(pid)).toBe(false);
    }
    if (rootPid !== null && rootPid !== undefined) {
      expect(isAlive(rootPid)).toBe(false);
    }
  });

  it("is a no-op when the child never spawned", () => {
    const fake = { pid: null, once: () => {} } as never;
    expect(() => stopDashboardDevServer(fake)).not.toThrow();
  });
});
