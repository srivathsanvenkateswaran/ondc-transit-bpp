/**
 * The real fleet simulator, running, for the manifest-push integration test.
 *
 * `docs/intercity-coaches.md` (in the sibling repository) specifies
 * `PUT`/`DELETE /fleet/manifest`, and until this change nothing in this
 * repository ever called it - the seam had never been crossed in either
 * direction. This harness boots the actual simulator, on its own toolchain,
 * so the integration test drives the real thing rather than a belief about
 * it, on the same reasoning `tests/reserved/http.test.ts`'s fixtures are read
 * rather than invented.
 *
 * Offline, and optional. Everything binds to 127.0.0.1 on port 0, there is no
 * Docker and no network beyond the loopback interface. When the sibling
 * repository is not checked out, `startFleetSim` returns `null` and the
 * suite skips with a message naming the path it looked in, so a machine
 * holding one checkout still runs a green suite.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Where the sibling simulator is expected to be, overridable for a checkout that lives elsewhere. */
export function fleetSimRepoPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.FLEET_SIM_REPO?.trim() || path.resolve(HERE, "../../../transit-fleet-sim");
}

export function fleetSimRepoPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  const repo = fleetSimRepoPath(env);
  return (
    existsSync(path.join(repo, "src/index.ts")) &&
    existsSync(path.join(repo, "node_modules/.bin/tsx")) &&
    existsSync(path.join(repo, "data/bundle/corridor-roster.json"))
  );
}

export const FLEET_SIM_ABSENT_MESSAGE = (repo: string) =>
  `The fleet simulator is not checked out at ${repo} (or its dependencies are not installed), so the fleet-manifest integration is skipped. Clone the sibling repository and run npm install in it, or set FLEET_SIM_REPO.`;

export interface RunningFleetSim {
  url: string;
  stop(): Promise<void>;
}

export interface StartFleetSimOptions {
  /** Additional corridors env, merged over the defaults below. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Boots the simulator with `INTERCITY_CORRIDORS=BNG-HSP` - the corridor that
 * rosters `2259BNGHMP`, the same service id this provider's own KSRTC
 * fixtures ship (`fixtures/ksrtc/services.json`; the two repositories commit
 * to sharing this string, `docs/reserved-intercity.md` section 18) - a wide
 * roster window and assignment horizon so a travel date chosen well clear of
 * both this provider's booking-close window and any daylight-saving-style
 * edge stays inside the simulator's window regardless of what day the suite
 * happens to run.
 */
export async function startFleetSim(
  options: StartFleetSimOptions = {},
): Promise<RunningFleetSim | null> {
  const repo = fleetSimRepoPath();
  if (!fleetSimRepoPresent()) return null;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SIM_REPO: repo,
    INTERCITY_CORRIDORS: "BNG-HSP",
    // Wide enough that a travel date ten-plus days out (chosen so it is
    // never near this provider's reservation-close window) still falls
    // inside [today - 1, today + (days - 2)].
    INTERCITY_ROSTER_DAYS: "20",
    // Wide enough that the same travel date is never beyond the horizon, so
    // `GET /fleet/duty` discloses a `vehicle.bin` this test can resolve
    // against - see the note in the test file about `duty.reservation` only
    // being carried on `/fleet/resolve`.
    INTERCITY_ASSIGNMENT_HORIZON_HOURS: "100000",
    ...options.env,
  };

  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
    path.join(repo, "node_modules/.bin/tsx"),
    [path.join(HERE, "fleetSimBoot.mts")],
    { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] },
  );

  const stderr: string[] = [];
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderr.push(text);
    if (process.env.FLEET_SIM_HARNESS_VERBOSE) process.stderr.write(`[fleet-sim] ${text}`);
  });

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`The fleet simulator did not start within 60s. stderr:\n${stderr.join("")}`));
    }, 60_000);
    let buffered = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const line = buffered.split("\n").find((candidate) => candidate.trim().startsWith("{"));
      if (!line) return;
      try {
        const parsed = JSON.parse(line) as { port: number };
        clearTimeout(timer);
        resolve(parsed.port);
      } catch {
        /* keep buffering */
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The fleet simulator exited with ${code}. stderr:\n${stderr.join("")}`));
    });
  });

  return {
    url: `http://127.0.0.1:${port}`,
    async stop() {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 3_000);
        child.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}
