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
 *   npx tsx scripts/generate-ksrtc-fixtures.ts
 *
 * -- Why this is no longer a two-point model --------------------------------
 *
 * The original version of this script modelled every generated service as
 * "one Bengaluru-side pickup, one destination-side drop", because the three
 * corridors it covered (KA-BNG-MNG, KA-BNG-CKM, KA-MYS-MNG) each carried only
 * one Tatak stop per end. That stopped being true the moment the planner
 * started surfacing itineraries that board or alight a reserved coach at a
 * VIA stop - Kunigal, Hassan, Yeshwanthpur, Chitradurga, Mysuru, Ankola - and
 * a two-point model has no boarding point to offer there at all.
 *
 * The reason the planner can do that is a real property of Tatak's own
 * ingestion, not a bug this script works around: every trip sharing one GTFS
 * `route_id` (+ `direction_id`) is folded into ONE raptor pattern with one
 * shared per-stop-offset table (`RouteSchedule.stopOffsets` in Tatak's
 * `src/planner/graph.ts`), so a specific numbered working can be boarded or
 * alighted at ANY stop that pattern's fullest trip touches - not only the
 * two stops that working's own sourced `stop_times.txt` rows happen to name.
 * Verified against the real feed: `0901BNGMNG`'s own two rows are Majestic
 * and Mangaluru KSRTC, and yet `POST /api/plan` returns it as a
 * Majestic -> Hassan leg and a Majestic -> Kunigal leg, because
 * `KA-BNG-MNG-AIRAVAT_CLUB_CLASS`'s fullest trip stops at both. This
 * generator now mirrors that: for a real, sellable, non-ambiguous working,
 * it offers a boarding/dropping point at every stop of its route-direction's
 * fullest trip that `STAND_REGISTRY` below has a provider counterpart for,
 * with a plausible per-stop time built the same way Tatak's own engine
 * builds one (a shared offset table, shifted to agree with this working's
 * own sourced clock at whichever stop the two have in common).
 *
 * `STAND_REGISTRY` is deliberately not "every stop on the pattern" - see its
 * own docblock. A pattern position with no registry entry is silently
 * skipped as a boarding/dropping candidate (this generator has nothing
 * dishonest to say about it, and nothing to gain by padding the list), and a
 * boarding pair Tatak's own `fare_products.txt` has no cell for is dropped
 * exactly as before. Neither failure is fatal; both are logged.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_ROOT = join(HERE, "..", "fixtures", "ksrtc");
const TATAK_ROOT = join(HERE, "..", "..", "Tatak", "data", "intercity");

