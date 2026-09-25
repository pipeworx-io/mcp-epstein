interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * The Epstein investigation document corpus — the documents themselves, plus
 * (phase 2) Epstein's own flight logs as a structured table.
 *
 * PHASE 1 (fleet #1480): ingest plus full-text search over the House
 * Oversight Committee's published PDFs. `search_committee_documents` already
 * covers the committee layer — the releases, subpoena announcements and
 * staff memoranda in which House Oversight TALKS ABOUT this investigation.
 * This pack holds what those releases link to: the transcribed interviews,
 * subpoenas and letters.
 *
 * PHASE 2 (fleet #1480): epstein_flight_log_search, over Government Exhibit
 * 662-RR — Epstein's pilot logbook (1991-2005), admitted into evidence and
 * unsealed in USA v. Ghislaine Maxwell, 20-cr-330 (S.D.N.Y.), hosted keylessly
 * at a stable DocumentCloud asset URL. This is a MIRROR under the
 * proxy/mirror rule: the exhibit is a fixed, closed historical document, not
 * a live feed. 397 rows (23 of 118 pages) are ingested as of fleet #1881 —
 * machine OCR of this handwritten logbook is unusable, so every row is a
 * direct visual transcription; see the tool's `coverage` field on every
 * response and migrations 186, 188 and 189 for the full account. DESIGN
 * DECISION C IS HELD EXACTLY: passenger initials are stored verbatim as
 * printed — "JE, GM, SK" is never expanded to a name, however well known the
 * identity is elsewhere. A token the transcriber could read but not confirm
 * carries a trailing "[?]" on the doubtful word; a token that could not be
 * read at all is "[illegible]" — neither is a guess standing in for a fact
 * (migration 188).
 *
 * Person profiles and connections (phases 4-5) are NOT built: design
 * decisions A (people come from unsealing orders, not name extraction) and B
 * (an edge must be its own citation) are unresolved without Bruce, and both
 * later phases are layers over phases 1-2 that must not ship first.
 *
 * EVERY ANSWER IS A CITATION. Phase 1 results are page-level and carry the
 * document title, page number and the committee's own URL. Phase 2 results
 * carry the exhibit title, page number, the DocumentCloud source_url and the
 * PDF's sha256, because the only useful form of this data is one a reader can
 * check. There are no relationship scores, no inferred associations and no
 * entity pages: a name appearing in a document is a fact about the document,
 * and anything more is a claim this pack does not make.
 */

const UA = 'pipeworx/1.0 (+https://pipeworx.io)';

const DOC_TYPES = ['transcript', 'subpoena', 'schedule', 'letter', 'memorandum', 'other'] as const;

const tools: McpToolExport['tools'] = [
  {
    name: 'epstein_search_documents',
    description:
      'Full-text search across the House Oversight Committee documents from the Jeffrey Epstein investigation — transcribed interviews, subpoenas and letters the committee published as PDFs. Returns the matching page with a snippet, the document title and the committee URL, so every result can be checked at source. Use it to find what a named witness said under questioning, which institutions were subpoenaed, or where a topic appears in the record.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to find in the document text, e.g. "Metropolitan Correctional Center" or "non-prosecution agreement".' },
        doc_type: { type: 'string', enum: [...DOC_TYPES], description: 'Restrict to one kind of document.' },
        limit: { type: 'number', description: 'Max matching pages, default 10, max 50.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'epstein_list_documents',
    description:
      'Inventory of every document held from the House Oversight Epstein investigation: title, kind, page count, publication date and the committee URL. Says which documents are scans with no searchable text. Use it to see what the corpus contains before searching it, or to get a document id for epstein_get_document.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_type: { type: 'string', enum: [...DOC_TYPES], description: 'Restrict to one kind of document.' },
        limit: { type: 'number', description: 'Max documents, default 50, max 200.' },
      },
    },
  },
  {
    name: 'epstein_get_document',
    description:
      'Read the full text of one document from the House Oversight Epstein investigation, a page at a time, given the document id from epstein_list_documents or a search result. Returns page text with the page numbers needed to cite it.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', description: 'Document id from epstein_list_documents or a search result.' },
        page: { type: 'number', description: 'First page to return, default 1.' },
        pages: { type: 'number', description: 'How many pages, default 5, max 25.' },
      },
      required: ['doc_id'],
    },
  },
  {
    name: 'epstein_flight_log_search',
    description:
      "Structured search over Epstein's pilot flight logbook (Government Exhibit 662-RR, USA v. Ghislaine Maxwell, 20-cr-330, S.D.N.Y.) — date, aircraft, tail number, route and the pilot's own passenger/remarks entry for each leg. Passenger initials and names are returned EXACTLY as the pilot wrote them ('JE, GM, SK') — never resolved to a full identity, per design decision C on this build. A token the transcriber could read but not confirm carries a trailing '[?]'; a wholly unreadable token is '[illegible]' — neither stands in for a guessed identity. Only 397 of an estimated 3,000+ logged legs are ingested (23 of 118 exhibit pages, spanning 1991-2005) because the rest requires further page-by-page visual transcription — call epstein_flight_log_search with no filters to see exactly which pages are covered before concluding an absence. Use it to find who is logged on a given tail number, route or date range, or to search the remarks text for a name or initials.",
    inputSchema: {
      type: 'object',
      properties: {
        passenger: { type: 'string', description: 'Substring to find in the remarks/passenger entry, e.g. "GM" or "Clinton". Case-insensitive.' },
        tail_number: { type: 'string', description: 'Aircraft registration as printed, e.g. "N908JE".' },
        from: { type: 'string', description: 'Departure identifier as printed, e.g. "TEB".' },
        to: { type: 'string', description: 'Arrival identifier as printed, e.g. "PBI".' },
        date_from: { type: 'string', description: 'Earliest flight date, YYYY-MM-DD.' },
        date_to: { type: 'string', description: 'Latest flight date, YYYY-MM-DD.' },
        limit: { type: 'number', description: 'Max rows, default 20, max 100.' },
      },
    },
  },
];

