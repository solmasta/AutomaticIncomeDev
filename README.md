# AutomaticIncomeDev

## Unclaimed Money Finder (`app/`)

A free search tool over California's public unclaimed-property records,
with an opt-in "help me claim it" lead capture that only pays off if the
user actually gets their money back (contingent/success fee).

**Cost to run: $0** on Cloudflare's and GitHub's free tiers, at the scale
a new project starts at.

### How it works

- `app/` — a Cloudflare Worker that serves the search page and a small
  JSON API (`/api/search`, `/api/lead`), backed by Cloudflare D1.
- `ingest/fetch_ca_unclaimed.js` — a zero-dependency Node script that finds
  and downloads California's official bulk unclaimed-property CSV (state
  refreshes it every Thursday, no login required), keeps only properties
  worth pursuing (`>= $500` by default), and writes D1-ready SQL batches.
- `.github/workflows/refresh-ca-data.yml` — runs that script weekly on
  GitHub Actions (free) and imports the results into D1.

The ingestion script deliberately does its own network fetch from wherever
it runs — it was written and tested in a sandboxed dev environment that
couldn't reach `sco.ca.gov` directly, so it doesn't hardcode assumptions
that could only be verified with real internet access. If the state's page
layout changes and auto-discovery of the CSV link fails, set
`CSV_URL_OVERRIDE` to the direct link (grab it manually from
https://sco.ca.gov/upd_download_property_records.html) and re-run.

### One-time setup (all free, no local CLI needed)

The D1 database (`unclaimed_money_finder`) and its schema already exist —
that part's done. Everything else deploys itself via GitHub Actions:

1. **Create a Cloudflare API token** at
   dash.cloudflare.com/profile/api-tokens → "Create Custom Token" with two
   permission groups: **Account → D1 → Edit** and **Account → Workers
   Scripts → Edit**. Copy the token (shown once).
2. **Find your Cloudflare Account ID** — shown on the right sidebar of any
   page in the Cloudflare dashboard.
3. **Add both as GitHub repo secrets**: Settings → Secrets and variables →
   Actions → New repository secret →
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
4. **Deploy the Worker**: Actions tab → "Deploy Worker" → "Run workflow".
   (After this first manual run, it redeploys automatically on every push
   that touches `app/`.) It prints your live URL in the job log, something
   like `https://unclaimed-money-finder.<you>.workers.dev`.
5. **Load real data**: Actions tab → "Refresh CA unclaimed property data" →
   "Run workflow". This does the first import; after that it runs itself
   weekly.

That's it — no `npm install -g wrangler`, no local login, nothing to run
on your own machine.

### What's automated vs. not

- Automated: search, matching, lead capture, weekly data refresh.
- **Not** automated: actually filing a claim. California requires a signed
  claim form (sometimes notarized) mailed to the Controller's office —
  that step still needs a human. The product's job is finding the money
  and the lead; turning a lead into a filed, paid claim is still manual
  work for now.

### Legal — read before charging anyone a fee

Most states cap what a "finder" can charge for helping someone claim
unclaimed property (commonly 10–20%, varies by state), and several forbid
soliciting a fee until the property has been reported for a minimum period
(commonly ~24 months). `app/src/index.js` has a `STATE_RULES` table that
encodes conservative defaults and is marked `verified: false` — **do not
rely on those numbers**; confirm the current statute for any state you
operate in (starting with California) before collecting a single dollar.
This is not legal advice.

### Scaling notes

D1's free tier (5 GB storage, generous but not unlimited daily read/write
quotas) comfortably fits a single state's `$500+` properties. If a full
weekly refresh ever hits the daily write quota, either spread the import
across a couple of days or move to D1's paid tier (still inexpensive) —
this hasn't been an issue at CA-only scale.

---

## `AUTONOMOUS_AI_AGENT_MONEY_SYSTEMS.md`

Background brainstorm of rare/niche autonomous-agent business models that
led to the idea above — asset recovery agents (#6 in that doc) were picked
as the lowest-capital, fastest-to-first-dollar option.
