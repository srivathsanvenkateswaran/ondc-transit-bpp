# Intercity Bus Reservation + Multi-Leg Journey UX Study

Research-only competitive study for Tatak's intercity bus reservation and multi-leg journey feature. No code was written and no project files were touched to produce this. Findings are drawn from live-app usability studies, design-team retrospectives (with real conversion numbers), consumer complaints, operator policy pages, and app documentation — sourced via three parallel web-research passes. Confidence is flagged per claim: **[confirmed]** = a source states the specific detail directly, **[general]** = stated in overview sources without screen-level specificity, **[inferred]** = my own synthesis across thin or converging sources.

---

## A. Intercity bus booking UX

### A.1 Redbus — the primary reference

**Search screen.** A recent UX audit found the "Top Locations" route-suggestion list surfacing geographically nonsensical routes (Gurgaon→Coimbatore as a suggested pair) **[confirmed]** — the recency/popularity logic isn't proximity-weighted.

**Results list.** No source confirmed the exact default sort order. What is confirmed: the price filter has "minimal visual indicators, making it difficult to identify budget-appropriate options" **[confirmed]**. A result card was found to truncate city names and sometimes drop the travel date entirely **[confirmed]** — a genuinely bad failure for a card whose whole job is orienting the user. On the seat-availability preview shown alongside a result, 5-user testing found only "grey = booked" registered; every other color in the legend (available, ladies-only, price-tier) did not land **[confirmed]**. Standard fields — operator name, star rating + review count, seats-left count — are plausible Redbus staples but weren't independently confirmed with screen-level detail in this pass.

**Seat map.**
- **Deck navigation, historical failure mode**: splitting upper/lower berths into separate tabs measured as the *lowest-converting step* in the entire booking funnel at MakeMyTrip (same problem class, not Redbus specifically) — users tabbed back and forth, selected a seat in one tab, then forgot about it while browsing the other **[confirmed, Go-MMT design blog]**.
- **Info-icon discoverability**: all 5 users in a Redbus usability test missed the "i" (seat-type info) icon entirely, and had no fast way to learn what a seat type or price differential meant **[confirmed]**.
- **Context loss on selection**: tapping a seat causes bus/route/amenity info to vanish from screen, and testers didn't consciously register it disappearing — just lost the context **[confirmed]**.
- **Gender/seat-type coding**: at time of testing, "no visual indicators distinguish between male-booked and female-booked seats, or between seater and sleeper configurations" **[confirmed]**.
- **The pale-pink problem — a first-person account**: a rider who accidentally booked a female-reserved seat during festival travel wrote: "The ladies seat is just like the available. The only difference being that the seat's border is a very pale pink!!!" He also noted the legend enumerates **fewer states than the seat map actually has** — a fourth, undocumented state existed on screen **[confirmed, consumer complaint]**. Redbus support's response was that "the gender warning message appears during booking" — a defensive answer that blames the user rather than fixing the affordance **[confirmed]**.
- **A 2024 "ladies-only" pilot** during online check-in reportedly highlights seats already booked by women in pink, so a solo woman can choose to sit beside another woman **[general]** — it's unclear whether this is the same near-invisible pink border the complainant described or a genuinely improved version; treat "we added pink" as insufficient on its own, since the failure mode was contrast and legend-completeness, not the absence of color.
- **Seat-lock mechanism (the good part)**: Redbus uses pessimistic locking — the instant a seat is tapped, it disappears from every other browsing session, not merely "shown as reserved with a visible countdown to others." A rider's own account of a booking session confirms a **5-minute checkout countdown timer**, after which an unpaid seat silently releases back to inventory **[confirmed]**. The concurrency problem is resolved server-side, so the UI never has to expose a race condition ("2 people viewing this seat") to anyone.
- **Price-per-seat**: varies by type/position/deck, confirmed to exist, but two independent reviewers separately found the reason for the variance opaque mid-selection, requiring several taps to understand **[confirmed]**.

**Boarding/dropping point selection.** Historically one of Redbus's worst screens. Multiple independent sources converge: boarding points were given as incomplete addresses with **no map**, forcing riders into a separate Google Maps tab to guess the real location, generating "a high number of negative reviews related to confusing boarding and dropping locations" **[confirmed, multiple sources]**. Redbus later added in-app map integration to pick the nearest boarding point visually with an ETA **[confirmed general]** — but **2026-dated complaints still report the in-app pin not matching where the bus actually stops** **[confirmed]**, meaning the map pin is only as trustworthy as the operator's actual stop data; adding a pin without fixing the underlying data just makes a wrong answer look more confident. A genuinely good, confirmed feature: dropping-point recommendation based on the destination address, with the bus's historical route shown **[general, Redbus's own blog]**. Also confirmed: multi-drop-point group booking — one payer books several seats on one bus where each passenger has a different drop point, entered per-passenger in a single transaction **[confirmed]**.