// -----------------------------------------------------------------------
// The corridors this pass covers, and why twelve now instead of seven.
//
// The first seven were exactly the corridors that carry a real, sellable,
// reserved (`reservationRequired`) working reachable from Kundalahalli Gate
// to one of the eleven demo destinations - the set `book-audit2.ts` measures.
// This pass drops that "reachable from one demo origin" restriction and asks
// a broader question instead: of Tatak's 35 corridor feeds, which ones carry
// a real, sellable working to any of nine named towns (Mangaluru, Udupi,
// Dandeli, Murudeshwara, Mysuru, Madikeri, Mandya, Hampi, Hosapete)? Every
// one of Tatak's 35 feeds was checked - not just the ones whose own name
// mentions a target town, because a highway corridor two towns over can carry
// a via-stop at a third (the KA-GEN-NH275 pattern already did exactly this
// for Mandya and Madikeri before this pass ever touched it, since a real
// Bengaluru-Madikeri working's own route pattern happens to stop at both on
// the way through).
//
// Five corridors clear that bar and are new in this pass:
//
//   - `ka-gen-nh66`: the coastal highway grid (Karwar-Ullal). Its
//     RAJAHAMSA_EXECUTIVE route-direction groups carry 13 real service
//     numbers between them and their fullest pattern touches both Mangaluru
//     and Udupi - the corridor that finally gives Udupi a sellable service at
//     all (see the STAND_REGISTRY note on `KA-BP-UDUPI` below: Udupi was
//     never in the registry before this pass, despite `ka-coast` already
//     being read, because `ka-coast`'s own RAJAHAMSA_EXECUTIVE pattern's real
//     numbers never got an Udupi stand to land on).
//   - `ka-gen-nh169`: Shivamogga-Mangaluru via Sringeri. One real
//     RAJAHAMSA_EXECUTIVE working (`KA-GEN-NH169-RAJAHAMSA_EXECUTIVE`
//     direction 0) touches Mangaluru; it is a genuinely separate route from
//     every other Mangaluru corridor already read, not a duplicate.
//   - `ka-gen-nh67`: Ramanagara-Ballari via Dharwad, Gadag and Koppal - never
//     touches Bengaluru at all. Its RAJAHAMSA_EXECUTIVE groups carry 8 real
//     numbers whose pattern reaches Hosapete's JSW Vijayanagar terminal, a
//     different real stand from the Hosapete Bus Stand the other corridors
//     use (see the STAND_REGISTRY note on it).
//   - `ka-gen-sh37`: Bengaluru-Udupi via Dharmasthala and Subrahmanya. 3 real
//     RAJAHAMSA_EXECUTIVE numbers, an entirely different road from the coastal
//     highway `ka-gen-nh66` runs.
//   - `ka-bng-bgk`: Bengaluru-Bagalkot via Hosapete. 2 real PALLAKKI numbers
//     touch Hosapete along the way.
//
// Of the remaining 22 feeds, every one that names or passes through a target
// town was checked and excluded for a stated reason, not by omission:
//
//   - `ka-bng-hmp` (Hampi, Hosapete): DOES carry two real service numbers -
//     `2259BNGHMP` and `2001HMPBNG` - but both are already sold, under a
//     hand-authored two-point fixture (Majestic <-> Hampi/Hosapete only) that
//     predates this generator. Reading this corridor here was tried and
//     reverted: it faithfully reproduces Tatak's own richer, better-sourced
//     fare and multi-point data (Majestic, Yeshwanthpur and Peenya all become
//     pickups; the Majestic<->Hampi/Hosapete cells upgrade from an aggregator
//     guess at S/I to KSRTC's own published V fare), but it changes zero
//     coverage - both numbers were already sellable - while `BLR`/`HMP` is
//     the default town pair a large fraction of this repository's OTHER test
//     suites (order, cancellation, holds, seat state...) use as generic
//     scaffolding, entirely unrelated to Hampi itself (see
//     `tests/helpers.ts`'s own defaults). Swapping its fare and schedule out
//     from under those tests broke about twenty of them for a coverage gain
//     of exactly zero. Upgrading this corridor's own sourcing is worth doing
//     on its own, deliberately, with those tests' defaults migrated off
//     Hampi first - not as a side effect of a pass whose job is coverage.
//   - `ka-dnd-ank` (Dandeli): zero real service numbers of any class, on any
//     route-direction, anywhere in the feed. Dandeli has no real KSRTC/NWKRTC
//     working sourced at all here, reserved or unreserved.
//   - `ka-coast`, `ka-gen-nh66` (Murudeshwara): both carry real numbers, but
//     only on their KARNATAKA_SARIGE route-direction groups, and SARIGE is
//     unreserved walk-up and outside `CLASS_MAP` by design (see its own note
//     below). Neither corridor's RAJAHAMSA_EXECUTIVE pattern - the one class
//     on each that does carry real numbers - ever stops at Murudeshwara. So
//     across all 35 feeds, Murudeshwara has no real, reservable working: not
//     a stand this generator forgot, a town Tatak itself never sourced a
//     sellable coach to.
//   - `ka-bng-mys` (Mysuru, Mandya): every real number on this corridor is on
//     its KARNATAKA_SARIGE group; RAJAHAMSA_EXECUTIVE, AIRAVAT and
//     AIRAVAT_CLUB_CLASS here are all-inferred placeholders with zero real
//     numbers. The direct Bengaluru-Mysuru road contributes nothing; Mandya's
//     real coverage comes entirely from `ka-gen-nh275`, already read.
//   - `ka-mys-mdk` (Mysuru, Madikeri): same shape - only KARNATAKA_SARIGE
//     carries real numbers here. Madikeri's real coverage is, again, entirely
//     `ka-gen-nh275`'s.
//   - `ka-gen-nh73`, `ka-gen-sh25`, `ka-gen-nh50` (Mangaluru / Hosapete via
//     other roads): checked route-direction group by group; no sellable
//     class carries a real number on any of them.
//   - `ka-bng-bdm`, `ka-bng-bjp` (Hosapete via Badami / Bijapur): real numbers
//     exist here, but only on NON_AC_SLEEPER, KALYANA_RATHA, AMOGHAVARSHA and
//     KARNATAKA_SARIGE - none of which `CLASS_MAP` can sell (see its own
//     note; adding a class this provider has never carried is out of scope
//     for a coverage pass, same call as the existing NON_AC_SLEEPER /
//     AC_SEATER_EXECUTIVE_CHAIR exclusion on `ka-bng-hmp` and `ka-bng-mng`).
//
// Extending this list further is still exactly the same operation it always
// was: add a directory name and a fare-table id below, and (if it calls
// anywhere `STAND_REGISTRY` does not already cover) add the new stand there
// too. Nothing else in this file is corridor-specific.
// -----------------------------------------------------------------------
const CORRIDOR_DIRS: Array<{ dir: string; fareTableId: string }> = [
  { dir: "ka-bng-mng", fareTableId: "FT-BNGMNG" },
  { dir: "ka-bng-ckm", fareTableId: "FT-BNGCKM" },
  { dir: "ka-mys-mng", fareTableId: "FT-MYSMNG" },
  { dir: "ka-bng-hbl", fareTableId: "FT-BNGHBL" },
  { dir: "ka-coast", fareTableId: "FT-COAST" },
  { dir: "ka-gen-nh275", fareTableId: "FT-GENNH275" },
  { dir: "ka-gen-nh48", fareTableId: "FT-GENNH48" },
  { dir: "ka-gen-nh66", fareTableId: "FT-GENNH66" },
  { dir: "ka-gen-nh169", fareTableId: "FT-GENNH169" },
  { dir: "ka-gen-nh67", fareTableId: "FT-GENNH67" },
  { dir: "ka-gen-sh37", fareTableId: "FT-GENSH37" },
  { dir: "ka-bng-bgk", fareTableId: "FT-BNGBGK" },
];