const clamp = (v: unknown, def: number, max: number) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(1, Math.floor(n))) : def;
};

/** Gateway injects Supabase credentials into `args` (injectSupabase). */
async function pg(args: Record<string, unknown>, path: string): Promise<any[]> {
  const url = (args._supabaseUrl as string | undefined)?.trim();
  const key = (args._supabaseKey as string | undefined)?.trim();
  if (!url || !key) throw new Error('backing-store credentials not injected');
  const res = await fetchWithTimeout(
    `${url}/rest/v1/${path}`,
    { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json', 'User-Agent': UA } },
    'Epstein corpus store',
  );
  if (!res.ok) throw await httpError(res, 'Epstein corpus store');
  return res.json();
}

/** Stated on every response. The corpus is one committee's published PDFs, not
 *  "the Epstein files" — implying completeness would be the real error here. */
async function provenance(args: Record<string, unknown>) {
  const runs = await pg(
    args,
    'epstein_ingest_runs?status=eq.ok&select=documents,pages,no_text_layer,finished_at&order=finished_at.desc&limit=1',
  ).catch(() => []);
  const r = runs[0];
  return {
    source: 'US House Committee on Oversight and Government Reform, documents published at oversight.house.gov',
    scope:
      'Documents the committee has published as PDFs for its Epstein investigation: transcribed interviews, subpoenas and letters. This is NOT the complete universe of Epstein-related records — court filings live in court-listener, and the committee\'s 2025-11-12 estate-document release links a Google Drive folder that no longer resolves, so that tranche is absent.',
    ...(r
      ? {
          corpus: `${r.documents} documents, ${r.pages} searchable pages, last harvested ${String(r.finished_at).slice(0, 10)}`,
          not_searchable: r.no_text_layer
            ? `${r.no_text_layer} document(s) are scans with no text layer — they appear in epstein_list_documents but cannot match a text search.`
            : undefined,
        }
      : {}),
  };
}

const snippet = (text: string, query: string) => {
  const words = query.split(/\s+/).filter((w) => w.length > 2).map((w) => w.toLowerCase());
  const lower = text.toLowerCase();
  let at = -1;
  for (const w of words) {
    const i = lower.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = at < 0 ? 0 : Math.max(0, at - 180);
  const out = text.slice(start, start + 420).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + out + (start + 420 < text.length ? '…' : '');
};

async function searchDocuments(args: Record<string, unknown>) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return { found: false, reason: 'no_query', hint: 'Give words to search for, e.g. "non-prosecution agreement".' };

  const limit = clamp(args.limit, 10, 50);
  const docType = typeof args.doc_type === 'string' ? args.doc_type.trim().toLowerCase() : '';
  if (docType && !DOC_TYPES.includes(docType as any)) {
    return { found: false, reason: 'unknown_doc_type', hint: `doc_type must be one of: ${DOC_TYPES.join(', ')}.` };
  }

  // websearch_to_tsquery takes what a person would type; plainto_ would drop
  // quoted phrases, and a raw tsquery would reject an apostrophe.
  const q = encodeURIComponent(query);
  const rows = await pg(
    args,
    `epstein_document_page?tsv=wfts.${q}&select=doc_id,page_no,text,epstein_document!inner(title,doc_type,source_url,release_date,filename)` +
      (docType ? `&epstein_document.doc_type=eq.${docType}` : '') +
      `&limit=${limit}`,
  );

  const basis = await provenance(args);
  if (!rows.length) {
    return {
      found: false,
      reason: 'no_match',
      hint: `Nothing in the corpus text matches "${query}". Try fewer or more common words, or epstein_list_documents to see what is held.`,
      ...basis,
    };
  }

  return {
    found: true,
    count: rows.length,
    matches: rows.map((r: any) => ({
      // The citation IS the result: document, page, and the committee's own URL.
      document: r.epstein_document?.title ?? r.epstein_document?.filename,
      doc_id: r.doc_id,
      page: r.page_no,
      doc_type: r.epstein_document?.doc_type,
      published: r.epstein_document?.release_date ?? undefined,
      snippet: snippet(String(r.text ?? ''), query),
      source_url: r.epstein_document?.source_url,
      cite: `${r.epstein_document?.title ?? r.doc_id}, page ${r.page_no} — ${r.epstein_document?.source_url}`,
    })),
    ...basis,
  };
}

async function listDocuments(args: Record<string, unknown>) {
  const limit = clamp(args.limit, 50, 200);
  const docType = typeof args.doc_type === 'string' ? args.doc_type.trim().toLowerCase() : '';
  if (docType && !DOC_TYPES.includes(docType as any)) {
    return { found: false, reason: 'unknown_doc_type', hint: `doc_type must be one of: ${DOC_TYPES.join(', ')}.` };
  }
  const rows = await pg(
    args,
    `epstein_document?select=doc_id,title,filename,doc_type,page_count,char_count,has_text_layer,release_date,source_url` +
      (docType ? `&doc_type=eq.${docType}` : '') +
      `&order=release_date.desc.nullslast&limit=${limit}`,
  );
  const basis = await provenance(args);
  if (!rows.length) return { found: false, reason: 'no_match', hint: 'No documents match.', ...basis };

  return {
    found: true,
    count: rows.length,
    documents: rows.map((r: any) => ({
      doc_id: r.doc_id,
      title: r.title ?? r.filename,
      doc_type: r.doc_type,
      pages: r.page_count,
      published: r.release_date ?? undefined,
      searchable: r.has_text_layer,
      ...(r.has_text_layer
        ? {}
        : { not_searchable_because: 'scanned image with no text layer — listed here, but no text search can match it' }),
      source_url: r.source_url,
    })),
    ...basis,
  };
}

async function getDocument(args: Record<string, unknown>) {
  const docId = typeof args.doc_id === 'string' ? args.doc_id.trim() : '';
  if (!docId) return { found: false, reason: 'no_doc_id', hint: 'Give a doc_id from epstein_list_documents or a search result.' };

  const from = clamp(args.page, 1, 100000);
  const count = clamp(args.pages, 5, 25);
  const [docs, pages] = await Promise.all([
    pg(args, `epstein_document?doc_id=eq.${encodeURIComponent(docId)}&select=*`),
    pg(args, `epstein_document_page?doc_id=eq.${encodeURIComponent(docId)}&page_no=gte.${from}&page_no=lt.${from + count}&select=page_no,text&order=page_no.asc`),
  ]);

  const basis = await provenance(args);
  if (!docs.length) {
    return { found: false, reason: 'unknown_doc_id', hint: `No document ${docId}. Use epstein_list_documents for valid ids.`, ...basis };
  }
  const d = docs[0];
  if (!pages.length) {
    return {
      found: false,
      reason: d.has_text_layer ? 'no_such_page' : 'no_text_layer',
      hint: d.has_text_layer
        ? `Document ${docId} has ${d.page_count} pages; page ${from} is past the end.`
        : `"${d.title ?? d.filename}" is a scanned image with no text layer, so it has no readable pages here. The original is at ${d.source_url}.`,
      ...basis,
    };
  }

  return {
    found: true,
    doc_id: d.doc_id,
    title: d.title ?? d.filename,
    doc_type: d.doc_type,
    total_pages: d.page_count,
    published: d.release_date ?? undefined,
    source_url: d.source_url,
    returned_pages: pages.map((p: any) => ({ page: p.page_no, text: p.text })),
    ...(from + count <= d.page_count ? { next_page: from + count } : {}),
    ...basis,
  };
}

/** Stated on every flight-log response: this is a small, honestly-partial
 *  slice of a 118-page exhibit, not the complete logbook. */
async function flightLogCoverage(args: Record<string, unknown>) {
  const rows = await pg(
    args,
    'epstein_flight_log?select=page_no,flight_date&order=page_no.asc',
  ).catch(() => []);
  const pages = Array.from(new Set(rows.map((r: any) => r.page_no))).sort((a, b) => a - b);
  const dates = rows.map((r: any) => r.flight_date).filter(Boolean).sort();
  return {
    source:
      'Government Exhibit 662-RR — United States v. Ghislaine Maxwell, 20-cr-330 (S.D.N.Y.): Jeffrey Epstein\'s pilot flight logbook, admitted into evidence and publicly unsealed by the court.',
    coverage: `${rows.length} logged legs transcribed from ${pages.length} of the exhibit's 118 pages (pages ${pages.join(', ')}), spanning ${dates[0] ?? '?'} to ${dates[dates.length - 1] ?? '?'}.`,
    why_partial:
      'Machine OCR of this handwritten logbook is unusable (verified: the exhibit\'s own OCR text layer is illegible noise). Each ingested row is a direct visual transcription of the page image, not automated extraction, so coverage is intentionally small and will grow as more pages are transcribed. A page not listed above is simply not yet ingested — it is not evidence the pilot logged no flights that week.',
    initials_not_resolved:
      'Passenger entries are stored exactly as the pilot wrote them (design decision C). "JE", "GM", "SK" etc. are never expanded to a full name by this tool, even where the identity is publicly reported elsewhere.',
  };
}

async function flightLogSearch(args: Record<string, unknown>) {
  const limit = clamp(args.limit, 20, 100);
  const filters: string[] = [];
  const passenger = typeof args.passenger === 'string' ? args.passenger.trim() : '';
  const tail = typeof args.tail_number === 'string' ? args.tail_number.trim() : '';
  const from = typeof args.from === 'string' ? args.from.trim() : '';
  const to = typeof args.to === 'string' ? args.to.trim() : '';
  const dateFrom = typeof args.date_from === 'string' ? args.date_from.trim() : '';
  const dateTo = typeof args.date_to === 'string' ? args.date_to.trim() : '';

  if (passenger) filters.push(`passengers_raw=ilike.*${encodeURIComponent(passenger)}*`);
  if (tail) filters.push(`tail_number=ilike.*${encodeURIComponent(tail)}*`);
  if (from) filters.push(`route_from=ilike.*${encodeURIComponent(from)}*`);
  if (to) filters.push(`route_to=ilike.*${encodeURIComponent(to)}*`);
  if (dateFrom) filters.push(`flight_date=gte.${encodeURIComponent(dateFrom)}`);
  if (dateTo) filters.push(`flight_date=lte.${encodeURIComponent(dateTo)}`);

  const basis = await flightLogCoverage(args);

  const rows = await pg(
    args,
    `epstein_flight_log?select=document_title,page_no,flight_date,aircraft,tail_number,route_from,route_to,flight_no,passengers_raw,source_url,sha256` +
      (filters.length ? `&${filters.join('&')}` : '') +
      `&order=flight_date.asc.nullslast&limit=${limit}`,
  );

  if (!rows.length) {
    return {
      found: false,
      reason: 'no_match',
      hint: 'No ingested leg matches those filters. This is a 343-row partial transcription (see coverage) — absence here is often "not yet transcribed", not "did not fly".',
      ...basis,
    };
  }

  return {
    found: true,
    count: rows.length,
    legs: rows.map((r: any) => ({
      flight_date: r.flight_date,
      aircraft: r.aircraft,
      tail_number: r.tail_number,
      from: r.route_from,
      to: r.route_to,
      flight_no: r.flight_no,
      passengers_raw: r.passengers_raw,
      page: r.page_no,
      source_url: r.source_url,
      sha256: r.sha256,
      cite: `${r.document_title}, page ${r.page_no} — ${r.source_url}`,
    })),
    ...basis,
  };
}

const callTool: McpToolExport['callTool'] = async (name, args) => {
  switch (name) {
    case 'epstein_search_documents': return searchDocuments(args);
    case 'epstein_list_documents': return listDocuments(args);
    case 'epstein_get_document': return getDocument(args);
    case 'epstein_flight_log_search': return flightLogSearch(args);
    default: return { error: `unknown tool: ${name}` };
  }
};

export default { tools, callTool } satisfies McpToolExport;