**Passenger details form.** The most granularly tested screen in the whole study:
- 4 of 5 test users didn't understand what tapping "Add Passenger" would do before trying it **[confirmed]**.
- No summary of prior choices (seats, boarding point) is shown on this screen — users had to rely on memory, and were specifically unsure about everything except which seats they'd picked **[confirmed]**.
- **Drip pricing**: 3 of 5 users believed GST was already included in the fare shown earlier in the funnel; the actual disclaimer only said "(excluding convenience fee)," never mentioning GST — the real cost only becomes visible this late **[confirmed]**.
- **Opt-out-by-default insurance**: one reviewer found "travel insurance option currently has Remove-Only option" — insurance is pre-added to the cart with no unchecked opt-in state, only a way to remove it **[confirmed]**. This sits inside a documented industry pattern: India's CCPA fined SpiceJet ₹1 lakh in 2026 specifically for booking-flow dark patterns, and a LocalCircles survey found 45% of users across platforms reported "basket sneaking" **[confirmed pattern industry-wide; Redbus instance confirmed by the reviewer, not by regulatory action]**.
- No source confirmed whether users understood what documentation the pre-added insurance would require to claim on — the same reviewer flagged this as unclear even to the tester **[confirmed]**.

**Payment screen.** Promo code entry is hard to discover **[confirmed]**; insurance again appears as remove-only at this stage **[confirmed]**. No confirmed detail on paid upsells for live tracking or food.

