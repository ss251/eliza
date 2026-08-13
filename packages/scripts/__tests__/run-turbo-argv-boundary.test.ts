/**
 * Pins the `--` boundary for every flag run-turbo injects, through real
 * subprocesses and a fake Turbo binary.
 *
 * Turbo owns the arguments before a bare `--` and forwards everything after it
 * to the tasks. The concurrency override already asserts that boundary; the
 * `--ui=stream` force and the `--log-order=stream` splice read the same argv and
 * are pinned here, in both directions: a task's own flag must not suppress
 * turbo's, and a flag meant for turbo must never land in a task's argv.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

const repoRoot = resolve(import.meta.dir, "../../..");
const runTurbo = join(repoRoot, "packages/scripts/run-turbo.mjs");
const tempDirs: string[] = [];

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "run-turbo-argv-boundary-"));
  tempDirs.push(dir);
  const argvFile = join(dir, "argv.json");
  const fakeTurbo = join(dir, "fake-turbo.mjs");
  await writeFile(
    fakeTurbo,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n`,
  );
  return { argvFile, fakeTurbo };
}

async function invoke(args: string[]) {
  const { argvFile, fakeTurbo } = await fixture();
  const env = { ...process.env, RUN_TURBO_BIN: fakeTurbo };
  delete env.RUN_TURBO_CONCURRENCY;

  const result = spawnSync("node", [runTurbo, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
  expect(result.status, result.stderr).toBe(0);

  const argv: string[] = JSON.parse(await readFile(argvFile, "utf8"));
  const separatorIndex = argv.indexOf("--");
  return {
    argv,
    turboOwned: separatorIndex === -1 ? argv : argv.slice(0, separatorIndex),
    passThrough: separatorIndex === -1 ? [] : argv.slice(separatorIndex),
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("run-turbo argv boundary", () => {
  test.each([["--ui"], ["--ui=html"]])(
    "forces --ui=stream when a task is passed %s after the separator",
    async (taskFlag) => {
      const passThrough = ["--", taskFlag];

      const { turboOwned, passThrough: forwarded } = await invoke([
        "run",
        "test:e2e",
        ...passThrough,
      ]);

      expect(turboOwned).toContain("--ui=stream");
      expect(forwarded).toEqual(passThrough);
    },
  );

  test("forces --log-order=stream when a task is passed --log-order after the separator", async () => {
    const passThrough = ["--", "--log-order=grouped"];

    const { turboOwned, passThrough: forwarded } = await invoke([
      "run",
      "lint",
      ...passThrough,
    ]);

    expect(turboOwned).toContain("--log-order=stream");
    expect(forwarded).toEqual(passThrough);
  });

  test("never splices --log-order into a task's arguments when `run` appears only after the separator", async () => {
    const passThrough = ["--", "run", "--flag"];

    const { turboOwned, passThrough: forwarded } = await invoke([
      "build",
      ...passThrough,
    ]);

    expect(forwarded).toEqual(passThrough);
    expect(turboOwned).not.toContain("--log-order=stream");
  });

  test.each([["--ui=tui"], ["--log-order=grouped"]])(
    "respects Turbo's own %s and injects no duplicate",
    async (turboFlag) => {
      const { turboOwned } = await invoke(["run", "lint", turboFlag]);

      expect(turboOwned).toContain(turboFlag);
      expect(
        turboOwned.filter((arg) => arg.startsWith(turboFlag.split("=")[0])),
      ).toEqual([turboFlag]);
    },
  );

  test("still forces both flags for a plain `run` invocation", async () => {
    const { turboOwned, passThrough } = await invoke(["run", "lint"]);

    expect(turboOwned).toContain("--ui=stream");
    expect(turboOwned).toContain("--log-order=stream");
    expect(passThrough).toEqual([]);
  });
});