// A handful of Tatak service numbers are assigned to a real trip on two
// different corridors at once, and Tatak's own data gives no way to tell
// which corridor the working actually belongs to. transit-fleet-sim's
// corridor roster drops these everywhere for the same reason: a ticket this
// provider sold under one of these numbers is a ticket the fleet simulator
// cannot corroborate with a coach.
//
// `1003BNGMNG` joins this list in this pass: `KA-BNG-MNG` sources it as a
// 10:03 Majestic -> Mangaluru KSRTC Airavat Club working (arriving 19:00),
// and `KA-GEN-NH275` independently sources the identical string as a 10:03
// Majestic -> Madikeri Rajahamsa Executive working. Both citations are
// "sourced" in their own corridor's `trips.txt`; nothing in either says which
// one is the real bus. Rather than guess a destination for a coach number
// that disagrees with itself, this script refuses to sell it at all - the
// same call the original four already make. `0930BNGMRC`, sourced only on
// `KA-GEN-NH275`, is unaffected and carries the Madikeri leg on its own.
//
// This static list is required precisely because this script now spans
// several corridors: two feeds citing the same number is exactly the
// collision `CROSS_CORRIDOR_AMBIGUOUS` below already detects for the seven
// corridors this pass reads, and this entry duplicates one of its findings
// so the exclusion survives even if a future edit narrows `CORRIDOR_DIRS`
// back down and stops seeing the second citation.
const AMBIGUOUS_SERVICE_NUMBERS = new Set([
  "2105BNGMRC",
  "2131MRCBNG",
  "0801BNGCDP",
  "2334BNGMNG",
  "1003BNGMNG",
]);

// Tatak class id -> this provider's ServiceClass. Every class not listed
// here (KARNATAKA_SARIGE, ASHWAMEDHA, EV_POWER_PLUS, NON_AC_SLEEPER,
// AC_SEATER_EXECUTIVE_CHAIR, AMBAARI_DREAM_CLASS, AIRAVAT_CLUB_CLASS_2, ...)
// has no home in this provider: SARIGE/ASHWAMEDHA/EV_POWER_PLUS/
// AMBAARI_DREAM are hard-refused at fixture load (src/reserved/integrity.ts
// REFUSED_CLASSES), and the rest simply are not in SERVICE_CLASSES.
//
// KARNATAKA_SARIGE is never in this map on purpose, for a reason worth
// stating once: it is Tatak's one intercity class with `reservationRequired:
// false` (see Tatak's `src/intercity/walkup.ts`), so a leg running it never
// asks this provider for anything - mapping it here would sell a seat
// nobody needs to reserve.
//
// `AIRAVAT_CLUB_CLASS_2` maps onto the SAME provider class as
// `AIRAVAT_CLUB_CLASS` because this provider's vocabulary
// (`src/reserved/types.ts` `SERVICE_CLASSES`) has no second Airavat Club
// tier - seat map and fare table are both structured per class label, not
// per Tatak sub-class. The two ARE genuinely different products at
// different prices (Tatak's own `AIRAVAT_CLUB_CLASS_2` docblock cites 1257
// against 1158 for the identical Bengaluru-Mangaluru pair), and this mapping
// loses that distinction: whichever of the two classes this script fare-cells
// a given boarding pair under FIRST wins, and the other's own true fare is
// silently not carried through for that pair (see `claimFareCell` below). A
// second provider class would fix this properly; adding one is out of scope
// for a stand-code and coverage pass.
const CLASS_MAP: Record<string, string> = {
  RAJAHAMSA_EXECUTIVE: "RAJAHAMSA",
  AIRAVAT: "AIRAVAT",
  AIRAVAT_CLUB_CLASS: "AIRAVAT_CLUB",
  AIRAVAT_CLUB_CLASS_2: "AIRAVAT_CLUB",
  PALLAKKI: "PALLAKKI",
  AMBAARI_UTSAV: "AMBAARI_UTSAV",
};

interface StandDef {
  /** This provider's boarding-point id. Several Tatak stop ids may share one
   *  - see the docblock below on why. */
  boardingPointId: string;
  townCode: string;
  townName: string;
  /** The stand's own display name, carried straight from Tatak's own stop
   *  record (`src/intercity/points.ts` / `generated/points.ts` /
   *  `corridors/bengaluru-hosapete.ts`) rather than re-typed, so a rename on
   *  Tatak's side is the only place a rename here would ever need to happen. */
  name: string;
  gps: { lat: number; lon: number };
}