**Ticket/confirmation screen.** The weakest-documented screen in the study, despite being operationally the most important. Confirmed contents: PNR, boarding point, departure time, seat number(s), fare, operator/support contact, delivered via SMS/email/in-app **[general, multiple thin sources converge]**. Whether a QR code is standard on the bus e-ticket (as it reliably is on IRCTC train tickets) is **unconfirmed** — worth verifying directly rather than assuming parity with rail. Live GPS tracking is a real, confirmed feature: 30 minutes before departure, Redbus can text the bus number and a tracking link to the passenger and one nominated emergency contact **[confirmed, Redbus's own blog]** — but coverage depends on the operator opting in (skews toward premium AC/Volvo services), so it isn't a universal guarantee.

**Redbus — steal / reject.**
- Steal: pessimistic seat-lock that hides contention rather than displaying it; the shareable live-tracking link for a nominated contact; single-transaction multi-drop-point group booking; route-history-informed drop-point recommendation (once the underlying stop data is trustworthy).
- Reject: opt-out-by-default insurance with remove-only controls; a legend with fewer entries than actual seat states; hiding contextual info the instant a user acts, forcing reliance on memory; a headline price that excludes a real, unavoidable tax; "the warning appeared in a form field" as a defense when a boarding mistake was genuinely a UI failure.

### A.2 KSRTC (ksrtc.in / Awatar)

Confirmed problems, from a UX case study that set out to redesign the app plus scattered complaints:
- **Flow order is backwards**: boarding point, then drop point, then *finally* seat selection — locking in logistics before the rider even knows if a wanted seat is available **[confirmed]**. This inverts the Redbus-standard order (search → seats → boarding/drop → passenger details).
- Login/session state doesn't persist reliably, forcing repeated re-authentication **[confirmed]**.
- Booking management is described by a user, verbatim, as "a nightmare," and the app reportedly **crashes after tapping "check availability,"** which for some users blocks booking outright on a given day **[confirmed]**.
- No sharing/export path for a ticket — no WhatsApp share, no save-as-PDF, no working print preview **[confirmed]**.
- **Incomplete stop data causes wrong bookings**: a real stop (Rampura) was documented as simply missing from the app, forcing riders to book against the nearest listed stop and then struggle at actual boarding **[confirmed]** — a backend-data failure, not just a missing map pin, and the clearest real-world instance of "boarding point as a guess" in this whole study.
- No confirmed detail exists on KSRTC's seat map or payment screen specifically; treat that as unverified rather than assumed to mirror Redbus.

**KSRTC — steal / reject.** Nothing confirmed as a KSRTC-specific strength. Reject: boarding/drop-before-seat-selection ordering; non-persistent sessions; an availability check that can crash the app; treating a real physical stop as absent from the system rather than reconciling it.

### A.3 AbhiBus

- **"Pink Seat" feature**: a named safety feature where a female passenger picks a seat with adjacency protection against unrelated male bookings **[general/marketing-sourced]** — the feature's *existence* is confirmed, but whether it's server-enforced (blocks a male booking attempt) versus just visually discouraged was not independently verified.
- **Seat prices shown directly on the seat map**, no tap-through required, and seat/amenity info visible without scrolling **[confirmed via multiple independent comparison write-ups]** — a direct, confirmed fix for Redbus's documented "several taps to understand berth pricing" complaint.
- Consistently cited as India's highest-rated major bus app (4.2–4.3), strongest in South India, leaning more on cashback/coupon pricing than route breadth **[general]**.

**AbhiBus — steal / reject.** Steal: per-seat pricing directly on the seat grid, amenity info with no extra tap. Reject: nothing specific and confirmed surfaced as an AbhiBus-specific anti-pattern; "cluttered" critiques in comparison pieces read as taste judgments, not functional failures.

### A.4 Paytm bus booking

- Interactive seat map with window/aisle/upper/lower selection and a "Booking for Female" toggle that reprioritizes results **[general]** — conceptually parallel to Redbus's gender-safety toggle, which the Redbus usability study found users distrusted outright ("it will make no difference," one tester said). A toggle that doesn't visibly change the seat map it claims to affect is a confirmed failure mode on the Redbus side and likely generalizes.
- Positioned inside a unified Paytm Travel app; its practical edge over Redbus is bundled payment/UPI identity across travel modes, not a distinctively different bus flow **[general]**.

**Paytm — steal / reject.** Nothing bus-specific and confirmed stood out as superior. Reject: shipping a safety toggle without visibly demonstrating its effect on the seat map — that's a trust-destroying pattern already documented on a sibling product.

### A.5 MakeMyTrip bus booking — the most useful process source in this study

This is a design team's own published account of a measured seat-map redesign, not a third-party guess.

**Before**: a tab-view splitting upper/lower berths for sleeper coaches, measured as the *lowest-converting step* in the funnel — users lost track of seats picked in a tab they'd navigated away from **[confirmed]**.

**After**: a single side-by-side view of both decks (no tab switching), seat/berth iconography redrawn to look like actual bus furniture, a **bus-shaped outline with headlights and a steering wheel** superimposed on the grid so it immediately reads as "inside a bus" and orients front/back, a legend moved to on-demand (tap to reveal, rather than permanently consuming screen space), and a newly prominent price filter.

**Measured results, all confirmed with real numbers**: an initial A/B test showed +2% conversion; a longer window (Jan–Oct 2019) showed a **12% conversion improvement**; price-filter usage grew from 1.23% of visits to **13.65%** once made legible and prominent.

This directly resolves the tension in this study between "Redbus's 5-of-5 testers missed a tiny 'i' icon" and "MMT's legend works fine hidden on-demand": the lesson isn't never hide a legend, it's that the reveal affordance has to be dramatically more discoverable than a lowercase letter in a corner.

**MakeMyTrip — steal / reject.** Steal, close to verbatim: side-by-side dual-deck view instead of a tab toggle; a literal bus-shaped visual frame for orientation; visible per-seat pricing with zero extra taps; an on-demand legend *if and only if* its reveal control is obviously tappable. No confirmed anti-pattern surfaced specific to this feature.

### A.6 Cross-cutting: small-screen legibility for a 30–40 seat dual-deck sleeper

Two failure modes recur across all four apps studied:
1. **Tab-per-deck causes "out of sight, out of mind" seat loss** (MMT's own measured finding) — argues for a persistent side-by-side or stacked dual-deck view, not a toggle that fully replaces one deck with the other.
2. **Small color-only encoding fails exactly on the states that matter most for safety** (Redbus's pale-pink-border ladies' seat, visually indistinguishable from "available," compounded by a legend that undercounts real states). This argues for redundant coding on any safety-relevant state — never color alone; pair it with an icon and a short label on tap.

No source in this study documented a plain **list-view fallback** (e.g. "Seat 14, lower berth, ₹850, available" as a scannable row) as an alternative to the visual grid on any of these four apps. That looks like an underused, differentiable pattern for Tatak on very dense buses.

### A.7 Cross-cutting: "seats sell while you look"

Only Redbus's mechanism is well documented, and it's the right shape to copy: pessimistic lock on tap, immediate disappearance from every other session, a 5-minute TTL, silent release on timeout. No UI has to represent contention at all, because the collision is prevented before the client ever renders it — simpler and more robust than a live "X people viewing this seat" affordance.

### A.8 Cross-cutting: ticket/boarding-pass presentation (Section D, folded in here since it's the same apps)

The weakest-documented screen across the entire study. Confirmed present on a Redbus-class e-ticket: PNR, boarding-point text, departure time, seat number(s), fare, operator contact. Confirmed as a real (if operator-dependent) feature: live GPS tracking with a shareable link, sent ~30 minutes pre-departure to the rider and one emergency contact. **Unconfirmed**: whether a QR code is standard on a bus e-ticket the way it is on IRCTC rail tickets — don't assume parity, verify directly. Given that boarding-point accuracy problems persist into 2026 even after map integration shipped, treat "map pin at the boarding point" as necessary but not sufficient — the pin is only as good as the operator's stop data, and that data-quality problem is the one actually worth solving.

### A.9 Anti-patterns worth naming explicitly (Section E)

- **Opt-out-by-default insurance**, remove-only control (Redbus, confirmed).
- **Headline price excluding a real, unavoidable charge** (GST), disclosed only later in small text (Redbus, confirmed) — classic drip pricing.
- **A safety toggle that doesn't visibly change the seat map it claims to affect** — users correctly stop trusting it (Redbus, confirmed via direct quote: "it will make no difference"; Paytm's equivalent toggle is at risk of the same fate absent evidence otherwise).
- **A near-imperceptible color/border distinction for a safety-relevant seat state**, paired with a legend that undercounts actual states, and a support response that blames the user rather than the interface (Redbus, confirmed via consumer complaint).
- **Regulatory context**: India's CCPA is actively fining travel-adjacent platforms for these exact patterns (SpiceJet, ₹1 lakh, mid-2026); a LocalCircles survey found 70% of respondents across digital platforms reported "forced action" and 45% "basket sneaking" **[confirmed, not bus-specific]** — this risk is live, not theoretical.
- I found **no confirmed** literal countdown-timer-as-urgency ("Hurry, 2 seats left!") screenshot or quote for Redbus specifically in this pass — a commonly assumed pattern for this app category, but state plainly it's unconfirmed rather than asserted as fact.

---

## B. Multi-leg / mixed-mode journey planning

### B.1 Google Maps

Google shipped three India-specific features in June 2019, including in Bengaluru specifically **[confirmed, multiple press sources]**: real-time bus delay estimates (live traffic + published schedules, ten cities), live long-distance train running status (via the acquired "Where is my Train" tech), and **mixed-mode directions combining an auto-rickshaw leg with a public-transit leg** — piloted first in Delhi and Bengaluru, telling the rider which stop to rickshaw to/from and giving a total time.

The most transferable confirmed pattern: Google's transit departure boards use a **color/label convention that admits uncertainty explicitly** — green (on-schedule, live), orange (early, live), red (delayed, live), and **black for "not updating in real time"** (a static schedule entry with no live claim attached), plus a caution icon for disruptions **[confirmed, Google's own help docs]**. This is the clearest shipped example anywhere in this study of a product visually saying "this time is a schedule, not a live promise" — via a color code, not a paragraph of disclaimer.

