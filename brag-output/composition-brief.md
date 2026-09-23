# Hyperframes Composition Brief: ReyDesk

## Objective
Create a short, polished product walkthrough for ReyDesk that helps a landing-page visitor understand the remote-support workflow before signing up.

## Output
- Composition directory: `brag-output/composition/`
- Rendered video: `brag-output/brag.mp4`
- Format: landscape — 1280x720
- Duration: 20 seconds

## Source Material
- Project root: `.`
- Primary files read: `apps/web/src/pages/LandingPage.tsx`, `apps/web/src/components/LandingLayout.tsx`, `apps/web/src/index.css`
- Product name: ReyDesk
- Tagline / strongest claim: “Resolve support work without the tool sprawl.”
- Key UI or visual moment to recreate: the dark technician console with tickets, device alerts, live sessions, SLA state, consent, and audit trail
- Copy that must appear verbatim:
  - From alert to resolved — without changing tools.
  - Remote support starts with consent.
  - Every action leaves a record.
  - Remote support · ITSM · endpoint health
  - Start your free workspace

## Creative Direction
- Tone preset: polished
- Creative direction: restrained product walkthrough for serious mid-market IT operations teams
- Interpretation: confident, legible, and tactile; show one workflow rather than a generic feature reel.
- Angle: One incident moves from endpoint signal to ticket to consented remote session to auditable resolution in one console.
- Hook: From alert to resolved — without changing tools.
- Outro / punchline: Remote support, ITSM, and endpoint health. One ReyDesk workspace.
- Avoid:
  - Generic SaaS language
  - Abstract filler visuals
  - Unsupported customer logos, metrics, or self-hosting claims
  - Unrelated visual redesign

## Visual Identity
- Background: #0e1114
- Text: #e6e9ec
- Accent: #e8a33d
- Display font: IBM Plex Sans, 600 weight
- Body font: IBM Plex Sans; use IBM Plex Mono for IDs and system labels
- Visual references from the project: landing console, amber status accent, ticket table, device and session labels, consent copy

## Storyboard
Use `brag-output/brag-plan.md` as the creative contract.

Scene summary:
1. The signal — 3s — alert and ticket arrive in the ReyDesk console
2. The context — 4s — ticket expands with device context and action rail
3. Consent first — 5s — remote-support code and permission approval
4. Leave the record — 4s — resolution and audit event return to the ticket
5. ReyDesk — 4s — wordmark, product line, and signup CTA

## Audio
- Audio role: sparse professional accents
- Audio arc: quiet technical pulse, small lift during consent approval, clean landing at the logo
- Music: choose a restrained local Hyperframes track
- Music treatment: low volume, fade in, duck slightly during key text, fade under final logo
- Music cue guidance: detect at composition time; use 1–3 strong cues for scene transitions and final lockup
- Audio-reactive treatment: subtle; let existing console accent and depth breathe gently, never use waveform or particles
- Audio-coupled moments:
  - alert, ticket, and device rows — sparse UI clicks
  - consent approval — restrained confirmation cue
  - final wordmark — soft landing accent
- SFX selection guidance: low-density clicks and one confirmation sound matched to actual motion
- Exact SFX choice: Hyperframes selects filenames, timestamps, and volume based on the implementation

## Hyperframes Instructions
Load `hyperframes-core`, `hyperframes-animation`, `hyperframes-creative`, `hyperframes-keyframes`, and `hyperframes-cli`. Create the composition in `brag-output/composition/`. Use local assets where possible, show actual ReyDesk copy and UI patterns, keep text readable, and run `npx hyperframes check` before render.