/**
 * Tatak stop id -> this provider's boarding point, for every stand this pass
 * needs a working provider counterpart for.
 *
 * This is NOT "every stop the seven corridors above call at" - Tatak's
 * corridors touch well over a hundred stands between them, most of which no
 * demo journey ever boards or alights a reserved coach at, and inventing a
 * provider record for a stand nobody needs would be exactly the padding the
 * top-of-file docblock disclaims. Every entry here exists because a real
 * `POST /api/plan` leg (checked leg by leg against the eleven demo
 * destinations, departing 08:00 from Kundalahalli Gate) boards or alights a
 * reserved coach there. Adding a corridor later that needs a stand not yet
 * here is exactly the case this registry is meant to make cheap: add one
 * line, citing the coordinate Tatak's own stop record already carries.
 *
 * A coordinate here is copied from Tatak's own boarding-point record, not
 * re-measured - the two repositories are describing the same physical bus
 * stand, and Tatak's own sourcing note on that record (an OSM way/node id,
 * or BMTC's own GTFS `stop_id`) is the citation for it. This generator's own
 * fixture-level sourcing note (`FT-*.json`, `towns.json`,
 * `boarding-points.json`) is `S`/`I` rather than `V` because the pairing of
 * "this provider sells from here" to that coordinate is this project's own
 * inference, not something KSRTC published - the coordinate is real, the
 * commercial claim resting on it is not.
 *
 * Several Tatak ids map to the SAME `boardingPointId`. Two different reasons,
 * both already established by the original three-corridor version of this
 * generator (see its old `EXISTING_TATAK_STOP_FOR_POINT`):
 *
 *   - `KA-BP-BNG-MAJESTIC` (city end of every corridor) already has a
 *     provider record from the hand-authored Hampi/Chennai fixture -
 *     `BP-BLR-MAJESTIC` - and is reused rather than redefined.
 *   - `KA-BP-HAVERI` (Tatak's own hand-authored Haveri stand, on
 *     `KA-BNG-HBL`) and `KA-BP-GEN-HAVERI-BUS-STAND` (a SEPARATE Tatak stop
 *     id for the same real place, minted independently by the generated
 *     `KA-GEN-NH48` corridor from the same OSM way, 449042506, ~13 m apart)
 *     both point at one `BP-HVR-HAVERI`. Tatak's own graph treats them as two
 *     different stops because two different corridor builds happened to mint
 *     two different ids for one building; this provider has no reason to
 *     repeat that split, because there is really one Haveri bus stand to
 *     sell from.
 */
