/**
 * Prints the sold set for one service on one date, so that
 * `occupancy.test.ts` can run it twice in two separate operating-system
 * processes and compare the two outputs byte for byte.
 *
 * Asserting determinism inside one process only proves that a memoised answer
 * is stable. The property that matters is stronger: a screenshot taken today,
 * a golden file recorded last month and a stranger's first clone all show the
 * same coach. Two process starts is the cheapest test that can see the
 * difference.
 *
 * Not a `.test.ts` file, so the runner does not pick it up as a suite.
 */
import { fileURLToPath } from "node:url";

import { FixtureReservedSource } from "../../src/reserved/fixture.js";
import { seededOccupancy, soldSeatIds } from "../../src/reserved/occupancy.js";

const fixtureRoot = fileURLToPath(new URL("../../fixtures", import.meta.url));
const source = await FixtureReservedSource.load(fixtureRoot, "ksrtc");
const [service] = await source.services({
  fromTownCode: "BLR",
  toTownCode: "HMP",
  travelDate: "2026-09-25",
  cityCode: "std:080",
});
const seatMap = await source.seatMap(service.seatMapId);

const sold = soldSeatIds(service, seatMap!, "2026-09-25", 20_260_905);
const genders = seededOccupancy(service, seatMap!, "2026-09-25", 20_260_905);
process.stdout.write(
  `${JSON.stringify({ sold, genders: [...genders].sort() })}\n`,
);
