/**
 * Registers the `dashboard` CLI command, which opens the Control UI in the
 * browser. It probes the given `--port` (then the default) for a listening
 * server and opens that URL; failing that it locates the eliza package root,
 * spawns the app's Vite dev server, and opens the dev URL once Vite reports
 * "Local:" (or after a timeout). Cross-platform browser launch and dev-server
 * teardown are handled here: on Windows via `taskkill /t`, on POSIX by killing
 * the child's whole process group (the child is spawned detached as a group
 * leader) so the Vite grandchild cannot survive the CLI's exit.
 */

import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
import * as childProcess from "node:child_process";
import type { Readable } from "node:stream";
import { resolveDesktopUiPort, theme } from "@elizaos/shared";
import type { Command } from "commander";

const SIGKILL_ESCALATION_MS = 5_000;

/**
 * Spawn the app dev server as a process-group leader on POSIX (detached), so
 * `stopDashboardDevServer` can signal the whole `bun run dev` tree — Vite runs
 * as a grandchild and does not receive a signal aimed at the direct child
 * alone. Windows keeps default group semantics; taskkill /t handles the tree.
 */
export function spawnDashboardDevServer(
  appDir: string,
): ChildProcessByStdio<null, Readable, Readable> {
  return childProcess.spawn("bun", ["run", "dev"], {
    cwd: appDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
    detached: process.platform !== "win32",
  });
}

/**
 * Tear down the spawned dev server and everything under it. On POSIX the
 * child was started as a group leader, so signal the whole group; escalate to
 * SIGKILL if SIGTERM has not ended it within {@link SIGKILL_ESCALATION_MS}.
 * Windows already tree-kills through `taskkill /t /f`.
 */
export function stopDashboardDevServer(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    childProcess.spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"]);
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // error-policy:J6 best-effort teardown: ESRCH means the group is already gone.
  }
  const escalation = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // error-policy:J6 best-effort teardown: group already reaped.
    }
  }, SIGKILL_ESCALATION_MS);
  escalation.unref?.();
  child.once("exit", () => clearTimeout(escalation));
}

async function isPortListening(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 800,
): Promise<boolean> {
  const net = await import("node:net");
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

async function openInBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const isWin = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const bin = isMac ? "open" : isWin ? "cmd" : "xdg-open";
  // On Windows, `start` is a cmd built-in; the empty-string arg is the window title.
  const args = isWin ? ["/c", "start", "", url] : [url];
  const child = spawn(bin, args, { stdio: "ignore" });
  child.on("error", () => {
    console.log(theme.warn("Could not open browser automatically."));
    console.log(`${theme.muted("Open manually:")} ${url}`);
  });
  child.unref();
}

export function registerDashboardCommand(program: Command) {
  const defaultPort = resolveDesktopUiPort(process.env);
  program
    .command("dashboard")
    .description("Open the Control UI in your browser")
    .option("--port <port>", "Server port to check", String(defaultPort))
    .option("--url <url>", "Server URL (overrides --port)")
    .action(async (opts: { port?: string; url?: string }) => {
      const rawPort = Number(opts.port ?? defaultPort);
      const port =
        Number.isFinite(rawPort) && rawPort > 0 && rawPort <= 65535
          ? rawPort
          : defaultPort;

      if (opts.url) {
        console.log(`${theme.muted("→")} Opening Control UI: ${opts.url}`);
        openInBrowser(opts.url);
        return;
      }

      if (await isPortListening(port)) {
        const url = `http://localhost:${port}`;
        console.log(`${theme.muted("→")} Opening Control UI: ${url}`);
        openInBrowser(url);
        return;
      }

      if (port !== defaultPort && (await isPortListening(defaultPort))) {
        const url = `http://localhost:${defaultPort}`;
        console.log(
          `${theme.muted("→")} Opening Control UI (dev server): ${url}`,
        );
        openInBrowser(url);
        return;
      }

      console.log(
        `${theme.muted("→")} Server not running on port ${port}; starting app dev server…`,
      );

      const path = await import("node:path");
      const fs = await import("node:fs");
      const { resolveElizaPackageRootSync } = await import(
        "../../utils/eliza-root"
      );

      const pkgRoot = resolveElizaPackageRootSync({
        cwd: process.cwd(),
        argv1: process.argv[1],
        moduleUrl: import.meta.url,
      });

      if (!pkgRoot) {
        console.log(theme.error("Could not locate eliza package root."));
        process.exitCode = 1;
        return;
      }

      const appDir = [
        path.join(pkgRoot, "packages", "app"),
        path.join(pkgRoot, "apps", "app"),
      ].find((candidate) =>
        fs.existsSync(path.join(candidate, "package.json")),
      );
      if (!appDir) {
        console.log(
          theme.error("App UI is not available in this installation."),
        );
        console.log(
          theme.muted("The app dev server requires a development checkout."),
        );
        console.log(
          theme.muted(
            "Start the agent with `eliza start` and use the URL printed at startup.",
          ),
        );
        process.exitCode = 1;
        return;
      }

      const child = spawnDashboardDevServer(appDir);

      let opened = false;

      const tryOpen = () => {
        if (opened) return;
        opened = true;
        const devUrl = `http://localhost:${defaultPort}`;
        console.log(`${theme.muted("→")} Opening Control UI: ${devUrl}`);
        openInBrowser(devUrl);
      };

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        process.stdout.write(text);
        if (!opened && text.includes("Local:")) {
          tryOpen();
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        process.stderr.write(chunk.toString());
      });

      child.on("error", (err) => {
        console.log(
          theme.error(`Failed to start app dev server: ${err.message}`),
        );
        process.exitCode = 1;
      });

      setTimeout(tryOpen, 10_000);

      const cleanup = () => {
        stopDashboardDevServer(child);
      };
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);
    });
}
