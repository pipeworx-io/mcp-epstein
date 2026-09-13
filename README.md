# epstein

Full-text search over the documents the House Oversight Committee has published
for its Jeffrey Epstein investigation — transcribed interviews, subpoenas and
letters — plus (phase 2) a structured search over Epstein's own pilot flight
logbook. **Fleet #1480, phases 1-2.**

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1558+ live data sources.

## Tools

| Tool | Answers |
|---|---|
| `epstein_search_documents` | Where a phrase appears in the record, as a page-level citation |
| `epstein_list_documents` | What the corpus contains, and what is not searchable |
| `epstein_get_document` | The full text of one document, a page at a time |
| `epstein_flight_log_search` | Who is logged on a given tail number, route or date range, as the pilot wrote it |

Tools are prefixed because `search_documents` is already taken by
`federal-register` and `riksdagen-se`; a colliding tool ships unreachable while
the error advertises a namespaced name that does not resolve.

## Phase 2: the flight logbook

`epstein_flight_log_search` reads Government Exhibit 662-RR — Epstein's own
pilot flight logbook (1991-2005), admitted into evidence and unsealed in *USA
v. Ghislaine Maxwell*, 20-cr-330 (S.D.N.Y.), hosted keylessly at a stable
DocumentCloud asset URL. Phase 1's original release note said no flight logs
existed anywhere in the House Oversight corpus — true, but that was never the
only public source. This exhibit is a fixed, closed 118-page historical
document, not a live feed, so ingest is a one-time transcription rather than a
per-request proxy call.