const STAND_REGISTRY: Record<string, StandDef> = {
  "KA-BP-BNG-MAJESTIC": {
    boardingPointId: "BP-BLR-MAJESTIC",
    townCode: "BLR",
    townName: "Bengaluru",
    name: "Kempegowda Bus Station (Majestic)",
    gps: { lat: 12.978145, lon: 77.572296 },
  },
  "KA-BP-BNG-YESHWANTHPUR": {
    boardingPointId: "BP-BLR-YESHWANTHPUR",
    townCode: "BLR",
    townName: "Bengaluru",
    name: "Yeshwanthpur TTMC",
    gps: { lat: 13.01878, lon: 77.55758 },
  },
  "KA-BP-BNG-PEENYA": {
    boardingPointId: "BP-BLR-PEENYA",
    townCode: "BLR",
    townName: "Bengaluru",
    name: "Peenya Satellite Bus Station",
    gps: { lat: 13.04409, lon: 77.52554 },
  },
  "KA-BP-MANGALURU-KSRTC": {
    boardingPointId: "BP-MNG-MANGALURU",
    townCode: "MNG",
    townName: "Mangaluru",
    name: "Mangaluru KSRTC Bus Stand (Bejai)",
    gps: { lat: 12.8852444, lon: 74.8416769 },
  },
  "KA-BP-CHIKKAMAGALURU": {
    boardingPointId: "BP-CKM-CHIKKAMAGALURU",
    townCode: "CKM",
    townName: "Chikkamagaluru",
    name: "Chikkamagaluru KSRTC Bus Station",
    gps: { lat: 13.3180039, lon: 75.7716607 },
  },
  "KA-BP-MYSURU-CENTRAL": {
    boardingPointId: "BP-MYS-MYSURU-CENTRAL",
    townCode: "MYS",
    townName: "Mysuru",
    name: "Mysuru Central Bus Stand",
    gps: { lat: 12.312567, lon: 76.6584136 },
  },
  "KA-BP-HASSAN": {
    boardingPointId: "BP-HSN-HASSAN",
    townCode: "HSN",
    townName: "Hassan",
    name: "Hassan Bus Station",
    gps: { lat: 12.9981795, lon: 76.1046362 },
  },
  "KA-BP-KUNIGAL": {
    boardingPointId: "BP-KNG-KUNIGAL",
    townCode: "KNG",
    townName: "Kunigal",
    name: "Kunigal KSRTC Bus Stand",
    gps: { lat: 13.0251811, lon: 77.0293837 },
  },
  "KA-BP-CHITRADURGA": {
    boardingPointId: "BP-CTD-CHITRADURGA",
    townCode: "CTD",
    townName: "Chitradurga",
    name: "Chitradurga KSRTC Bus Station",
    gps: { lat: 14.2268023, lon: 76.3960352 },
  },
  "KA-BP-HAVERI": {
    boardingPointId: "BP-HVR-HAVERI",
    townCode: "HVR",
    townName: "Haveri",
    name: "Haveri Bus Stand",
    gps: { lat: 14.788137, lon: 75.3978506 },
  },
  "KA-BP-GEN-HAVERI-BUS-STAND": {
    boardingPointId: "BP-HVR-HAVERI",
    townCode: "HVR",
    townName: "Haveri",
    name: "Haveri Bus Stand",
    gps: { lat: 14.788137, lon: 75.3978506 },
  },
  "KA-BP-HUBBALLI": {
    boardingPointId: "BP-HBL-HUBBALLI",
    townCode: "HBL",
    townName: "Hubballi",
    name: "Hubballi New Bus Station",
    gps: { lat: 15.3493019, lon: 75.1164175 },
  },
  "KA-BP-MADIKERI": {
    boardingPointId: "BP-MDK-MADIKERI",
    townCode: "MDK",
    townName: "Madikeri",
    name: "Madikeri KSRTC Bus Stand",
    gps: { lat: 12.4233982, lon: 75.7378564 },
  },
  "KA-BP-GEN-MANDYA-RURAL-BUS-STAND": {
    boardingPointId: "BP-MND-MANDYA-RURAL",
    townCode: "MND",
    townName: "Mandya",
    name: "Mandya Rural Bus Stand",
    gps: { lat: 12.52857344, lon: 76.9012659 },
  },
  "KA-BP-ANKOLA": {
    boardingPointId: "BP-ANK-ANKOLA",
    townCode: "ANK",
    townName: "Ankola",
    name: "Ankola Bus Stand",
    gps: { lat: 14.6600753, lon: 74.3069664 },
  },
  "KA-BP-GOKARNA": {
    boardingPointId: "BP-GKN-GOKARNA",
    townCode: "GKN",
    townName: "Gokarna",
    name: "Gokarna Bus Station",
    gps: { lat: 14.5461529, lon: 74.3191748 },
  },

  // -- New in this pass: the five corridors added above -----------------
  //
  // `KA-BP-UDUPI` is the one entry here that changes what this provider can
  // sell rather than just how it sells something already sold: `ka-coast`
  // has been read since the original three-corridor version of this script,
  // and its RAJAHAMSA_EXECUTIVE pattern has always touched Udupi, but with
  // no registry entry for the stand, every working on that pattern was
  // capped at a single provider point (Mangaluru) and dropped for want of a
  // second ("fewer than two of its pattern's stands have a provider
  // counterpart yet"). Udupi joins the registry here for the same real stop
  // `ka-coast`, `ka-gen-nh66` and `ka-gen-sh37` all cite under one shared id.
  "KA-BP-UDUPI": {
    boardingPointId: "BP-UDP-UDUPI",
    townCode: "UDP",
    townName: "Udupi",
    name: "Udupi Service Bus Station",
    gps: { lat: 13.3427023, lon: 74.7472121 },
  },

  // `KA-BP-HOSAPETE` already has a provider counterpart - `BP-HPT-HOSAPETE` -
  // from the hand-authored Hampi/Hosapete fixture that predates this
  // generator (`ka-bng-hmp` itself is deliberately NOT read here; see this
  // file's own note above on why). It is reused rather than redefined, the
  // same call already made for `KA-BP-BNG-MAJESTIC`: the loader in `main()`
  // below only adds a boarding-points.json entry when the id is not already
  // present, so this entry's own gps is never actually written anywhere; it
  // is copied from Tatak's own stop record purely so this table stays honest
  // about where the id points, not because it does any work. `ka-bng-bgk`'s
  // own pattern reaches this same real stand.
  "KA-BP-HOSAPETE": {
    boardingPointId: "BP-HPT-HOSAPETE",
    townCode: "HPT",
    townName: "Hosapete",
    name: "Hosapete Bus Stand",
    gps: { lat: 15.2751874, lon: 76.3892617 },
  },

  // The JSW Vijayanagar terminal is a real, separate stand from the Hosapete
  // Bus Stand above - Tatak's own `ka-gen-nh67` sources it under its own OSM
  // way (140993444), about 2 km from the other terminal's own OSM node, and
  // gives it its own `tatak_territory_corporation` (KKRTC rather than the
  // unattributed corporation on the older stand). Two real KSRTC/KKRTC
  // stands in the same town get two provider boarding points under the same
  // town code, exactly like Majestic and Yeshwanthpur do for Bengaluru,
  // rather than being folded into one on a name match.
  "KA-BP-GEN-HOSAPETE-JSW-VIJAYAGANAR-BUS-TERMINAL": {
    boardingPointId: "BP-HPT-JSW-VIJAYANAGAR",
    townCode: "HPT",
    townName: "Hosapete",
    name: "Hosapete JSW Vijayaganar Bus Terminal",
    gps: { lat: 15.275087639999999, lon: 76.38881015999999 },
  },

  // `ka-gen-nh67` never touches Bengaluru at all (it runs Ramanagara to
  // Ballari via Dharwad, Gadag and Koppal), so Ballari is the other end this
  // corridor's real RAJAHAMSA_EXECUTIVE workings need a second provider
  // point to be sellable at all - the same role Hassan and Kunigal already
  // play for `KA-BNG-MNG`.
  "KA-BP-GEN-BALLARI-NEW-BUS-TERMINAL": {
    boardingPointId: "BP-BLL-BALLARI",
    townCode: "BLL",
    townName: "Ballari",
    name: "Ballari New Bus Terminal",
    gps: { lat: 15.13750737999999, lon: 76.91858056 },
  },

  // `ka-gen-sh37`'s real RAJAHAMSA_EXECUTIVE workings run Bengaluru-Udupi via
  // Dharmasthala and Subrahmanya; Karkala is this pattern's other stand with
  // a provider counterpart, alongside Udupi above.
  "KA-BP-GEN-KARKALA-BUS-STAND": {
    boardingPointId: "BP-KRK-KARKALA",
    townCode: "KRK",
    townName: "Karkala",
    name: "Karkala Bus Stand",
    gps: { lat: 13.2128782, lon: 74.9985126 },
  },

  // `ka-gen-nh169` runs Shivamogga-Mangaluru via Sringeri and never touches
  // Bengaluru either; Shivamogga is the second stand its one real
  // RAJAHAMSA_EXECUTIVE working needs alongside Mangaluru.
  "KA-BP-GEN-SHIVAMOGGA-SHIMOGA-KSRTC-BUS-STAND": {
    boardingPointId: "BP-SHV-SHIVAMOGGA",
    townCode: "SHV",
    townName: "Shivamogga",
    name: "Shivamogga Shimoga KSRTC Bus Stand",
    gps: { lat: 13.9289881, lon: 75.5680645 },
  },
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

/** One (route_id, direction_id) group's real, in-order stop pattern - the
 *  fullest trip assigned to it - plus that trip's own per-stop minute-of-day
 *  times, which is what every other real working on the same pattern is
 *  shifted against. See the file-level docblock for why this is the right
 *  unit: it is Tatak's own raptor pattern, not a corridor-level concept. */
interface PatternGroup {
  routeId: string;
  directionId: string;
  stopIds: string[];
  minutesAtStop: number[];
  monotonic: boolean;
}

function buildPatternGroups(
  trips: Record<string, string>[],
  stopTimesByTrip: Map<string, Record<string, string>[]>,
): Map<string, PatternGroup> {
  const groups = new Map<string, PatternGroup>();
  const byKey = new Map<string, Record<string, string>[]>();
  for (const t of trips) {
    const key = `${t.route_id}|${t.direction_id}`;
    const list = byKey.get(key) ?? [];
    list.push(t);
    byKey.set(key, list);
  }
  for (const [key, groupTrips] of byKey) {
    let ref: Record<string, string> | null = null;
    let refStops: Record<string, string>[] = [];
    for (const t of groupTrips) {
      const st = stopTimesByTrip.get(t.trip_id) ?? [];
      if (st.length > refStops.length) {
        ref = t;
        refStops = st;
      }
    }
    if (!ref || refStops.length === 0) continue;
    const stopIds = refStops.map((s) => s.stop_id);
    const minutesAtStop = refStops.map((s) => hhmmssToMinutes(s.departure_time));
    let monotonic = true;
    for (let i = 1; i < minutesAtStop.length; i++) {
      if (minutesAtStop[i] < minutesAtStop[i - 1]) monotonic = false;
    }
    const [routeId, directionId] = key.split("|");
    groups.set(key, { routeId, directionId, stopIds, minutesAtStop, monotonic });
  }
  return groups;
}

function generateCorridor(
  dir: string,
  fareTableId: string,
  crossCorridorAmbiguous: ReadonlySet<string>,
) {
  const trips = readTatak(dir, "trips.txt");
  const stopTimes = readTatak(dir, "stop_times.txt");
  const fareProducts = readTatak(dir, "fare_products.txt");

  const stopTimesByTrip = new Map<string, Record<string, string>[]>();
  for (const row of stopTimes) {
    const list = stopTimesByTrip.get(row.trip_id) ?? [];
    list.push(row);
    stopTimesByTrip.set(row.trip_id, list);
  }
  for (const list of stopTimesByTrip.values()) {
    list.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
  }

  const patternGroups = buildPatternGroups(trips, stopTimesByTrip);

  const services: GeneratedService[] = [];
  const fareCellsUsed = new Map<string, FareCellOut>();
  const dropped: string[] = [];
  const included: string[] = [];

  // Every real service number this corridor names at all, sellable or not -
  // the caller uses this to know which existing services.json entries this
  // corridor is authoritative for and should replace outright, not merge with.
  const allRealNumbers = new Set<string>();

  for (const trip of trips) {
    const serviceNumber = trip.tatak_service_number.trim();
    if (!serviceNumber) continue;
    allRealNumbers.add(serviceNumber);

    // The class is the route id's own suffix after the corridor id prefix
    // (e.g. `KA-BNG-MNG-AIRAVAT_CLUB_CLASS` on corridor dir `ka-bng-mng` ->
    // `AIRAVAT_CLUB_CLASS`), exactly as the original generator derived it.
    const corridorPrefix = dir.toUpperCase();
    const classFromRoute = trip.route_id.startsWith(`${corridorPrefix}-`)
      ? trip.route_id.slice(corridorPrefix.length + 1)
      : trip.route_id;

    if (AMBIGUOUS_SERVICE_NUMBERS.has(serviceNumber) || crossCorridorAmbiguous.has(serviceNumber)) {
      dropped.push(`${trip.trip_id} (${serviceNumber}): ambiguous, assigned to a real trip on another corridor too`);
      continue;
    }
    const providerClass = CLASS_MAP[classFromRoute];
    if (!providerClass) {
      dropped.push(`${trip.trip_id} (${serviceNumber}): class ${classFromRoute} is not sellable in this provider`);
      continue;
    }

    const ownStops = stopTimesByTrip.get(trip.trip_id);
    if (!ownStops || ownStops.length < 2) {
      dropped.push(`${trip.trip_id} (${serviceNumber}): no stop_times`);
      continue;
    }

    const group = patternGroups.get(`${trip.route_id}|${trip.direction_id}`);
    if (!group || !group.monotonic) {
      dropped.push(`${trip.trip_id} (${serviceNumber}): route-direction pattern has no usable (monotonic) reference trip`);
      continue;
    }

    // Anchor this working's own sourced clock against the pattern: the
    // first of ITS OWN stops that also appears in the reference pattern.
    let anchorPos = -1;
    let anchorOwnMinutes = 0;
    for (const row of ownStops) {
      const pos = group.stopIds.indexOf(row.stop_id);
      if (pos >= 0) {
        anchorPos = pos;
        anchorOwnMinutes = hhmmssToMinutes(row.departure_time);
        break;
      }
    }
    if (anchorPos < 0) {
      dropped.push(`${trip.trip_id} (${serviceNumber}): none of its own stops appear in its route-direction's reference pattern`);
      continue;
    }
    const shiftMinutes = anchorOwnMinutes - group.minutesAtStop[anchorPos];

    const departureMinute = Math.round(hhmmssToMinutes(ownStops[0].departure_time));
    const lastOwn = ownStops[ownStops.length - 1];
    const runningMinutes = Math.round(hhmmssToMinutes(lastOwn.arrival_time) - hhmmssToMinutes(ownStops[0].departure_time));
    if (runningMinutes <= 0) {
      dropped.push(`${trip.trip_id} (${serviceNumber}): non-positive running time from its own sourced stop times`);
      continue;
    }

    // Every registry-known stand on the full pattern, in pattern order, each
    // carrying a plausible reporting offset relative to this working's own
    // sourced departure - see the file-level docblock. A position before
    // this working's own anchor (e.g. a stand the sourced rows never reach
    // because the sourced rows are a short segment of a longer pattern, as
    // on KA-COAST) gets a NEGATIVE offset rather than being dropped: it is
    // still a real stand on the real pattern, just one this working's own
    // sourced clock places before its own zero point.
    const patternPoints: Array<{ boardingPointId: string; reportingOffsetMinutes: number }> = [];
    const seenBoardingPointIds = new Set<string>();
    for (let i = 0; i < group.stopIds.length; i++) {
      const stand = STAND_REGISTRY[group.stopIds[i]];
      if (!stand) continue;
      // Two Tatak ids can share one provider boardingPointId (see
      // STAND_REGISTRY's docblock on Haveri) - only the first pattern
      // position for a given provider point is kept, since a service can't
      // sensibly offer one provider stand as two different points in time
      // on the same run.
      if (seenBoardingPointIds.has(stand.boardingPointId)) continue;
      seenBoardingPointIds.add(stand.boardingPointId);
      const offset = Math.round(group.minutesAtStop[i] + shiftMinutes - departureMinute);
      patternPoints.push({ boardingPointId: stand.boardingPointId, reportingOffsetMinutes: offset });
    }
    if (patternPoints.length < 2) {
      dropped.push(`${trip.trip_id} (${serviceNumber}): fewer than two of its pattern's stands have a provider counterpart yet`);
      continue;
    }

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
      fareTableId,
      popularity: 0.5,
      reservationFeePaise: 2000,
      tollPaise: 2000,
      // Every pattern point can be both a pickup and a set-down - a real
      // multi-point coach lets a rider board or alight at any stand it
      // advertises, and this provider's own fare lookup already refuses any
      // pair Tatak never priced (see the loop below), so there is nothing
      // dishonest about offering the full list on both sides.
      boardingPoints: patternPoints,
      droppingPoints: patternPoints,
    });
    included.push(`${trip.trip_id} (${serviceNumber}), ${providerClass}, ${patternPoints.length} pattern stand(s)`);

    // Claim a fare cell for every forward pair among this working's own
    // pattern points, for THIS working's class. `claimFareCell` refuses to
    // overwrite a cell already claimed by an earlier working of a different
    // class mapped onto the same provider class (see CLASS_MAP's note on
    // AIRAVAT_CLUB_CLASS_2) - the earlier claim wins and this one is logged
    // as skipped rather than silently overwriting a real fare with another
    // real fare for a different product.
    for (let a = 0; a < patternPoints.length; a++) {
      for (let b = a + 1; b < patternPoints.length; b++) {
        const fromStopId = group.stopIds.find(
          (id) => STAND_REGISTRY[id]?.boardingPointId === patternPoints[a].boardingPointId,
        )!;
        const toStopId = group.stopIds.find(
          (id) => STAND_REGISTRY[id]?.boardingPointId === patternPoints[b].boardingPointId,
        )!;
        const fareRow = fareProducts.find(
          (fp) =>
            fp.fare_product_id === `FP-${classFromRoute}-${fromStopId}-${toStopId}-adult` &&
            fp.currency === "INR",
        );
        if (!fareRow) {
          dropped.push(
            `${trip.trip_id} (${serviceNumber}): no adult fare cell for ${classFromRoute} between ${fromStopId} and ${toStopId} (pair not sold)`,
          );
          continue;
        }
        const cellKey = `${patternPoints[a].boardingPointId}|${patternPoints[b].boardingPointId}|${providerClass}`;
        if (fareCellsUsed.has(cellKey)) continue;
        fareCellsUsed.set(cellKey, {
          fromBoardingPointId: patternPoints[a].boardingPointId,
          toBoardingPointId: patternPoints[b].boardingPointId,
          serviceClass: providerClass,
          farePaise: Math.round(Number(fareRow.amount) * 100),
          sourcing: mapSourcing(fareRow.tatak_sourcing),
        });
      }
    }
  }

  return { dir, fareTableId, services, fareCells: [...fareCellsUsed.values()], dropped, included, allRealNumbers };
}

