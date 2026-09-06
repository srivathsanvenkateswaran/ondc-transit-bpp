/**
 * Generates the new-corridor slice of fixtures/ksrtc/{towns,boarding-points,
 * services}.json and fixtures/ksrtc/fares/FT-*.json from Tatak's own
 * corridor GTFS output (../Tatak/data/intercity/<corridor>/*.txt).
 *
 * Tatak is the source of truth for which trips are real (a non-null,
 * non-ambiguous tatak_service_number), which classes a corridor runs, and
 * which boarding-pair x class cells actually have a published fare. This
 * script never invents a fare, a stand or a clock: a trip with no real
 * service number, a class this provider cannot sell, or no fare cell
 * covering the two points it stops at is dropped, and the drop is reported
 * on stdout rather than silently patched over.
 *
 * Only three corridors currently clear all three bars: KA-BNG-MNG,
 * KA-BNG-CKM and KA-MYS-MNG. KA-BNG-MYS, KA-MYS-MDK, KA-COAST and
 * KA-DND-ANK were investigated and rejected; the reasons are named per
 * trip in this script's own stdout when it runs, and summarised for each
 * corridor in the implementation report that accompanied this change.
 *
 * Existing BLR/HPT/HMP/MAA data (Bengaluru-Hampi, Bengaluru-Chennai) is
 * untouched; this script only appends.
 *
 *   npx tsx scripts/generate-ksrtc-fixtures.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_ROOT = join(HERE, "..", "fixtures", "ksrtc");
const TATAK_ROOT = join(HERE, "..", "..", "Tatak", "data", "intercity");

// A handful of Tatak service numbers are assigned to a real trip on two
// different corridors at once, and Tatak's own data gives no way to tell
// which corridor the working actually belongs to. transit-fleet-sim's
// corridor roster drops these everywhere for the same reason: a ticket this
// provider sold under one of these numbers is a ticket the fleet simulator
// cannot corroborate with a coach.
const AMBIGUOUS_SERVICE_NUMBERS = new Set([
  "2105BNGMRC",
  "2131MRCBNG",
  "0801BNGCDP",
  "2334BNGMNG",
]);

// Tatak class id -> this provider's ServiceClass. Every class not listed
// here (KARNATAKA_SARIGE, ASHWAMEDHA, EV_POWER_PLUS, NON_AC_SLEEPER,
// AC_SEATER_EXECUTIVE_CHAIR, AMBAARI_DREAM_CLASS, AIRAVAT_CLUB_CLASS_2, ...)
// has no home in this provider: SARIGE/ASHWAMEDHA/EV_POWER_PLUS/
// AMBAARI_DREAM are hard-refused at fixture load (src/reserved/integrity.ts
// REFUSED_CLASSES), and the rest simply are not in SERVICE_CLASSES.
const CLASS_MAP: Record<string, string> = {
  RAJAHAMSA_EXECUTIVE: "RAJAHAMSA",
  AIRAVAT: "AIRAVAT",
  AIRAVAT_CLUB_CLASS: "AIRAVAT_CLUB",
  PALLAKKI: "PALLAKKI",
  AMBAARI_UTSAV: "AMBAARI_UTSAV",
};

interface PointDef {
  boardingPointId: string;
  name: string;
  nameLocal?: string;
  gps: { lat: number; lon: number };
  tatakStopId: string;
}

interface TownDef {
  code: string;
  name: string;
  nameLocal?: string;
}

interface CorridorConfig {
  tatakCorridorId: string;
  tatakDir: string;
  fareTableId: string;
  towns: TownDef[];
  points: PointDef[];
}

// The two-point model: every generated service here reports only its real
// origin and its real destination, both drawn from Tatak's own stop
// coordinates. Tatak's GTFS for these three corridors carries only one
// Bengaluru-side or Mysuru-side stand per corridor (no Madiwala/Electronic
// City style secondary pickups the way the hand-authored BNGHMP fixture
// has) so a single boarding point and a single dropping point is a
// faithful model, not a simplification of something richer that exists.
const CORRIDORS: CorridorConfig[] = [
  {
    tatakCorridorId: "KA-BNG-MNG",
    tatakDir: "ka-bng-mng",
    fareTableId: "FT-BNGMNG",
    towns: [{ code: "MNG", name: "Mangaluru", nameLocal: "ಮಂಗಳೂರು" }],
    points: [
      {
        boardingPointId: "BP-MNG-MANGALURU",
        name: "Mangaluru KSRTC Bus Stand (Bejai)",
        nameLocal: "ಕ.ರಾ.ರ.ಸಾ.ನಿ. ಬಸ್ ನಿಲ್ದಾಣ, ಮಂಗಳೂರು",
        gps: { lat: 12.8852444, lon: 74.8416769 },
        tatakStopId: "KA-BP-MANGALURU-KSRTC",
      },
    ],
  },
  {
    tatakCorridorId: "KA-BNG-CKM",
    tatakDir: "ka-bng-ckm",
    fareTableId: "FT-BNGCKM",
    towns: [{ code: "CKM", name: "Chikkamagaluru", nameLocal: "ಚಿಕ್ಕಮಗಳೂರು" }],
    points: [
      {
        boardingPointId: "BP-CKM-CHIKKAMAGALURU",
        name: "Chikkamagaluru KSRTC Bus Station",
        nameLocal: "ಕ.ರಾ.ರ.ಸಾ.ನಿ. ಬಸ್ ನಿಲ್ದಾಣ",
        gps: { lat: 13.3180039, lon: 75.7716607 },
        tatakStopId: "KA-BP-CHIKKAMAGALURU",
      },
    ],
  },
  {
    tatakCorridorId: "KA-MYS-MNG",
    tatakDir: "ka-mys-mng",
    fareTableId: "FT-MYSMNG",
    towns: [{ code: "MYS", name: "Mysuru", nameLocal: "ಮೈಸೂರು" }],
    points: [
      {
        boardingPointId: "BP-MYS-MYSURU-CENTRAL",
        name: "Mysuru Central Bus Stand",
        nameLocal: "ಕ.ರಾ.ರ.ಸಾ.ನಿ. ಬಸ್ ನಿಲ್ದಾಣ",
        gps: { lat: 12.312567, lon: 76.6584136 },
        tatakStopId: "KA-BP-MYSURU-CENTRAL",
      },
      // Mangaluru KSRTC is the same real stand BNG-MNG already defines
      // above; reused rather than redefined so the two corridors agree on
      // one physical point.
    ],
  },
];

// Bengaluru's own point already exists in fixtures/ksrtc/boarding-points.json
// as BP-BLR-MAJESTIC (town BLR). Reused, not redefined, for BNG-MNG and
// BNG-CKM's city-side end.
const EXISTING_TATAK_STOP_FOR_POINT: Record<string, string> = {
  "BP-BLR-MAJESTIC": "KA-BP-BNG-MAJESTIC",
  "BP-MNG-MANGALURU": "KA-BP-MANGALURU-KSRTC",
};

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const header = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

function readTatak(dir: string, file: string): Record<string, string>[] {
  return parseCsv(readFileSync(join(TATAK_ROOT, dir, file), "utf8"));
}

function hhmmssToMinutes(t: string): number {
  const [h, m, s] = t.split(":").map(Number);
  return h * 60 + m + s / 60;
}

interface GeneratedService {
  serviceId: string;
  serviceNumber: string;
  brand: "KSRTC";
  operatingCorporation: null;
  operatingCorporationBasis: "none";
  provenance: "inferred";
  provenanceSourceCount: number;
  serviceClass: string;
  operatingPattern: { kind: "daily" };
  departureMinute: number;
  runningMinutes: number;
  seatMapId: string;
  fareTableId: string;
  popularity: number;
  reservationFeePaise: number;
  tollPaise: number;
  boardingPoints: Array<{ boardingPointId: string; reportingOffsetMinutes: number }>;
  droppingPoints: Array<{ boardingPointId: string; reportingOffsetMinutes: number }>;
}

interface FareCellOut {
  fromBoardingPointId: string;
  toBoardingPointId: string;
  serviceClass: string;
  farePaise: number;
  sourcing: "V" | "S" | "I";
}

function mapSourcing(tatakGrade: string): "V" | "S" | "I" {
  // Tatak V (operator's own published page) -> provider V. Tatak P (the
  // project owner's own paid receipt) -> provider S: real, but not the
  // operator's own price list, and this provider's V is reserved for a
  // confirmed operator price list. Tatak S -> provider S. Tatak I ->
  // provider I. This mapping is this generator's own judgment call, not a
  // fact Tatak asserts.
  if (tatakGrade === "V") return "V";
  if (tatakGrade === "P") return "S";
  if (tatakGrade === "S") return "S";
  return "I";
}

function pointForTatakStop(config: CorridorConfig, tatakStopId: string): PointDef | undefined {
  const own = config.points.find((p) => p.tatakStopId === tatakStopId);
  if (own) return own;
  for (const [bp, stop] of Object.entries(EXISTING_TATAK_STOP_FOR_POINT)) {
    if (stop === tatakStopId) {
      // Bengaluru Majestic. Coordinates already on file in
      // fixtures/ksrtc/boarding-points.json; not redefined here.
      return { boardingPointId: bp, name: "", gps: { lat: 0, lon: 0 }, tatakStopId };
    }
  }
  return undefined;
}

function generateCorridor(config: CorridorConfig) {
  const trips = readTatak(config.tatakDir, "trips.txt");
  const stopTimes = readTatak(config.tatakDir, "stop_times.txt");
  const fareProducts = readTatak(config.tatakDir, "fare_products.txt");

  const stopTimesByTrip = new Map<string, Record<string, string>[]>();
  for (const row of stopTimes) {
    const list = stopTimesByTrip.get(row.trip_id) ?? [];
    list.push(row);
    stopTimesByTrip.set(row.trip_id, list);
  }
  for (const list of stopTimesByTrip.values()) {
    list.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
  }

  const services: GeneratedService[] = [];
  const fareCellsUsed = new Map<string, FareCellOut>();
  const dropped: string[] = [];
  const included: string[] = [];

  for (const trip of trips) {
    const tatakClass = trip.route_id.slice(config.tatakCorridorId.length + 1);
    const serviceNumber = trip.tatak_service_number.trim();
    const tripId = trip.trip_id;

    if (!serviceNumber) {
      dropped.push(`${tripId}: no real Tatak service number`);
      continue;
    }
    if (AMBIGUOUS_SERVICE_NUMBERS.has(serviceNumber)) {
      dropped.push(`${tripId} (${serviceNumber}): ambiguous, assigned to a real trip on another corridor too`);
      continue;
    }
    const providerClass = CLASS_MAP[tatakClass];
    if (!providerClass) {
      dropped.push(`${tripId} (${serviceNumber}): class ${tatakClass} is not sellable in this provider`);
      continue;
    }

    const calls = stopTimesByTrip.get(tripId);
    if (!calls || calls.length < 2) {
      dropped.push(`${tripId} (${serviceNumber}): no stop_times`);
      continue;
    }
    const originStop = calls[0];
    const destStop = calls[calls.length - 1];
    const originPoint = pointForTatakStop(config, originStop.stop_id);
    const destPoint = pointForTatakStop(config, destStop.stop_id);
    if (!originPoint || !destPoint) {
      dropped.push(
        `${tripId} (${serviceNumber}): calls at ${originStop.stop_id} / ${destStop.stop_id}, which this generator does not model as a boarding point`,
      );
      continue;
    }

    const fareRow = fareProducts.find(
      (fp) =>
        fp.fare_product_id ===
          `FP-${tatakClass}-${originStop.stop_id}-${destStop.stop_id}-adult` &&
        fp.currency === "INR",
    );
    if (!fareRow) {
      dropped.push(
        `${tripId} (${serviceNumber}): no adult fare cell for ${tatakClass} between ${originStop.stop_id} and ${destStop.stop_id}`,
      );
      continue;
    }

    const departureMinute = Math.round(hhmmssToMinutes(originStop.departure_time));
    const runningMinutes = Math.round(
      hhmmssToMinutes(destStop.arrival_time) - hhmmssToMinutes(originStop.departure_time),
    );

    const seatMapId = `${providerClass}-2P${providerClass === "PALLAKKI" || providerClass === "AMBAARI_UTSAV" ? "1" : "2"}-${
      providerClass === "PALLAKKI" || providerClass === "AMBAARI_UTSAV" ? "30" : "53"
    }`;

    services.push({
      serviceId: serviceNumber,
      serviceNumber: serviceNumber.replace(/[A-Z]/g, ""),
      brand: "KSRTC",
      operatingCorporation: null,
      operatingCorporationBasis: "none",
      provenance: "inferred",
      provenanceSourceCount: 1,
      serviceClass: providerClass,
      operatingPattern: { kind: "daily" },
      departureMinute,
      runningMinutes,
      seatMapId,
      fareTableId: config.fareTableId,
      popularity: 0.5,
      reservationFeePaise: 2000,
      tollPaise: 2000,
      boardingPoints: [{ boardingPointId: originPoint.boardingPointId, reportingOffsetMinutes: 0 }],
      droppingPoints: [{ boardingPointId: destPoint.boardingPointId, reportingOffsetMinutes: runningMinutes }],
    });
    included.push(`${tripId} (${serviceNumber}), ${providerClass}`);

    const farePaise = Math.round(Number(fareRow.amount) * 100);
    const cellKey = `${originPoint.boardingPointId}|${destPoint.boardingPointId}|${providerClass}`;
    fareCellsUsed.set(cellKey, {
      fromBoardingPointId: originPoint.boardingPointId,
      toBoardingPointId: destPoint.boardingPointId,
      serviceClass: providerClass,
      farePaise,
      sourcing: mapSourcing(fareRow.tatak_sourcing),
    });
  }

  return { config, services, fareCells: [...fareCellsUsed.values()], dropped, included };
}

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function main() {
  const results = CORRIDORS.map(generateCorridor);

  const townsPath = join(FIXTURE_ROOT, "towns.json");
  const pointsPath = join(FIXTURE_ROOT, "boarding-points.json");
  const servicesPath = join(FIXTURE_ROOT, "services.json");

  const townsFile = loadJson<{ sourcing: unknown; towns: TownDef[] }>(townsPath);
  const pointsFile = loadJson<{
    sourcing: unknown;
    points: Record<string, Array<{ boardingPointId: string; name: string; nameLocal?: string; gps?: unknown }>>;
  }>(pointsPath);
  const servicesFile = loadJson<{ sourcing: unknown; services: unknown[] }>(servicesPath);

  const existingTownCodes = new Set(townsFile.towns.map((t) => t.code));
  const existingServiceIds = new Set(
    (servicesFile.services as Array<{ serviceId: string }>).map((s) => s.serviceId),
  );

  for (const { config, services, fareCells, dropped, included } of results) {
    console.log(`\n=== ${config.tatakCorridorId} ===`);
    console.log(`included: ${included.length}`);
    included.forEach((line) => console.log(`  + ${line}`));
    console.log(`dropped: ${dropped.length}`);
    dropped.forEach((line) => console.log(`  - ${line}`));

    if (services.length === 0) {
      console.log(`no bookable service found; nothing written for ${config.tatakCorridorId}`);
      continue;
    }

    for (const town of config.towns) {
      if (!existingTownCodes.has(town.code)) {
        townsFile.towns.push(town);
        existingTownCodes.add(town.code);
      }
    }

    for (const point of config.points) {
      const townCode = config.towns[0].code;
      pointsFile.points[townCode] = pointsFile.points[townCode] ?? [];
      if (!pointsFile.points[townCode].some((p) => p.boardingPointId === point.boardingPointId)) {
        pointsFile.points[townCode].push({
          boardingPointId: point.boardingPointId,
          name: point.name,
          nameLocal: point.nameLocal,
          gps: point.gps,
        });
      }
    }

    for (const service of services) {
      if (!existingServiceIds.has(service.serviceId)) {
        (servicesFile.services as unknown[]).push(service);
        existingServiceIds.add(service.serviceId);
      }
    }

    const fareTablePath = join(FIXTURE_ROOT, "fares", `${config.fareTableId}.json`);
    const fareTable = {
      sourcing: {
        note: `Every cell here is the boarding-pair x class fare Tatak's own generated GTFS for ${config.tatakCorridorId} carries for the real, non-ambiguous service numbers this file's services.json entries use. Generated by scripts/generate-ksrtc-fixtures.ts from ../Tatak/data/intercity/${config.tatakDir}/fare_products.txt; a cell's own sourcing label (V, S or I) is carried through from Tatak's tatak_sourcing column, with a Tatak V (operator's own published page) kept as V, and a Tatak P (the project owner's own paid receipt) downgraded to S since it is not the operator's own price list. No cell here was interpolated or invented by this generator; a boarding pair with no Tatak fare cell for a class has no cell here either, and that class's service is simply not generated (see the drop log printed when this script runs).`,
        label: "S" as const,
      },
      fareTable: {
        fareTableId: config.fareTableId,
        currency: "INR",
        fares: fareCells,
      },
    };
    writeFileSync(fareTablePath, `${JSON.stringify(fareTable, null, 2)}\n`);
    console.log(`wrote ${fareTablePath} (${fareCells.length} cells)`);
  }

  writeFileSync(townsPath, `${JSON.stringify(townsFile, null, 2)}\n`);
  writeFileSync(pointsPath, `${JSON.stringify(pointsFile, null, 2)}\n`);
  writeFileSync(servicesPath, `${JSON.stringify(servicesFile, null, 2)}\n`);
  console.log("\nwrote towns.json, boarding-points.json, services.json");
}

main();