**397 of an estimated 3,000+ logged legs are ingested — 23 of the 118 pages**
(fleet #1880 added pages 4-13 to the original 10-page seed, which was chosen to
span the full 1991-2005 range; fleet #1881 added pages 14-16). Machine OCR of
this handwritten logbook is unusable (the exhibit's own bundled OCR text layer
is illegible line noise, verified before building this); every ingested row is
a direct visual transcription of the page image. `epstein_flight_log_search`
with no filters returns the exact pages covered so an absence never reads as
"did not fly" — it may simply mean the page is not yet transcribed. Completing
the remaining 95 pages is follow-on work, not a blocker to shipping this
slice.

**Confidence convention on the transcription itself (fleet #1880):**
`passengers_raw` is verbatim per row — the same person's name is NOT
normalized to one spelling across rows even where it clearly varies
("Krestena" / "Kristena" / "Christina" all occur for what is plausibly one
person). A token read with real but not total confidence carries a trailing
`[?]` inside the word it qualifies (`"Arthur Hallering[?]"`); a token that
could not be read at all is `[illegible]`. Neither is a guess standing in for
a fact. A pilot's own struck-through self-correction is omitted rather than
marked `[redacted]` — that marker is reserved for a black-out on the original
exhibit page.

**Design decision C is held exactly: passenger entries are never resolved.**
"JE", "GM", "SK" and similar initials are stored and returned *exactly as the
pilot wrote them*, never expanded to a full identity — even where that
identity is publicly reported elsewhere. A black-out on the original page is
stored as the literal marker `[redacted]`; a word the transcriber could not
read with confidence is stored as `[illegible]`. Neither is a guess standing
in for a fact.

Every row carries its own provenance: exhibit title, the page number as
printed on the page itself, the DocumentCloud `source_url`, and the sha256 of
the source PDF, so a caller never has to trust that two rows came from the
same file.

## What this is, and what it is not

This is **one committee's published PDFs**. It is not "the Epstein files", and
every response says so rather than letting the name imply completeness.

- We already had the **committee layer**: `search_committee_documents` returns
  the releases, subpoena announcements and staff memoranda in which Oversight
  *talks about* this investigation. This pack holds what those releases link to.
- **Court filings and dockets are not here** — those are `court-listener`, and
  should be joined to rather than duplicated.
- **The estate tranche is absent.** The 2025-11-12 release *"Oversight Committee
  Releases Additional Epstein Estate Documents"* links a Google Drive folder that
  now returns 404. Those documents are not retrievable from this source. Do not
  add a Drive scraper to chase it; the folder is gone, not hidden.

Corpus as built: **31 documents, 505 pages, ~800,000 characters**, including the
Barr (129p), Tova Noel (135p) and Bondi (111p) transcribed interviews.

## Every result is a citation

A match returns the document title, the **page number** and the committee's own
URL, because the only useful form of this material is one a reader can check:

```
"2025.08.05 Subpoena Cover Letters, page 33 — https://oversight.house.gov/..."
```

Page-level storage is a requirement, not a convenience — later phases
(person profiles, connections) are built on this table, and design decision B on
the task says an edge must *be* its citation.

## What this phase deliberately does not do

No entity pages, no relationship scores, no "associate of", no inferred
connections. A name appearing in a document is a fact about the document;
anything beyond that is a claim, and for people never charged with anything a
loosely derived edge is defamation-shaped. Phases 3–5 (emails, person
profiles, connections) are a layer over phases 1-2 and carry their own
rules — in particular, people come from **unsealing orders**, never from name
extraction over the text, because an unsealed name and a redaction failure look
identical on the page. Phase 2's passenger entries are exempt from that rule by
design decision C: they are never resolved to an identity at all, so the
redaction-failure risk that motivates decision A does not apply the same way —
nothing is asserted as a person, an initial is returned as an initial.

## Four documents cannot be searched, and say so

4 of the 31 are scans with no text layer (two subpoena schedules, two letters).
They appear in `epstein_list_documents` with `searchable: false`, and
`epstein_get_document` refuses them by name with a link to the original. Storing
them as empty text would make a document that exists match nothing — which reads
as "not in the corpus" rather than "not machine-readable".

## Data sources

- House Committee on Oversight and Government Reform, release pages and the PDFs
  they link under `oversight.house.gov/wp-content/uploads/YYYY/MM/`. Free, no
  credential. There is no bulk endpoint: the release pages **are** the index, so
  the ingest walks the committee release pages themselves.
- `.github/workflows/epstein-refresh.yml` re-harvests weekly. The committee adds
  to this investigation on its own schedule — three transcribed interviews
  arrived in three separate releases.
- Government Exhibit 662-RR, `USA v. Ghislaine Maxwell`, 20-cr-330 (S.D.N.Y.) —
  a court trial exhibit, admitted into evidence and unsealed, hosted keylessly
  at a stable DocumentCloud asset URL. A fixed, closed historical document, not
  a live feed, ingested once as a one-time transcription (migration
  `186_epstein_flight_logs.sql`) rather than proxied per request.

**A truncated PDF downloads as a success.** Measured while building this: the
Bondi transcript came back 131,072 bytes against a declared 392,928, `curl`
exited 0, and `file(1)` still called it a valid PDF — it would have been indexed
as a third of a transcript with nothing reporting a problem. The ingest checks
Content-Length and the `%%EOF` trailer on every fetch, and retries.

## Fetching the exhibit: the User-Agent rule is backwards here

`s3.documentcloud.org` answers a **plain bot User-Agent with 200** and a **full
Chrome User-Agent with 403**. Measured three ways on the same URL in the same
minute: `pipeworx/1.0` → 200, a normal Chrome UA → 403, no UA at all → 200. The
`www.documentcloud.org` page and its API refuse the browser UA too.

This is the opposite of the usual rule — `war.gov`, `dol.gov` and `gao.gov` all
need full browser headers to answer at all. Presumably a browser UA arriving
from a datacenter IP with no browser fingerprint scores worse than an honest
crawler does.

It matters because the 403 is a **4.7 KB Cloudflare block page**, not a network
error: a fetch that does not check its result records a "downloaded" 4.7 KB PDF
and carries on. Send a plain honest User-Agent, and check `Content-Length` and
the `%%EOF` trailer regardless.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "epstein": {
      "url": "https://gateway.pipeworx.io/epstein/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/epstein/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1558+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "epstein": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-epstein"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-epstein
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Epstein data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
