import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadReservedCatalogue } from "../../src/reserved/fixture.js";
import { validateReservedCatalogue } from "../../src/reserved/integrity.js";
import type { ReservedCatalogue } from "../../src/reserved/types.js";

const fixtureRoot = fileURLToPath(new URL("../../fixtures", import.meta.url));
const shipped = await loadReservedCatalogue(fixtureRoot, "ksrtc");

function broken(mutate: (catalogue: ReservedCatalogue) => void): ReservedCatalogue {
  const copy = structuredClone(shipped);
  mutate(copy);
  return copy;
}

function refuses(
  mutate: (catalogue: ReservedCatalogue) => void,
  message: RegExp,
): void {
  assert.throws(
    () => validateReservedCatalogue(broken(mutate), "test fixture"),
    message,
  );
}

test("the shipped fixture set passes its own integrity check", () => {
  // A broken fixture fails at boot rather than at the first select, which is
  // the only place the failure is cheap.
  validateReservedCatalogue(shipped, "shipped fixture");
});

test("a service pointing at a seat map nobody authored fails at boot", () => {
  refuses(
    (catalogue) => {
      catalogue.services[0].seatMapId = "AMBAARI_DREAM-2P1-30";
    },
    /seat map AMBAARI_DREAM-2P1-30/,
  );
});

test("a service pointing at a fare table nobody authored fails at boot", () => {
  refuses(
    (catalogue) => {
      catalogue.services[0].fareTableId = "FT-BNGGOA";
    },
    /fare table FT-BNGGOA/,
  );
});

test("a fare cell naming a point the service does not stop at fails at boot", () => {
  refuses(
    (catalogue) => {
      catalogue.fareTables[0].fares[0].fromBoardingPointId = "BP-MAA-ADYAR";
    },
    /BP-MAA-ADYAR/,
  );
});

test("a missing fare cell is not an integrity failure, because a missing cell is refused at request time", () => {
  // The table need not be complete. Interpolating a neighbouring cell would
  // be inventing a fare; refusing the request with a named code is the
  // honest answer, and that decision belongs at request time rather than
  // here.
  const thinned = broken((catalogue) => {
    catalogue.fareTables[0].fares = catalogue.fareTables[0].fares.slice(0, 1);
  });
  validateReservedCatalogue(thinned, "test fixture");
});

test("a fare cell with no sourcing label fails at boot", () => {
  refuses(
    (catalogue) => {
      (catalogue.fareTables[0].fares[0] as { sourcing: string }).sourcing = "";
    },
    /sourcing/,
  );
});

test("a confirmed provenance with one source is a bug and is caught as one", () => {
  // SOURCE_COUNT is what makes confirmed auditable rather than asserted.
  refuses(
    (catalogue) => {
      catalogue.services[0].provenance = "confirmed";
      catalogue.services[0].provenanceSourceCount = 1;
    },
    /confirmed.*2 (?:independent )?sources|source count/i,
  );
});

test("a named operating corporation with an unconfirmed basis fails at boot", () => {
  refuses(
    (catalogue) => {
      catalogue.services[0].operatingCorporation = "KKRTC";
      catalogue.services[0].operatingCorporationBasis = "inferred";
    },
    /operating corporation/i,
  );
});

test("an unknown operating corporation carrying a basis other than none fails at boot", () => {
  refuses(
    (catalogue) => {
      catalogue.services[0].operatingCorporation = null;
      catalogue.services[0].operatingCorporationBasis = "confirmed";
    },
    /operating corporation/i,
  );
});

test("an asymmetric adjacency on a seat map fails at boot", () => {
  refuses(
    (catalogue) => {
      const map = catalogue.seatMaps.find((m) => m.seatMapId === "PALLAKKI-2P1-30");
      map!.seats.find((seat) => seat.seatId === "L1A")!.adjacentSeatIds = ["L1C"];
    },
    /L1A|L1C/,
  );
});

test("an adjacency naming a seat that is not on the map fails at boot", () => {
  refuses(
    (catalogue) => {
      const map = catalogue.seatMaps.find((m) => m.seatMapId === "PALLAKKI-2P1-30");
      map!.seats[0].adjacentSeatIds = ["L9Z"];
    },
    /L9Z/,
  );
});

test("an asymmetric pairing on a seat map fails at boot", () => {
  refuses(
    (catalogue) => {
      const map = catalogue.seatMaps.find((m) => m.seatMapId === "PALLAKKI-2P1-30");
      map!.seats.find((seat) => seat.seatId === "L1B")!.pairedSeatId = null;
    },
    /L1A|L1B/,
  );
});

test("a seat count that disagrees with the class's documented capacity fails at boot", () => {
  refuses(
    (catalogue) => {
      const map = catalogue.seatMaps.find((m) => m.seatMapId === "PALLAKKI-2P1-30");
      map!.seats.pop();
    },
    /29.*30|30.*29/,
  );
});

test("a duplicate seat id fails at boot", () => {
  refuses(
    (catalogue) => {
      const map = catalogue.seatMaps.find((m) => m.seatMapId === "PALLAKKI-2P1-30");
      map!.seats[1].seatId = map!.seats[0].seatId;
    },
    /duplicate seat/i,
  );
});

test("a seat on a deck the map does not have fails at boot", () => {
  refuses(
    (catalogue) => {
      const map = catalogue.seatMaps.find(
        (m) => m.seatMapId === "AIRAVAT_CLUB-2P2-53",
      );
      map!.seats[0].deck = 2;
    },
    /deck/i,
  );
});

test("a duplicate service id fails at boot", () => {
  refuses(
    (catalogue) => {
      catalogue.services[1].serviceId = catalogue.services[0].serviceId;
    },
    /duplicate service/i,
  );
});

test("a boarding point on a service that no town declares fails at boot", () => {
  refuses(
    (catalogue) => {
      catalogue.services[0].boardingPoints[0].boardingPointId = "BP-BLR-SHANTINAGAR";
    },
    /BP-BLR-SHANTINAGAR/,
  );
});

test("a popularity dial outside zero to one fails at boot", () => {
  // popularity is a fidelity dial, not a claim, and it is not derived from
  // ridership data because none exists at route level for these corporations.
  refuses(
    (catalogue) => {
      catalogue.services[0].popularity = 1.4;
    },
    /popularity/i,
  );
});

test("a service whose class is not one this category sells fails at boot", () => {
  // SARIGE and ASHWAMEDHA are unreserved walk-up buses run by the same
  // corporations. Gating on the corporation rather than the class would block
  // a plain mofussil bus from ever appearing as a walk-up option, so this
  // category publishes only classes that genuinely sell numbered seats.
  refuses(
    (catalogue) => {
      (catalogue.services[0] as { serviceClass: string }).serviceClass = "SARIGE";
    },
    /SARIGE/,
  );
});

test("a class name the research could not confirm exists is refused outright", () => {
  refuses(
    (catalogue) => {
      (catalogue.services[0] as { serviceClass: string }).serviceClass = "CORONA";
    },
    /CORONA/,
  );
});