For the reserved-coach layer, Google Maps has no confirmed retail/booking integration with KSRTC or private operators; the relationship runs the other way — booking apps like AbhiBus embed Google Maps for live GPS display, not the reverse. No direct teardown of a Bengaluru→Hampi query result was found; reasoned inference (not confirmed) is that Maps either shows driving directions only, a generic unbooked "bus" leg with an approximate duration, or nothing at all, because KSRTC/private sleeper coaches aren't published as the structured schedule-feed data Maps' transit directions run on.

**Steal**: the live/scheduled color-and-label convention; treating a walk-up connector leg (auto-rickshaw) as first-class with a suggested pickup/drop point, not a footnote.
**Reject**: nothing to reject here — Maps' honest gap (no answer for the reserved-days-ahead layer) is a scope limitation, not a design failure, but it also means Maps offers no template for *unifying* all three certainty tiers on one screen, which is exactly what Tatak needs to do.

### B.2 Rome2Rio

Now an Omio sibling (acquired 2019) — functions as the discovery/comparison layer, handing bookable legs off to Omio or another partner.

**Layout, confirmed**: a list of transport-mode options (fly/train/bus/drive/ferry), each expandable to a leg-by-leg breakdown with total duration and price estimate up front. The mechanism that distinguishes a bookable leg from a purely informational one is a **"via [Operator/OTA]" attribution label** shown at the point of selecting an option (e.g., "via Loco2"), paired with a **pink "Select" button** on options with live, bookable pricing; everything else is estimate-only. Where a partner integration exists, tapping through is a genuine deep link to a real booking flow, not a generic "search elsewhere" dead end.

**The failure mode, confirmed via real user complaints**: Rome2Rio explicitly labels its numbers "estimates," but real users report a 15-minute estimate that took 4 hours, taxi fares wildly off from actual conditions, fares that "appear during discovery then vanish at checkout," and independently arrived at the workaround of using Rome2Rio only to shortlist, then verifying on the operator's own site before paying. Regional data quality is confirmed uneven — explicitly poor for Latin America — which is the relevant analogy for Karnataka's private/mofussil coach market: Rome2Rio's *general approach* (aggregate wide, caveat everything as an estimate) depends entirely on data-source maturity, and a maturity gap in that data reads to users as "the numbers are just wrong," not as "appropriately uncertain."

**Steal**: the "via X" attribution as a minimal-chrome mechanism for bookable-vs-not, without a separate badge system.
**Reject**: the actual reliability of Rome2Rio's non-partner estimates — its "estimate" framing hasn't stopped users from treating a specific-looking number as a promise, and has instead trained them to distrust the product wholesale. Also reject: no evidence Rome2Rio does anything special for "walk-up bus with no real timetable" beyond folding it into the same generic duration-estimate bucket as everything else — it lacks Google Maps' live/static distinction entirely.

### B.3 Omio and Trainline — the closest existing bookable multi-operator examples

**Omio, confirmed via its own help center**: auto-surfaces multi-mode combinations (train+bus) for a single origin-destination search when available — but a detailed independent review states plainly that Omio "cannot suggest creative itineraries combining multiple transport modes" across cities; a London→Paris→Barcelona trip needs two separate searches, not one assembled itinerary. So Omio's multi-leg capability is bounded to single-route multi-modality, not general trip-chaining across independently reserved legs — narrower than what Tatak needs.

**The load-bearing distinction, confirmed in Omio's own policy language**: if a booking is a single ticket across connections on the same EU operator, that operator is contractually obligated to rebook/reimburse on a missed connection. If Omio itself combined two or more separate tickets "at its own initiative," each is its own contract, rerouting isn't guaranteed, and Omio states it will disclose — before and after booking — that the connection is **"not guaranteed."** That disclosure exists, but its exact visual form (badge vs. banner vs. buried policy text) wasn't independently verifiable.

**Real failure evidence, confirmed via user accounts**: a Greek-island ferry itinerary sold with an advertised ~3–4 hour connection ballooned to 16 hours when the operator silently changed schedules, with Omio and the operator each blaming the other and the traveler eating €150 in costs; a separate traveler reports Omio reassuring them platforms were "usually near each other," and the connection was missed anyway when the first train ran late. Read together: **a confident-looking, uniformly-styled multi-leg itinerary, once the underlying legs are separately contracted, produces exactly the false-confidence failure Tatak must avoid.**

