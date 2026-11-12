# Redacta — build journal

Kept as I build. Short entries, dated, including the stuff that did not work.
This journal feeds the Devpost write-up, so I write decisions and reasons, not
marketing.

## 9 Nov 2026 — picking the concept

Looked at three directions for the Firebase hybrid-inference brief. The field
use-case (offline notes) died on one fact: on-device inference on the web is
desktop Chrome only, and field work is phones. A seller reply copilot was the
safe option but felt thin. Redacta won because it uses the one thing hybrid
inference can do that neither pure-cloud nor pure-local can: read the raw
document where it is not allowed to leave, and let the cloud think only about
what is safe to share.

The rule the whole product hangs on: the cloud model never receives raw text.
Not "we try not to send it" — the analysis function in the code accepts only
the redacted artefact, so there is no code path that carries the original.
If a judge reads one file, I want it to be that signature.

## 9 Nov 2026 — prototype, and being honest about simulation

The prototype runs the full five-step flow in simulation, labelled SIM
everywhere it matters. I cannot test Gemini Nano from a headless VM (no real
Chrome profile, no GPU), and faking a "live" demo would be worse than an
honest simulation. The Firebase AI Logic module is written against the real
SDK surface though: scan lane created with InferenceMode.ONLY_ON_DEVICE (it
throws rather than falling back to cloud — that refusal IS the privacy
guarantee), analysis lane PREFER_IN_CLOUD, and every response's
inferenceSource lands in the privacy ledger so a user can audit where each
step actually ran.

What I still owe real hardware time for: Nano extraction quality on messy
documents, the App Check debug flow, and the cloud-lane region check for
Indonesia. All three are in SPIKES.md.

## 9 Nov 2026 — typography (changed my mind mid-prototype)

First pass used Space Grotesk, the same display face as my last few projects.
It looked fine and completely anonymous — every AI-built landing page this
year looks like that. Switched Redacta to Sora for display and Inter for
body, self-hosted. Sora's rounder geometry fits a consumer privacy tool
better: serious about documents, not pretending to be a trading terminal.

## 9 Nov 2026 — motion pass

Added motion after the static prototype worked, not before: a scan sweep over
the document while the on-device scan runs, sensitive spans lighting up one
by one, the payload card lifting with a blue glow at the exact moment the
redacted text (and only the redacted text) leaves for the cloud, ledger
entries sliding in newest-first with the lane colour on the edge. Motion is
there to make the privacy boundary visible, not to decorate. Everything
decorative switches off under prefers-reduced-motion.

## Open questions I have not answered yet

- How good is Nano, really, at NIK/NPWP-shaped strings mixed into Indonesian
  prose? The sample docs are Indonesian on purpose; the fallback plan if
  extraction is weak is narrower, pattern-assisted recall, and I will say so
  in the submission if that is where I land.
- Does the hackathon's final rules text allow Indonesia-based builders?
  Rules publish tonight; building pauses if the answer is no.

## 12 Nov 2026 — rules published, gate cleared

The official rules went up on the morning of the 12th. Indonesia is not on
the exclusion list, solo entry is allowed, Grand Prize is $10,000 of a
$30,000 pool, deadline 30 Nov 14:00 PT. The earlier confusion (one page
said $30,000 grand prize, another $10,000) resolved in the rules text
itself: $10,000 grand, $7,000 and $4,000 runners-up, $3,000 per platform.
Building resumed the same day.

## 12 Nov 2026 — the competitor scan that found nobody

The Devpost project gallery is still unpublished and no entrant project is
visible anywhere public, so the scan (kept at ../competitor-scan.md) is
mostly a record of absence plus the predictable field: study companions,
support reply studios, field notes, and clones of Firebase's own Friendly
Meals example. The useful conclusion stands: most of the field will ship
PREFER_ON_DEVICE fallback demos with a badge instead of evidence. Redacta's
edge has to be the refusal guarantee, the code-level boundary and the
ledger — the scan is written as a checklist against exactly that, and it
must be re-run once the gallery publishes.

## 12 Nov 2026 — checking the SDK surface properly, and finding real bugs

I had written `js/hybrid.js` from the docs on the 9th and believed it. On
the 12th I checked it against the published SDK bundle itself, and it was
wrong in five places:

1. The backend class is `GoogleAIBackend`. I had written
   `GeminiDevBackend`, which does not exist as an export — the live path
   would have thrown on the first call.
2. `model.initializeDeviceModel()` does not exist in SDK 12.5.0 at all. It
   appears in 13.0.0. The pinned version is now 13.0.0, with the reason in
   a comment, because pinning 12.5.0 would have made the Prepare button
   dead in live mode.
3. The bundle's `inferenceSource` values are lowercase (`on_device`,
   `in_cloud`) while the docs prose writes them uppercase. The module now
   normalises both spellings instead of trusting either.
4. I had wrapped the schema in `Schema.object()`, which expects
   Schema-helper instances. The docs accept a plain JSON schema as the
   response constraint, so the schema is now passed as-is.
5. The scan lane carried `inCloudParams` "for completeness". That was the
   wrong instinct: a privacy lane should not even configure a cloud model.
   The scan model now has on-device params only.

The same verification pass caught two bugs in the prototype itself: the
medical sample file was named `medical-letter.txt` while the loader
fetched `medical.txt`, so that sample button loaded a 404 page; and five
of the seven font files were byte-identical duplicates. Both fixed, and a
dependency-free test suite (`node test/verify.mjs`, 436 checks) now guards
the span data, the redaction guarantee and the schema parity so these
kinds of drift get caught by a command instead of by luck.

## 12 Nov 2026 — App Check, added as a guarded placeholder

The guided Firebase setup auto-enforces App Check, and my module did not
mention it beyond a comment. `js/hybrid.js` now has an `APP_CHECK_CONFIG`
placeholder that initialises App Check with the reCAPTCHA Enterprise
provider and supports the localhost debug-token flow, per the get-started
guide's Step 4. It is inert until configured, and a failed initialisation
surfaces as a warning in the UI instead of failing silently. The end-to-end
flow is still Spike 2: unproven until real hardware runs it.

## 12 Nov 2026 — audit pass: the payload check was lying, and other fixes

A full audit of the prototype, done before any live run, found real bugs
rather than style nits. The worst was mine: the "Contains raw personal
data" check only looked at redacted spans, so pressing Keep all and then
analysing produced a clean "No" for a payload identical to the raw
document — and three places in the UI hardcoded "0 raw bytes sent". The
check now reports kept spans as kept (your choice, but verbatim raw text
in the payload), and the counters are computed from what the live lane
actually receives. Simulation still counts zero, because simulation sends
nothing.

The live scan path had never run, and it showed. An empty entity value
from the model would have hung the span locator forever
(`indexOf("", n)` never advances). Duplicated model rows doubled the
spans; a span plus its own sub-span ate surrounding text during
redaction. All three are fixed in a shared normaliser with safe defaults
for missing fields, and malformed model JSON is now a distinct failure
instead of being misreported as an on-device refusal. The redaction
builder moved into `js/redact.js` so the tests exercise the real code,
and the scan ledger now records the SDK-reported `inferenceSource`
instead of a hardcoded value.

Smaller things, same pass: editing the document after a scan no longer
leaves stale offsets pointing at new text (the scan is invalidated and
must be re-run); a failed model prepare no longer logs a success row or
labels the button ready; a failed analysis no longer strands the button
disabled with no error; a missing sample file no longer pours a 404 page
into the editor; the simulation's document type for the medical sample
is now the schema-valid `medical_letter`; and the deploy-time config
file is picked up automatically, so going live no longer needs a manual
edit of the deployed HTML. The App Check site key travels in the same
gitignored file, never in committed code. The suite grew from 436 to 568
checks, and a throwaway DOM harness exercised the simulation flow end to
end. None of this verifies anything on real Chrome hardware — the spikes
in SPIKES.md are still open, and Spike 2's old instruction to paste the
config into `js/hybrid.js` has been corrected before anyone followed it.

## 9 Nov 2026 — background: not black

Same anonymity problem as the typeface: every project I ship sits on near-
black, so they blur together. Redacta now sits on deep green (#06231A page,
#0A2E21 cards) — close enough to the privacy/forest palette to feel calm and
serious, far enough from the standard AI-purple-on-black to have its own
face. The vivid green is still reserved for the on-device lane and sky blue
for the cloud lane; the background change does not touch the semantics.