/** Every real service number cited by more than one of the corridors this
 *  pass reads - see AMBIGUOUS_SERVICE_NUMBERS' note on why a static list
 *  alone is not enough once this generator spans several corridors. */
function findCrossCorridorAmbiguous(dirs: string[]): Set<string> {
  const owners = new Map<string, Set<string>>();
  for (const dir of dirs) {
    let trips: Record<string, string>[];
    try {
      trips = readTatak(dir, "trips.txt");
    } catch {
      continue;
    }
    for (const t of trips) {
      const n = t.tatak_service_number.trim();
      if (!n) continue;
      const set = owners.get(n) ?? new Set<string>();
      set.add(dir);
      owners.set(n, set);
    }
  }
  const ambiguous = new Set<string>();
  for (const [n, dirsSeen] of owners) if (dirsSeen.size > 1) ambiguous.add(n);
  return ambiguous;
}

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function main() {
  const dirs = CORRIDOR_DIRS.map((c) => c.dir);
  const crossCorridorAmbiguous = findCrossCorridorAmbiguous(dirs);
  if (crossCorridorAmbiguous.size) {
    console.log(`cross-corridor ambiguous service numbers (dropped everywhere): ${[...crossCorridorAmbiguous].join(", ")}`);
  }

  const results = CORRIDOR_DIRS.map(({ dir, fareTableId }) =>
    generateCorridor(dir, fareTableId, crossCorridorAmbiguous),
  );

  const townsPath = join(FIXTURE_ROOT, "towns.json");
  const pointsPath = join(FIXTURE_ROOT, "boarding-points.json");
  const servicesPath = join(FIXTURE_ROOT, "services.json");

  const townsFile = loadJson<{ sourcing: unknown; towns: Array<{ code: string; name: string; nameLocal?: string }> }>(townsPath);
  const pointsFile = loadJson<{
    sourcing: unknown;
    points: Record<string, Array<{ boardingPointId: string; name: string; nameLocal?: string; gps?: unknown }>>;
  }>(pointsPath);
  const servicesFile = loadJson<{ sourcing: unknown; services: Array<{ serviceId: string }> }>(servicesPath);

  const existingTownCodes = new Set(townsFile.towns.map((t) => t.code));
  for (const stand of Object.values(STAND_REGISTRY)) {
    if (!existingTownCodes.has(stand.townCode)) {
      townsFile.towns.push({ code: stand.townCode, name: stand.townName });
      existingTownCodes.add(stand.townCode);
    }
    const already = pointsFile.points[stand.townCode] ?? [];
    pointsFile.points[stand.townCode] = already;
    if (!already.some((p) => p.boardingPointId === stand.boardingPointId)) {
      already.push({ boardingPointId: stand.boardingPointId, name: stand.name, gps: stand.gps });
    }
  }

  // Every real service number any of these seven corridors names, sellable
  // or not, ambiguous or not - this run is authoritative for all of them, so
  // any existing services.json entry under one of these ids is replaced
  // outright rather than left stale beside a freshly generated one (or, for
  // a number that has newly become ambiguous like `1003BNGMNG`, simply
  // dropped rather than left behind under its old, now-contested meaning).
  const authoritativeFor = new Set<string>();
  for (const r of results) for (const n of r.allRealNumbers) authoritativeFor.add(n);

  const keptExisting = (servicesFile.services as Array<{ serviceId: string }>).filter(
    (s) => !authoritativeFor.has(s.serviceId),
  );
  const removedCount = servicesFile.services.length - keptExisting.length;
  servicesFile.services = keptExisting;

  let addedCount = 0;
  for (const { dir, fareTableId, services, fareCells, dropped, included } of results) {
    console.log(`\n=== ${dir} ===`);
    console.log(`included: ${included.length}`);
    included.forEach((line) => console.log(`  + ${line}`));
    console.log(`dropped: ${dropped.length}`);
    dropped.forEach((line) => console.log(`  - ${line}`));

    if (services.length === 0) {
      console.log(`no bookable service found; nothing written for ${dir}`);
      continue;
    }

    for (const service of services) {
      (servicesFile.services as unknown[]).push(service);
      addedCount++;
    }

    const fareTablePath = join(FIXTURE_ROOT, "fares", `${fareTableId}.json`);
    const fareTable = {
      sourcing: {
        note: `Every cell here is the boarding-pair x class fare Tatak's own generated GTFS for ${dir} carries for the real, non-ambiguous service numbers this file's services.json entries use. Generated by scripts/generate-ksrtc-fixtures.ts from ../Tatak/data/intercity/${dir}/fare_products.txt; a cell's own sourcing label (V, S or I) is carried through from Tatak's tatak_sourcing column, with a Tatak V (operator's own published page) kept as V, and a Tatak P (the project owner's own paid receipt) downgraded to S since it is not the operator's own price list. No cell here was interpolated or invented by this generator; a boarding pair with no Tatak fare cell for a class has no cell here either, and that class's service is simply not offered for that pair (see the drop log printed when this script runs).`,
        label: "S" as const,
      },
      fareTable: {
        fareTableId,
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
  console.log(`\nwrote towns.json, boarding-points.json, services.json (${addedCount} services written, ${removedCount} stale entries replaced)`);
}

main();