**Trainline, confirmed via its own support content**: "If you miss your next train because a previous connecting train service was delayed, you will be able to travel on the next train... (if the entire journey is booked under one ticket)" — again, the guarantee is entirely a function of ticket structure. **SplitSave**, Trainline's own split-ticketing feature, already lives in production with exactly the UX problem Tatak will face — one journey, multiple discrete ticket/QR objects — and its answer is simply to hand the rider several QR codes rather than synthesizing a single fake-unified document. Delay Repay compensation is assessed per operator, per ticket, not per trip — reinforcing that a slick single-search UI doesn't erase the underlying fact of multiple, separately-adjudicated contracts.

**Steal**: the policy-tied model itself — whether a connection is "protected" should be a function of the real underlying contract (one PNR, one operator on the hook) rather than a cosmetic UI judgment; Trainline's multiple-QR-codes-in-one-wallet as an honest answer to "don't fake a single ticket out of separately contracted legs"; Omio's instinct to disclose non-guaranteed connections before and after booking.
**Reject**: Omio's demonstrated real-world failure — presenting a specific connection window with the same visual confidence regardless of whether it's actually protected. A Tatak itinerary that renders "Bus arrives 21:40 → Coach departs 22:00" in the same row style as a guaranteed through-ticket connection reproduces this exact trap — and Tatak's bus leg is categorically less certain than even Omio's worst documented case (a scheduled ferry that changed without notice), since the bus has no published timetable at all.

### B.4 Uber and Citymapper

**Uber's "Uber and Transit" feature, confirmed**: shows price/ETA for a transit route and an UberX side by side before commitment, then — once "Uber+Transit" is chosen — takes the car to the transit stop and switches the app into transit-navigation mode for the rest of the trip. Billing is split: only the UberX portion is paid in-app; the transit ticket is bought separately in the transit agency's own system. The important nuance: Uber's live countdown ("arriving in 4 min") only ever appears **after a car is actually requested** — never as a forward-looking estimate for a leg being planned days ahead. Uber has no scenario where an on-demand-style leg carries a "sometime around now" characterization inside a multi-day-ahead itinerary; it only goes live once summoned.

**Citymapper, confirmed**: its core product is live-first — live departures, live bus/train location on a map, "time to get off" alerts, line-disruption subscriptions. This is architecturally the same certainty tier as Tatak's metro leg (and loosely, a GPS-tracked city bus). No confirmed evidence Citymapper has a visual convention (comparable to Google Maps' color code) for a leg it has a *scheduled* time for but no *live* data on — the closest signal is a documented user complaint that stale schedule data, presented without a clear staleness warning, created real confusion about whether they'd arrive on time. Citymapper has no intercity coach or reserved-seat booking at all — like Google Maps, it never enters the domain where certainty tiers must coexist.

**Steal**: Uber's discipline of never fabricating a precise countdown for a leg not yet actually dispatched — the walk-up city-bus leg should get a qualitative window ("buses run roughly every 5–10 min around this time"), tightening to a real countdown only once the rider is near the stop with live data available; Citymapper's live-tracking-with-visible-approach grammar as the right treatment for the metro leg specifically (frequent + walk-up reads correctly as "live and trackable," not "guess").
**Reject**: neither product has any design language for placing a "this is a real, ticketed, non-negotiable 22:00 departure" leg next to a "this is a rough pattern, not a promise" leg in the same itinerary — both avoid the problem entirely by never mixing certainty tiers on one screen. That avoidance is the actual gap Tatak has to fill; no incumbent's product shape forced them to solve it.

### B.5 Synthesis — the central design problem

No product in this study explicitly and honestly renders all three certainty tiers (walk-up/unscheduled, walk-up/frequent, reserved/fixed) together on one screen. Each incumbent either avoids the problem by only ever containing one tier (Google Maps, Uber, Citymapper — none has a "reserved days-ahead" leg at all), or flattens the distinction and lets users over-trust it (Omio, confirmed via two independent user harm accounts; Rome2Rio, confirmed via aggregated complaints about specific-looking numbers that turned out wrong).

The two confirmed shipped mechanisms worth combining:
1. **Google Maps' color/label convention** (green/orange/red = live fact, black = static schedule, not verified live) — the right *mechanism class*: a persistent, low-friction, per-leg visual marker, not a disclaimer paragraph.
2. **Trainline/Omio's through-ticket-vs-split-ticket model** — the right *conceptual model*: certainty and guarantee should be a property of the actual contract underneath (is there one operator/PNR on the hook for this leg, or not), never a cosmetic styling choice layered on top.

---

## C. The buffer / connection-risk problem

### C.1 Airlines and airline-adjacent tools

**Google Flights, confirmed**: a filterable "Advisory" column flags "Short connection" (under 30 min domestic-to-domestic, under 60 min if international is involved) and "Self-transfer" (two separately-ticketed flights Google algorithmically combined). This is a **binary, rule-based flag computed once at search time off the scheduled times** — not a live, continuously updating risk score.

