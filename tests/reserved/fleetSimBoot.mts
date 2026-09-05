/**
 * Boots the sibling fleet simulator, in its own process, on its own toolchain.
 *
 * This file lives in this repository and is executed by the simulator's own
 * `tsx`, with the simulator's repository as the working directory - the same
 * shape Tatak's `providerBoot.mts` already uses to boot this provider from
 * the other side of the same seam. It couples in one direction only: it
 * imports the simulator's own modules by absolute path and reproduces
 * `src/index.ts`'s own boot sequence, because that file calls
 * `server.listen(config.port, ...)` with a port read from the environment
 * rather than the one the operating system actually hands out, and a test
 * has to know which port it got. Nothing in the simulator changes, and
 * nothing here is imported by its application code.
 *
 * Binds to 127.0.0.1 on port 0 and prints the chosen port as one line of
 * JSON, because a harness that hardcoded a port would fail on a machine
 * where something else already holds it.
 */

import { pathToFileURL } from "node:url";

const repo = process.env.SIM_REPO;
if (!repo) {
  throw new Error("fleetSimBoot needs SIM_REPO");
}

const src = (relative: string) => pathToFileURL(`${repo}/src/${relative}`).href;

const { createApiServer } = (await import(src("api/server.ts"))) as {
  createApiServer: (
    world: unknown,
    registry: unknown,
    options: Record<string, unknown>,
  ) => import("node:http").Server;
};
const { generateCoachFleet, generateFleet } = (await import(
  src("fleet/generate.ts")
)) as {
  generateFleet: () => unknown[];
  generateCoachFleet: (options: { slots: unknown }) => unknown[];
};
const { FleetRegistry } = (await import(src("fleet/registry.ts"))) as {
  FleetRegistry: new (fleet: unknown[]) => unknown;
};
const { createClock } = (await import(src("sim/clock.ts"))) as {
  createClock: (spec: string) => { now: () => Date };
};
const { defaultScheduleProfile } = (await import(src("sim/coachProfiles.ts"))) as {
  defaultScheduleProfile: unknown;
};
const { coachSlotsFor, createWorld, loadIntercity } = (await import(
  src("sim/world.ts")
)) as {
  coachSlotsFor: (...args: unknown[]) => unknown;
  createWorld: (fleet: unknown[], intercity: unknown) => Promise<{
    start(): Promise<void>;
    stop(): Promise<void>;
    coaches: unknown;
  }>;
  loadIntercity: () => Promise<unknown>;
};
const { config } = (await import(src("config.ts"))) as {
  config: {
    simClock: string;
    intercityCorridors: readonly string[];
    intercityRosterDays: number;
  };
};

// docs/intercity-coaches.md §3.5, mirrored from src/index.ts: the coach fleet
// size falls out of the roster, so it has to be read before identity is
// generated.
const intercity = await loadIntercity();
const buses = generateFleet();
const coaches =
  intercity === null
    ? []
    : generateCoachFleet({
        slots: coachSlotsFor(
          intercity,
          config.intercityCorridors,
          createClock(config.simClock).now(),
          config.intercityRosterDays,
          defaultScheduleProfile,
        ),
      });
const fleet = [...buses, ...coaches];
const registry = new FleetRegistry(fleet);
const world = await createWorld(fleet, intercity);
await world.start();
const server = createApiServer(world, registry, {
  ...(world.coaches === null ? {} : { intercity: world.coaches }),
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
process.stdout.write(`${JSON.stringify({ port })}\n`);

async function shutdown(): Promise<void> {
  server.close();
  await world.stop();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
