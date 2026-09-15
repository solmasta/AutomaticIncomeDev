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

### How you get paid

The site charges a **flat $29 filing-assistance fee via Stripe Checkout,
upfront, before any work starts** — not a cut of what the state pays out.
That's deliberate: the state mails the recovered money straight to the
claimant, so a contingency ("we get paid only if you get paid") model has
no real way to collect without a power-of-attorney + licensed/bonded
finder setup, which needs a lawyer, not code. A flat fee paid before work
begins has no collection problem — Stripe either charges the card or it
doesn't, and `leads.paid` flips to `1` the moment it does.

To turn payments on:
1. Create a free Stripe account at stripe.com, grab your **secret key**
   (dashboard → Developers → API keys).
2. In the Cloudflare dashboard: Workers & Pages → `unclaimed-money-finder`
   → Settings → Variables and Secrets → Add → name it
   `STRIPE_SECRET_KEY`, paste the key, mark it **Encrypt**.
3. In Stripe: Developers → Webhooks → Add endpoint →
   `https://<your-worker>.workers.dev/api/stripe-webhook`, subscribe to
   `checkout.session.completed`. Copy the **signing secret** it gives you.
4. Add that as another encrypted Cloudflare variable:
   `STRIPE_WEBHOOK_SECRET`.

No local CLI needed for either — both are dashboard actions. Change the
fee amount any time by editing `FILING_FEE_CENTS` in `app/wrangler.toml`
(cents, so `2900` = $29) and pushing — the deploy workflow picks it up.

### AI agents

Three Claude-powered agents, each optional and each degrading gracefully
(the surrounding feature just skips the AI step) if its key isn't set.
Called via raw HTTP to `api.anthropic.com` — this Worker is deliberately
dependency-free, same reasoning as the Stripe integration, so there's no
npm bundle for the CI deploy to break on.

1. **Match-confidence agent** — every search sends the candidates to Claude
   Haiku 4.5 in one batched call, which scores 0-100 how likely each is
   really the searcher (accounting for nicknames, common names, city
   corroboration) and shows a badge ("Likely you" / "Verify carefully" /
   "Probably not you") before anyone pays. Protects your refund rate.
2. **Watchlist agent** — a zero-result search offers "notify me later."
   A Cloudflare Cron Trigger (`app/wrangler.toml` → `[triggers]`, Fridays
   14:00 UTC, an hour after the weekly CA data refresh) re-checks every
   open watchlist entry and emails anyone with a new match via Resend —
   the actual "runs while you sleep" piece of this business.
3. **Claim-filing assistant agent** — the moment a Stripe payment lands,
   Claude Sonnet 5 drafts a cover letter and document checklist for the
   claim and emails it to `SUPPORT_EMAIL`, so filing takes minutes instead
   of starting from a blank page. It won't invent state form field names
   or claim numbers it wasn't given — the checklist tells you to verify
   current requirements against the state's own instructions before
   mailing.

To turn these on, add as encrypted Cloudflare variables (same dashboard
path as the Stripe keys above):
- `ANTHROPIC_API_KEY` — console.anthropic.com → API Keys. Powers agents 1 and 3.
- `RESEND_API_KEY` — resend.com (free tier) → API Keys. Powers agents 2 and 3.
  Without a verified sending domain, leave `FROM_EMAIL` at its default
  `onboarding@resend.dev` (Resend's no-setup sandbox sender).

Also set `SITE_URL` in `app/wrangler.toml` to your real `*.workers.dev`
URL once you have it (used in the watchlist-match email link) and push.

### What's automated vs. not

- Automated: search, match-confidence scoring, payment collection, weekly
  data refresh, watchlist re-checking and notification, claim-packet
  drafting.
- **Not** automated: actually filing the claim once someone pays. California
  requires a signed claim form (sometimes notarized) mailed to the
  Controller's office — that step still needs a human. Check the `leads`
  table (`paid = 1`) for who's paid and owed a filed claim; the operator
  email from agent 3 has the drafted cover letter ready to go.

### Legal — read before charging anyone a fee

The flat filing fee is a different legal category from a contingency
"finder fee" (it's a paid document-prep service, not a cut of recovered
property), which is what lets it sidestep most states' finder-fee percent
caps. But several states still forbid *soliciting* any paid help — flat
fee or not — until the property has been reported for a minimum period
(commonly ~24 months), which is what `STATE_RULES` in `app/src/index.js`
still gates on. It's marked `verified: false` on purpose — **do not rely
on those numbers**; confirm the current statute for any state you operate
in (starting with California) before collecting a single dollar. This is
not legal advice.

### Scaling notes

Measured against the real file: CA's `$500+` extract alone is ~760,000
rows, well over D1's free-tier write quota (~100k rows/day) in a single
sync. `.github/workflows/refresh-ca-data.yml` sets `MIN_CASH=5000` for
that reason — it trades search coverage (fewer, higher-value matches)
for a sync that actually completes on the free tier. To widen coverage
back down toward `$500`, either move to D1's (still inexpensive) paid
tier, or spread the import across several days. `BATCH_SIZE=1000` in the
same workflow also cuts the number of `wrangler d1 execute` calls the
import step makes — each call carries CLI startup + network overhead, so
fewer, larger batches materially speeds up the sync.

---

## `AUTONOMOUS_AI_AGENT_MONEY_SYSTEMS.md`

Background brainstorm of rare/niche autonomous-agent business models that
led to the idea above — asset recovery agents (#6 in that doc) were picked
as the lowest-capital, fastest-to-first-dollar option.