**Standard MCT (Minimum Connection Time), confirmed generally**: published per airport, sometimes per airline/terminal pair, accounting for walking distance and whether security/immigration/bag-recheck is needed. GDS booking engines use it as a hard filter for single-ticket itineraries — a connection below MCT typically won't even generate as bookable. The load-bearing fact: **MCT protection applies only to single-ticket itineraries.** The moment two legs are separately ticketed — which is structurally what a feeder-bus-to-reserved-coach journey is — no MCT enforcement exists at all. The system that "solves" tight connections does so by refusing to sell them, not by managing risk on the ones it does sell.

**Kiwi.com — virtual interlining plus a paid guarantee, confirmed via Kiwi's own guarantee terms**: Kiwi will stitch a self-transfer itinerary across two independently ticketed flights with no airline-level protection between them, then sells "Connection Protection" as a paid add-on. If the first flight causes a missed connection, Kiwi rebooks onto the next available flight or, failing that, covers a hotel and meal vouchers plus instant compensation (Kiwi Credit, cash refund on request, amount airline-dependent). Explicit exclusions: self-inflicted causes (oversleeping, slow security) are not covered, and self-remedying before contacting Kiwi can void the guarantee. This is a financial-insurance model, not a prediction model — it pays out after the fact rather than warning with any more nuance than "no airline protection exists here."

**Flat buffer norms, confirmed, generic**: TSA/airline guidance of 2 hours domestic / 3 hours international — a single fixed number applied identically regardless of individual airport, traffic, or day-of-week variance. The least sophisticated end of the spectrum.

**Flighty's Connection Assistant — the most sophisticated version found, confirmed via Flighty's own docs**: takes MCT as a floor, then personalizes using seat row (deplaning order), passport type and immigration requirements at that specific airport, checked-bag status, and live/historically-modeled gate data — decomposing the connection into named steps (deplane, immigration, bag claim, security, terminal transfer, gate walk) each with its own time estimate. Output is a four-tier label (relaxed / normal / tight / at risk) that **re-evaluates continuously** as the inbound flight's real conditions change, pushing a notification if a connection newly becomes at-risk. This is the one product in the study that treats connection risk as a live, decomposed, personalized estimate — but it's advisory-only: no guarantee, no rebooking leverage, just clear and early warning.

### C.2 Rail apps

Weakest-evidenced area — direct UI screenshots weren't retrievable, so conclusions lean on policy language more than confirmed screen content.

**Trainline**: Delay Repay is automated and proactive, including on split tickets — if either leg of a split ticket is delayed, both tickets can be claimed against. No confirmed evidence of any pre-booking visual risk signal (comparable to Google Flights' or Flighty's) for a short connection window on a split ticket — validation appears to happen silently (connection time checked, allowed or not) without surfacing a "how tight is this really" confidence signal to the rider.

**Omio, confirmed via its help center**: explicitly discloses, "before and after booking," when a combined-ticket connection is **"not guaranteed"** — a plain-language, binary disclosure (guaranteed / not guaranteed), functioning more as a legal liability shield than a graded risk indicator. Neither Trainline nor Omio showed evidence of a "usually fine" vs. "genuinely risky" gradient for rail interchanges the way Flighty does for airports.

### C.3 Products facing an unreliable feeder leg into a fixed departure

This is the section closest to Tatak's actual problem, and where the gaps are most visible.

