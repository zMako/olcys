# OŁCyŚ — concept

HackNation 2026, Ministry of Finance challenge. Submission due 22 Nov 2026, 11:00.

## One-line pitch

A self-building case file: the analyst types one identifier and the tool runs the investigation itself, ending in an estimated undeclared amount in PLN per tax year and the name of the exchange that holds the person's identity records.

## Design rule

One screen, one story. Any system can exist underneath as long as it changes something visible on that screen. The whole product must be demoable in 5 minutes and watchable in a 3-minute video.

## The screen

An evidence graph that grows live: identifier → profiles → addresses → on-chain flows → off-ramp. Beside it sit the score receipt, the "why this may be wrong" panel, and a timeline slider. The interface is in Polish.

## Engines

| Engine | What it does | What the viewer sees |
|---|---|---|
| Identity resolution | Links accounts across sites by handle variants, avatar similarity, bio text, e-mail hashes, name-service records | Profiles snapping together, each link with its reason |
| Extraction | Finds addresses in plain and obfuscated text, screenshots, and QR codes in ad photos; validates checksums | An address lifted out of a photo |
| Cryptographic proof | Verifies signed messages posted to prove address ownership | A "mathematically proven" tier above the KAS bands |
| Confidence Score | Rule-based, versioned rules; KAS bands as the base, +15 for independent sources, identity confidence as a cap | A receipt tracing every point to a rule and a source |
| False-positive filter | Label lists, contract check (aware of delegated accounts and smart wallets), giveaway and charity detection | Addresses rejected with stated reasons; exchange interaction still recorded |
| Wallet expansion | Clusters related addresses from on-chain spending patterns | "Found 1 address; the wallet has 14" |
| Off-ramp detection | Finds the exchange deposit address and names the exchange | Money flowing to a named exchange, plus a drafted information request |
| Tax estimate | Values each cash-out in PLN at official NBP rates | Estimated proceeds per tax year, labelled as a hypothesis |
| Self-challenge | Produces the strongest counter-argument for each link | A "why this may be wrong" panel |
| Evidence vault | Hash-chained snapshots with URL, timestamp and metadata; runs can be replayed | A verify button; a tampered record turns red |
| Time machine | Compares archived profile versions; scheduled reruns with diffs | A slider where a wallet address gets swapped |
| Calibration | Generates synthetic personas with known truth and measures the score against them | A chart of score versus actual correctness |

## Data

- **Synthetic world:** a generated set of personas and a small self-hosted "internet" (forum, code-hosting profile, P2P ad board) with recorded chain data. It runs offline and doubles as the required test scenarios.
- **Real connectors:** GitHub, web archive, public explorers, and a search API whose terms allow it, behind the same connector interface.
- **Rejection cases:** real public exchange and DEX addresses, checked live.

## Output

A Polish PDF report for non-technical readers: sources, scores, chronological fund flow, and facts, calculations and hypotheses kept visibly separate.

## Stack

Node.js with TypeScript, React, PostgreSQL, one Docker Compose command, monorepo. An optional local model sits behind an OpenAI-compatible endpoint and is used for extraction help only, never for the score. No data leaves the machine except to an allowlist of sources.

## Phases

| Phase | Goal | Contents |
|---|---|---|
| 1. Foundation | Something runs end to end on fake data | Monorepo, schema, connector interface, synthetic world generator, text extraction with checksum validation |
| 2. Mandatory scenario | All seven judged stages work | Source search, Confidence Score with receipt, false-positive filter, basic chain indicators, evidence vault, plain results view |
| 3. The screen | It looks like the product | Live evidence graph, score receipt panel, rejection display, Polish interface |
| 4. The ending | The tax-tool differentiator | Wallet expansion, off-ramp detection, PLN estimate at NBP rates, fund-flow timeline, PDF report |
| 5. Wow layer | The moments the jury remembers | QR and image extraction, signed-message proof, identity resolution signals, self-challenge panel, time machine and address swap |
| 6. Proof and realism | It survives scrutiny | Real connectors, live rejection checks, scheduled reruns with diffs, calibration chart, audit log, juror-post monitor |
| 7. Deliverables | Submission and final | README with licences and screenshots, 10-slide PDF, 3-minute video, 5-minute demo rehearsal with fallbacks |

Phases 1 and 2 are sequential. After that, 3, 4, 5 and 6 can run in parallel. Phase 7 needs a feature freeze before it starts.

## Cut order if time runs short

Calibration chart, identity resolution beyond handle and e-mail, wallet expansion, juror-post monitor. Phases 1 to 4 and the report are never cut.