**Ride-hailing ETA (Uber/Ola), confirmed generally**: both show a single **point estimate** ("arriving in 4 min") that updates continuously as position/route are recomputed — never a range, despite the underlying models (e.g. Uber's DeepETA) producing probabilistic outputs internally. ETA-drift complaints ("said 2 minutes, actually took 10") are well documented and are themselves a trust problem created by presenting a point estimate that visibly moves.

**Google Maps "leave by," confirmed feature, unconfirmed specialization**: users can set "arrive by [time]" and Maps computes a departure time from live + historical traffic (iOS has a "remind me to leave" notification). Gmail/Calendar auto-extraction of flight/hotel reservations exists, and Google's assistant reportedly factors an upcoming flight into "what time to leave" suggestions. **Not confirmed**: whether this pipeline adds an airport-specific buffer (security, check-in) on top of raw drive-time, or is just ordinary arrive-by routing pointed at an airport like any other destination. Maps' traffic model blends live data (high confidence, short trips) with historical percentile distributions (lower confidence, longer/rural trips) — but this confidence gradient is never surfaced to the user as a range; it collapses to one number, the same pattern as ride-hailing.

**MyTSA — the one confirmed range-based estimate in the whole study**: shows a range ("11–20 minutes") for airport security wait, built from historical screening data blended with crowd-sourced reports, explicitly framed as non-guaranteed ("your actual wait may be longer"). Narrow and single-purpose, but proof that range-based, explicitly-uncertain presentation is a shipped, accepted UI pattern elsewhere in travel — just never carried over to a moving-vehicle ETA.

**Transit app (transitapp.com), confirmed via its own blog**: despite a demonstrably probabilistic backend (historical stop-to-stop models blended with live "recency" weighting), the consumer-facing output is still a single point number, not a range. Its one confidence signal is a "crystal ball" icon shown only when Transit's own model measurably beats the transit agency's official prediction (>20% more accurate) — a meta-signal about *whose number to trust*, not about *how much uncertainty remains*. Even the app built specifically around live bus prediction chose point-estimate-plus-accuracy-badge over an explicit range, suggesting a possible product reason (users may distrust or dislike visible ranges) rather than a pure technical limitation.

**Airport shuttle "on-time guarantee" (Prime Time Shuttle, SuperShuttle) — the closest structural analog to Tatak's exact problem, confirmed via their own terms**: an unreliable, traffic-exposed shared van delivering a rider to a fixed, unforgiving flight departure. Their reservation system computes a recommended pickup time, and the guarantee is **conditional on the rider having accepted that system-recommended time** — choosing a later pickup time voids the guarantee entirely ("at your own risk"). Payout when at fault is a capped dollar figure (Prime Time: up to $250; SuperShuttle: up to $200 domestic / $300 international) plus overnight lodging if same-day travel isn't possible. This differs meaningfully from Kiwi's model: Kiwi guarantees an *outcome* (rebooks you, gets you there); the shuttle guarantees a *number* (their own recommendation was sound) and pays a capped penalty if it wasn't — it doesn't get the rider to the flight, it just caps the cost of the miss.

**Indian intercity operators (IntrCity SmartBus and the redBus/AbhiBus aggregator layer), confirmed via IntrCity's own policy**: protect themselves against the rider's own unreliable last mile, not the reverse — arrive late to boarding and you're a "No Show" with no refund; the bus doesn't wait, and no tool is offered to gauge whether the rider will make it in time. The only leniency runs the other direction: if the operator itself delays departure more than 2 hours, they'll reschedule the ticket — protection for a delayed fixed leg, not a tool for an unreliable feeder leg. No aggregator in this study (redBus, AbhiBus, ixigo, Wanderu) shows any before-or-during-travel signal about whether an incoming feeder leg is at risk of missing a fixed downstream departure.

**Note on ixigo's "Alternate Travel Plan"/"Travel Guarantee" branding**: this covers waitlisted-train non-confirmation, a completely different risk (ticket confirmation, not connection timing) — ruled out explicitly here because it's the most prominent "guarantee" branding among Indian OTAs and easy to mistake for something relevant.

### C.4 Assessment — has anyone actually solved this?

No. Nothing found combines all three things Tatak's problem needs: (1) an honest, continuously-updating, range-or-probability estimate of feeder-leg arrival built from real historical variance on that specific unreliable route, not a live-GPS point estimate; (2) a personalized, per-trip buffer computed backward from the fixed departure, the way Flighty decomposes an airport connection into named risk-bearing steps; and (3) either a guarantee/rebooking mechanism, or, short of that, unusually candid non-generic warning language when a plan is genuinely borderline.

Closest partial attempts, and exactly where each falls short for Tatak:
- **Flighty's Connection Assistant** solves decomposition-and-personalization, but only inside a domain where every input is structured and knowable (flight schedules, seat maps, immigration rules, gate data). A city bus with no published timetable has none of that structure — there's no "step" to model because the entire feeder leg is one unmodeled variable. Its four-tier language (relaxed/normal/tight/at risk) and continuous re-evaluation are worth borrowing conceptually even though the data model won't transfer.
- **Kiwi's Connection Protection** solves "what happens when it goes wrong," but presupposes substitutable downstream inventory (another flight later that day) that a once-a-day reserved intercity coach doesn't have — there's no "next available coach" to rebook onto, so the insurance model doesn't map onto a single unforgiving departure.
- **The airport shuttle guarantee** is the closest structural analog — an operator's own system computing a recommended departure time for a feeder vehicle into a fixed downstream departure, with a guarantee conditioned on trusting that computed time — but its guarantee is a liability cap, not a solved prediction problem, and it works only because a shuttle van's route is short, direct, and traffic-based (closer to ordinary drive-time uncertainty than to Bengaluru bus-arrival variance, which is dominated by unpublished schedules and bunching behavior, not just traffic).
- **MyTSA's range display** proves range-over-point is a viable, shipped UI pattern in travel, but only for a static queue length, never adapted to a moving-vehicle ETA.
- **Omio's "not guaranteed" disclosure** proves plain-language, non-euphemistic risk disclosure at booking time is an accepted pattern for a company that doesn't want to own the guarantee — closer in spirit to the honest sentence Tatak may need ("this leg has no published schedule; your reserved coach will not wait") than anything else surveyed.

The academic literature treats "risk of missing a transfer" as a research problem with proposed metrics, not something deployed in a consumer product — transfer failure isn't even tracked by most transit agencies' own performance systems, let alone surfaced to riders live. This is not a "copy what X does" problem for Tatak; it's closer to synthesizing Flighty's decomposed, continuously-updating personalization, Omio's plain-language non-guarantee disclosure, and MyTSA's range-based (not point) presentation — applied to a feeder mode that structurally has none of the schedule data those tools were built on.

---

## D. Ticket and boarding-pass presentation

Covered in depth for Indian bus operators in A.8 above. Summary of what's confirmed to be on screen at the moment of boarding: PNR, boarding-point text (increasingly with a map pin, though pin accuracy is inconsistent even as of 2026), departure time, seat number(s), fare, operator/support contact, and — where the operator opts in — a live GPS tracking link shareable with a nominated contact, typically triggered ~30 minutes before departure. QR-code presence on a standard bus ticket (vs. the well-documented QR on IRCTC rail tickets) is **unconfirmed** and should be verified directly rather than assumed.

The honest state of the art here is mediocre: the best-documented feature (live tracking link) is operator-dependent and skews toward premium services, and the worst-documented failure (boarding-point-pin doesn't match reality) persists years after the fix that was supposed to solve it. The lesson for Tatak: a map pin is a UI layer on top of operational data, and it's only as trustworthy as that data. Solve the data problem (accurate, current stop locations, ideally sourced from where the bus actually stops rather than where the operator says it stops) before or alongside the pin, not instead of it.

---

## E. Anti-patterns to avoid

Consolidated across the whole study:

1. **Opt-out-by-default add-ons** (Redbus's remove-only insurance) — never pre-add a paid item to checkout; the industry-wide version of this pattern is now drawing real regulatory fines in India (CCPA vs. SpiceJet, ₹1 lakh, 2026).
2. **Headline price that excludes a real, unavoidable charge** (GST left out of the fare shown early in the funnel, disclosed only later in small text) — classic drip pricing, confirmed to mislead 3 of 5 test users on Redbus.
3. **A safety toggle that doesn't visibly change the thing it claims to affect** — Redbus's gender-safety toggle was directly distrusted by testers ("it will make no difference"); Paytm's equivalent is architecturally at risk of the same failure.
4. **A near-imperceptible visual distinction for a safety-relevant state**, compounded by a legend that undercounts the actual number of states, compounded by a support response that blames the user rather than the interface (Redbus's pale-pink ladies'-seat border, confirmed via a real consumer complaint and Redbus's own support reply).
5. **Boarding points as bare street-name text with no map**, forcing riders to cross-reference a separate maps app — a long-documented, still-not-fully-fixed Redbus/KSRTC failure, and worse on KSRTC where an entire real stop was simply missing from the system.
6. **Fabricated precision for a leg that has no real schedule** — Rome2Rio's specific-looking duration estimates for legs it has no live data on, which real users report as simply wrong often enough that they've learned to distrust the product wholesale. The failure isn't "estimates exist," it's presenting an estimate with the same visual confidence as a real number.
7. **A multi-leg itinerary styled with uniform visual confidence regardless of the underlying contract** — Omio's documented real-world failures (a Greek ferry connection window that silently changed from ~3–4 hours to 16, a train-then-platform connection sold as "usually near each other" that was then missed) show that once legs are separately contracted, presenting them in the same visual register as a protected through-ticket connection actively misleads riders into false confidence.
8. **A tab-per-deck seat map for sleeper buses** — MakeMyTrip's own measured data shows this is the lowest-converting step in a booking funnel because users lose track of selections made in a tab they've navigated away from.
9. **Fake urgency messaging** ("Hurry, 2 seats left!," countdown banners) — commonly assumed to exist across this app category, but **explicitly not confirmed** with a direct source or screenshot for Redbus in this research pass; do not treat this as established fact, only as a pattern to watch for and avoid regardless.
10. **Buried cancellation terms** — not independently confirmed with screen-level detail for any specific app in this pass, but consistent with the drip-pricing and opt-out-insurance patterns that were confirmed; worth auditing directly against Tatak's own cancellation flow rather than assuming a specific incumbent's exact wording.

---

## Sources consulted

Bus-booking UX: Medium/UX Bootcamp usability case studies with real 5-user testing on live Redbus and KSRTC apps; the Go-MMT (MakeMyTrip) design team's own published account of their seat-map redesign with real conversion metrics; a first-person consumer complaint thread on a gender-seat mixup with Redbus's support reply; Redbus's own blog on dropping-point recommendations and bus tracking; 2026-dated aggregated app-store/complaint-board reviews; comparison write-ups of AbhiBus vs. Redbus; CCPA/SpiceJet dark-pattern coverage and LocalCircles survey data.

Multi-leg journey UX: Google's own India-feature launch coverage (TechCrunch, 9to5Google, GSMArena, YourStory, Medianama) and Google Maps help documentation; Rome2Rio's own help center plus Trustpilot and independent review sites; Omio's help center policy pages plus independent critical reviews (davidwilliamrosales.com, The Broke Backpacker, Happy to Wander) documenting real connection failures; Trainline's own support content on SplitSave, Delay Repay, and connection guarantees; Uber's official blog/help posts on "Uber and Transit"; Citymapper's App Store listing and a UX case study noting live-data staleness complaints.

Connection-risk UX: Google Flights advisory-column reporting; standard MCT/GDS industry background; Kiwi.com's own Connection Protection terms; Flighty's own Connection Assistant documentation; Omio and Trainline policy pages on guaranteed vs. non-guaranteed connections; Uber/Ola ETA-drift coverage (including a DNA India piece); Google Maps "leave by" and traffic-model documentation; MyTSA's own wait-time methodology; Transit app's own blog on its prediction model and "crystal ball" accuracy badge; Prime Time Shuttle and SuperShuttle's own on-time-guarantee terms; IntrCity SmartBus's own no-show/delay policy; ixigo's Alternate Travel Plan terms.
