// Unclaimed-money finder: free search over public state unclaimed-property
// records, plus a paid "we'll file it for you" service.
//
// Money model: a FLAT, upfront filing-assistance fee charged via Stripe
// Checkout before any work is done — not a percentage of what the state
// pays out. That's a deliberate choice: a contingency ("we get paid only
// if you get paid") model has no way to actually collect once the state
// mails the check straight to the claimant, short of a power-of-attorney +
// licensed/bonded finder setup that needs a lawyer, not code. A flat fee
// paid before work starts has no collection problem — Stripe either
// charges the card or it doesn't.
//
// IMPORTANT — this is not legal advice. Several states cap/regulate
// contingency "finder fees" tied to a % of recovered unclaimed property;
// this flat fee is a different legal category (paid document-prep service,
// not a cut of recovered property), but confirm that holds in your state
// before relying on it. STATE_RULES below is left in place as an extra,
// conservative gate on top of that — verify it independently either way.
const STATE_RULES = {
  CA: {
    label: "California",
    soliciteWaitMonths: 24,
    verified: false, // set true only after you've confirmed against the current statute
  },
};

const FILING_FEE_LABEL = "Claim filing assistance";

// --- AI agents -------------------------------------------------------
// Called via raw HTTP fetch to api.anthropic.com/resend.com, not their SDKs
// -- this Worker is deliberately dependency-free (see the Stripe
// integration for the same reasoning), which keeps `wrangler deploy`
// simple and avoids introducing an npm bundle this project's CI hasn't
// been set up to test. All three agents degrade gracefully: if a secret
// key is missing or the call fails, the surrounding feature just skips
// the AI step instead of breaking search/checkout/payment.

async function sendEmail(env, { to, subject, html }) {
  if (!env.RESEND_API_KEY) return { ok: false, error: "RESEND_API_KEY not configured" };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.FROM_EMAIL || "onboarding@resend.dev",
      to,
      subject,
      html,
    }),
  });
  if (!res.ok) return { ok: false, error: await res.text() };
  return { ok: true };
}

/** Agent 1: score how likely each search result is really the person who searched. */
async function scoreMatchConfidence(searchedName, candidates, env) {
  if (!env.ANTHROPIC_API_KEY || candidates.length === 0) return {};
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 4096,
        system:
          "You verify identity matches for an unclaimed-property search tool. Given the name someone searched for and a list of candidate property records, score how likely each candidate is that same person, 0-100. Account for nicknames, middle initials, maiden names, and typos. Common names (e.g. \"John Smith\") should score lower without corroborating details like a matching city. Be conservative: overconfidence risks someone paying to file a claim that isn't theirs.",
        messages: [
          {
            role: "user",
            content: JSON.stringify({ searched_name: searchedName, candidates }),
          },
        ],
        output_config: {
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                matches: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "integer" },
                      confidence: { type: "integer" },
                      reason: { type: "string" },
                    },
                    required: ["id", "confidence", "reason"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["matches"],
              additionalProperties: false,
            },
          },
        },
      }),
    });
    if (!res.ok) return {};
    const data = await res.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    if (!textBlock) return {};
    const parsed = JSON.parse(textBlock.text);
    const byId = {};
    for (const m of parsed.matches || []) byId[m.id] = { confidence: m.confidence, reason: m.reason };
    return byId;
  } catch {
    return {};
  }
}

/** Agent 2: draft a filing cover letter + document checklist once someone's paid, and email it to the operator. */
async function draftClaimPacket(lead, property, env) {
  if (!env.ANTHROPIC_API_KEY) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 2048,
        system:
          "You draft claim-filing paperwork for a California unclaimed-property recovery service. Given a claimant's info and a property record, write (1) a short, professional cover letter to include with the mailed claim to the CA State Controller's Office, and (2) a checklist of documents the claimant will likely need to provide (e.g. government ID, proof of current address, SSN if requested). Explicitly note in the checklist that exact requirements should be verified against the state's current claim instructions before mailing, since requirements can change. Do not invent specific form field names or claim numbers you weren't given.",
        messages: [
          {
            role: "user",
            content: JSON.stringify({ claimant: lead, property }),
          },
        ],
        output_config: {
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                cover_letter: { type: "string" },
                document_checklist: { type: "array", items: { type: "string" } },
              },
              required: ["cover_letter", "document_checklist"],
              additionalProperties: false,
            },
          },
        },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    return textBlock ? JSON.parse(textBlock.text) : null;
  } catch {
    return null;
  }
}

/** Agent 4: research one state's real unclaimed-property + auction access using
 * Claude's web_search/web_fetch tools -- it fetches the state's own official
 * pages itself rather than relying on training data or a hand-maintained list,
 * so /states can grow past the handful of states verified manually this
 * session. Findings land in state_coverage for a human to spot-check; a wrong
 * or low-confidence result just shows up as such, it never silently becomes a
 * scraping integration without someone looking at it first. */
async function researchStateCoverage(env, stateCode, stateName) {
  if (!env.ANTHROPIC_API_KEY) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 8000,
        system:
          "You are a careful research agent verifying, for a single US state, (1) how its unclaimed-property program can actually be accessed by an automated tool -- a genuinely open bulk-downloadable dataset like California's, a live search form with no CAPTCHA or bot-detection, CAPTCHA-blocked, bot-detection-blocked (device fingerprinting, honeypot fields), or a JavaScript app whose backend you can't determine from a static fetch -- and (2) whether the state runs, directly or via a named and verifiable vendor, a legitimate public auction for unclaimed safe-deposit-box or other tangible property (like California's Lone Star Auctioneers program). " +
          "Use your web_search and web_fetch tools to find and directly fetch the state's own official .gov page(s) yourself -- never rely on a search-result snippet alone, and never guess or fabricate a URL. Only report a URL as verified if you actually fetched it and saw real content confirming it. Note any CAPTCHA (recaptcha/hcaptcha/turnstile) or bot-detection signal you actually observed in fetched HTML, not ones you assume. Be conservative: if you're not confident, say exactly what you checked and why you're unsure in the notes, rather than guessing.\n\n" +
          "When done, respond with ONLY a single JSON object (no other text, no markdown fences) with exactly these fields: cash_search_type (one of \"bulk_download\", \"live_form_open\", \"captcha_blocked\", \"bot_detected\", \"js_app_unknown\"), cash_search_url (string or null), cash_search_notes (string or null), auction_vendor_verified (true or false), auction_vendor_url (string or null), auction_notes (string or null), confidence (a short string naming exactly what you fetched/checked).",
        messages: [{ role: "user", content: `Research state: ${stateName} (${stateCode}).` }],
        tools: [
          { type: "web_search_20260209", name: "web_search", max_uses: 5 },
          { type: "web_fetch_20260209", name: "web_fetch", max_uses: 5, max_content_tokens: 3000 },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const textBlocks = (data.content || []).filter((b) => b.type === "text");
    const lastText = textBlocks[textBlocks.length - 1]?.text || "";
    const match = lastText.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch {
    return null;
  }
}

/** Runs a small batch of state research per sweep (bounded cost/latency) --
 * re-checks the stalest/never-checked states first, so a full first pass
 * across all 50 states + DC happens gradually rather than all at once. */
async function stateCoverageSweep(env, batchSize = 2) {
  const { results: candidates } = await env.DB.prepare(
    `SELECT state, state_name FROM state_coverage
     WHERE last_checked_at IS NULL OR last_checked_at < datetime('now', '-90 days')
     ORDER BY (last_checked_at IS NULL) DESC, last_checked_at ASC
     LIMIT ?`
  )
    .bind(batchSize)
    .all();

  for (const s of candidates) {
    const findings = await researchStateCoverage(env, s.state, s.state_name);
    if (!findings) continue;
    await env.DB.prepare(
      `UPDATE state_coverage SET
         cash_search_type = ?, cash_search_url = ?, cash_search_notes = ?,
         auction_vendor_verified = ?, auction_vendor_url = ?, auction_notes = ?,
         last_checked_at = datetime('now'), checked_by = 'agent', confidence = ?
       WHERE state = ?`
    )
      .bind(
        findings.cash_search_type || "unchecked",
        findings.cash_search_url || null,
        findings.cash_search_notes || null,
        findings.auction_vendor_verified ? 1 : 0,
        findings.auction_vendor_url || null,
        findings.auction_notes || null,
        findings.confidence || null,
        s.state
      )
      .run();
  }
}

function refundPolicyHtml(env, feeDisplay) {
  const supportEmail = env.SUPPORT_EMAIL || "support@example.com";
  return `
    <ul>
      <li><strong>Before we file:</strong> full refund, no questions asked, any time before your claim has actually been submitted to the state.</li>
      <li><strong>We can't complete it:</strong> if the match doesn't check out, the property's already been claimed, or we can't get documentation from you that the state requires, you get an automatic full refund.</li>
      <li><strong>After we file:</strong> the $${feeDisplay} fee pays for the filing service, which has then been delivered — it's non-refundable at that point, including if the state later denies or delays the claim, since that decision is the state's, not ours.</li>
      <li><strong>Our error:</strong> if we make a mistake preparing or filing your claim, you get a full refund regardless of timing.</li>
      <li>Refunds go back to your original payment method within 5 business days of approval.</li>
      <li>Questions or refund requests: <a href="mailto:${supportEmail}">${supportEmail}</a></li>
    </ul>`;
}

function refundPolicyPage(env) {
  const feeCents = Number(env.FILING_FEE_CENTS || 2900);
  const feeDisplay = (feeCents / 100).toFixed(2);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Refund Policy</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px 16px 64px; background: #fafafa; color: #1a1a1a; }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } }
  li { margin-bottom: 10px; }
  a { color: inherit; }
</style>
</head>
<body>
  <p><a href="/">&larr; Back to search</a></p>
  <h1>Refund Policy</h1>
  ${refundPolicyHtml(env, feeDisplay)}
</body>
</html>`;
}

// The national NAUPA clearinghouse (unclaimed.org) is the verified fallback
// for cash search on any state the coverage agent hasn't confirmed a direct
// link for -- reachable with no CAPTCHA/bot-block on a plain fetch, and it's
// the clearinghouse endorsed by state unclaimed-property administrators.
const NAUPA_SEARCH_URL = "https://unclaimed.org/search/";

const CASH_SEARCH_LABELS = {
  bulk_download: "Official state site →",
  live_form_open: "Official state site →",
  captcha_blocked: "Official state site →",
  bot_detected: "Official state site →",
  js_app_unknown: "Official state site →",
};

function statesRowHtml(s) {
  const isCA = s.state === "CA";
  const cashUrl = isCA ? "/" : s.cash_search_url || NAUPA_SEARCH_URL;
  const cashLabel = isCA
    ? "Full search built into this site"
    : s.cash_search_url
    ? CASH_SEARCH_LABELS[s.cash_search_type] || "Official state site →"
    : "Search via NAUPA →";
  const auctionLink = s.auction_vendor_verified && s.auction_vendor_url
    ? `<div class="meta"><a href="${s.auction_vendor_url}" target="_blank" rel="noopener">Safe-deposit-box auction listings →</a></div>`
    : "";
  return `<div class="row">
    <span>${s.state_name}</span>
    <span>
      <a href="${cashUrl}"${cashUrl === "/" ? "" : ' target="_blank" rel="noopener"'}>${cashLabel}</a>
      ${auctionLink}
    </span>
  </div>`;
}

async function statesPage(env) {
  const { results } = await env.DB.prepare(
    `SELECT state, state_name, cash_search_type, cash_search_url, auction_vendor_verified, auction_vendor_url
     FROM state_coverage ORDER BY state_name ASC`
  ).all();
  const rows = results.map(statesRowHtml).join("");
  const uncheckedCount = results.filter((s) => s.cash_search_type === "unchecked").length;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unclaimed Property by State</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px 16px 64px; background: #fafafa; color: #1a1a1a; }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } .row { border-color: #333 !important; } }
  a { color: inherit; }
  .row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 10px 0; border-bottom: 1px solid #ddd; flex-wrap: wrap; }
  .meta { font-size: 0.78rem; color: #888; flex-basis: 100%; }
  .disclosure { font-size: 0.85rem; color: #666; margin-top: 24px; }
</style>
</head>
<body>
  <p><a href="/">&larr; Back to California search</a></p>
  <h1>Unclaimed Property by State</h1>
  <p>This site's own free search only covers California. For every other state, here's a direct link to that state's own official search tool (or the national NAUPA clearinghouse, where we haven't confirmed a state's own direct link yet) — all free, no signup. A research agent keeps checking for more states and for legitimate safe-deposit-box auction programs over time${uncheckedCount ? ` (${uncheckedCount} states not yet individually checked)` : ""}.</p>
  ${rows}
  <div class="disclosure">Links go to official state, NAUPA, or a verified official state auction vendor. We don't operate or control any of them, don't take bids or hold money for any auctioned property, and don't offer paid filing help for any state but California.</div>
</body>
</html>`;
}

function htmlPage(env) {
  const feeCents = Number(env.FILING_FEE_CENTS || 2900);
  const feeDisplay = (feeCents / 100).toFixed(2);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Find Your Unclaimed Money</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px 16px 64px; background: #fafafa; color: #1a1a1a; }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } input, button { background: #222 !important; color: #eee !important; border-color: #444 !important; } .card { background: #1b1b1b !important; border-color: #333 !important; } }
  h1 { font-size: 1.5rem; margin-bottom: 4px; }
  p.sub { color: #666; margin-top: 0; }
  form { display: flex; gap: 8px; margin: 20px 0; flex-wrap: wrap; }
  input[type=text] { flex: 1; min-width: 200px; padding: 10px 12px; font-size: 1rem; border: 1px solid #ccc; border-radius: 8px; }
  button { padding: 10px 16px; font-size: 1rem; border: none; border-radius: 8px; background: #2563eb; color: white; cursor: pointer; }
  button:hover { background: #1d4ed8; }
  .card { border: 1px solid #ddd; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; background: white; }
  .amount { font-weight: 600; font-size: 1.1rem; }
  .meta { color: #666; font-size: 0.9rem; margin-top: 4px; }
  .disclosure { font-size: 0.85rem; color: #666; border-top: 1px solid #ddd; margin-top: 32px; padding-top: 16px; }
  .banner { padding: 10px 14px; border-radius: 8px; margin-bottom: 16px; font-size: 0.9rem; }
  .banner.ok { background: #d1fae5; color: #065f46; }
  .banner.cancelled { background: #fee2e2; color: #991b1b; }
  .cta { margin-top: 10px; }
  .cta button { background: #059669; font-size: 0.9rem; padding: 8px 12px; }
  #status { color: #666; margin: 12px 0; }
  .lead-form { display: none; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .lead-form input { flex: 1; min-width: 160px; padding: 8px 10px; border-radius: 6px; border: 1px solid #ccc; }
  .policy-note { flex-basis: 100%; font-size: 0.78rem; color: #888; }
  .policy-note a { color: inherit; }
  .confidence { display: inline-block; font-size: 0.75rem; padding: 2px 8px; border-radius: 999px; margin-left: 8px; vertical-align: middle; }
  .confidence.high { background: #d1fae5; color: #065f46; }
  .confidence.medium { background: #fef3c7; color: #92400e; }
  .confidence.low { background: #fee2e2; color: #991b1b; }
  .watch-form { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .watch-form input { flex: 1; min-width: 160px; padding: 8px 10px; border-radius: 6px; border: 1px solid #ccc; }
</style>
</head>
<body>
  <h1>Find Your Unclaimed Money</h1>
  <p class="sub">Free search of California's public unclaimed-property records. You can always file the claim yourself for free directly with the state — or pay a flat $${feeDisplay} fee to have it prepared and filed for you. Not in California? <a href="/states">Find your state's official search →</a></p>
  <div id="payment-banner"></div>
  <form id="search-form">
    <input type="text" id="name" placeholder="Your full name (e.g. Jane A Smith)" required>
    <button type="submit">Search</button>
  </form>
  <div id="status"></div>
  <div id="results"></div>

  <div class="disclosure">
    <strong>How this works:</strong> Search is always free, no signup required.
    Filing a claim yourself with the state is also free — you never have to
    pay us anything. The $${feeDisplay} fee is only for the optional
    convenience of having us prepare and file the paperwork for you, charged
    upfront regardless of outcome, not a cut of any money you recover.
    See our <a href="/refund-policy">refund policy</a>.
  </div>

  <script>
    const form = document.getElementById('search-form');
    const status = document.getElementById('status');
    const results = document.getElementById('results');
    const banner = document.getElementById('payment-banner');

    const paidState = new URLSearchParams(location.search).get('paid');
    if (paidState === 'success') {
      banner.innerHTML = '<div class="banner ok">Payment received — we\\'ll be in touch to file your claim.</div>';
    } else if (paidState === 'cancelled') {
      banner.innerHTML = '<div class="banner cancelled">Checkout cancelled — no charge was made.</div>';
    }

    function money(n) {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('name').value.trim();
      if (!name) return;
      status.textContent = 'Searching...';
      results.innerHTML = '';
      try {
        const res = await fetch('/api/search?name=' + encodeURIComponent(name));
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Search failed');
        if (data.results.length === 0) {
          status.textContent = 'No matches found for "' + name + '" in the California database yet.';
          results.innerHTML = \`
            <div class="card">
              <div class="meta">New properties get reported to the state all the time. Want us to email you if "\${name}" shows up in a future weekly update?</div>
              <form class="watch-form" id="watch-form">
                <input type="text" name="full_name" placeholder="Full name" value="\${name}" required>
                <input type="email" name="email" placeholder="Email" required>
                <button type="submit">Notify me</button>
              </form>
            </div>\`;
          document.getElementById('watch-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const fd = new FormData(e.target);
            await fetch('/api/watchlist', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ full_name: fd.get('full_name'), email: fd.get('email') }),
            });
            e.target.outerHTML = '<em>Thanks — we\\'ll email you if a match shows up.</em>';
          });
          return;
        }
        status.textContent = data.results.length + ' possible match(es) found. Verify these are really you before doing anything.';
        results.innerHTML = data.results.map((r) => {
          let confBadge = '';
          if (typeof r.confidence === 'number') {
            const tier = r.confidence >= 75 ? 'high' : r.confidence >= 40 ? 'medium' : 'low';
            const label = tier === 'high' ? 'Likely you' : tier === 'medium' ? 'Verify carefully' : 'Probably not you';
            confBadge = '<span class="confidence ' + tier + '" title="' + (r.confidence_reason || '').replace(/"/g, '&quot;') + '">' + label + ' (' + r.confidence + '%)</span>';
          } else if (r.match_tier === 'nickname') {
            confBadge = '<span class="confidence medium" title="Matched via a common nickname/formal-name variant, not your exact search terms">Nickname match</span>';
          } else if (r.match_tier === 'partial') {
            confBadge = '<span class="confidence low" title="Only part of your search matched this record — double check it\\'s really you">Partial match</span>';
          }
          return \`
          <div class="card">
            <div class="amount">\${money(r.cash_reported || 0)}\${confBadge}</div>
            <div class="meta">\${r.owner_name} — \${r.city || 'CA'} — held by \${r.holder_name || 'unknown holder'}</div>
            <div class="meta">Reported: \${r.reported_date || 'unknown'} \${r.can_solicit ? '' : '(too recent for us to offer paid help — claim it yourself for free)'}</div>
            <div class="cta">
              <a href="https://www.sco.ca.gov/upd_form_claim.html" target="_blank" rel="noopener">File it yourself for free →</a>
              \${r.can_solicit ? ' &nbsp;or&nbsp; <button class="ask-help" data-id="' + r.id + '">Pay $${feeDisplay} to have us file it</button>' : ''}
            </div>
            <form class="lead-form" data-id="\${r.id}">
              <input type="text" name="full_name" placeholder="Full name" required>
              <input type="email" name="email" placeholder="Email" required>
              <button type="submit">Continue to payment</button>
              <div class="policy-note">By paying you agree to our <a href="/refund-policy" target="_blank" rel="noopener">refund policy</a> — full refund any time before we file, non-refundable after.</div>
            </form>
          </div>
        \`;
        }).join('');

        document.querySelectorAll('.ask-help').forEach((btn) => {
          btn.addEventListener('click', () => {
            const formEl = document.querySelector('.lead-form[data-id="' + btn.dataset.id + '"]');
            formEl.style.display = 'flex';
            btn.style.display = 'none';
          });
        });

        document.querySelectorAll('.lead-form').forEach((formEl) => {
          formEl.addEventListener('submit', async (e) => {
            e.preventDefault();
            const fd = new FormData(formEl);
            const submitBtn = formEl.querySelector('button');
            submitBtn.disabled = true;
            submitBtn.textContent = 'Redirecting to payment...';
            try {
              const res = await fetch('/api/checkout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  property_id: formEl.dataset.id,
                  full_name: fd.get('full_name'),
                  email: fd.get('email'),
                }),
              });
              const data = await res.json();
              if (!res.ok || !data.url) throw new Error(data.error || 'Could not start checkout');
              location.href = data.url;
            } catch (err) {
              submitBtn.disabled = false;
              submitBtn.textContent = 'Continue to payment';
              alert('Error: ' + err.message);
            }
          });
        });
      } catch (err) {
        status.textContent = 'Error: ' + err.message;
      }
    });
  </script>
</body>
</html>`;
}

function normalizeName(name) {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function canSolicit(state, reportedDate) {
  const rule = STATE_RULES[state];
  if (!rule) return false;
  if (!reportedDate) return true;
  const reported = new Date(reportedDate);
  if (isNaN(reported.getTime())) return true;
  const monthsAgo = (Date.now() - reported.getTime()) / (1000 * 60 * 60 * 24 * 30);
  return monthsAgo >= rule.soliciteWaitMonths;
}

// Common English nickname/formal-name groups, so searching either "Bob Smith"
// or "Robert Smith" finds a record filed under the other form. Deliberately
// not exhaustive -- covers the names common enough to matter for a general
// search tool, not a linguistics project.
const NICKNAME_GROUPS = [
  ["ROBERT", "BOB", "BOBBY", "ROB", "ROBBIE"],
  ["WILLIAM", "BILL", "BILLY", "WILL", "WILLIE"],
  ["RICHARD", "RICK", "RICKY", "DICK", "RICH"],
  ["JAMES", "JIM", "JIMMY", "JAMIE"],
  ["MICHAEL", "MIKE", "MICKEY"],
  ["ELIZABETH", "LIZ", "BETH", "LIZZIE", "BETTY", "ELIZA"],
  ["CHARLES", "CHUCK", "CHARLIE"],
  ["ANTHONY", "TONY"],
  ["THOMAS", "TOM", "TOMMY"],
  ["DAVID", "DAVE", "DAVEY"],
  ["STEVEN", "STEPHEN", "STEVE"],
  ["KENNETH", "KEN", "KENNY"],
  ["RONALD", "RON", "RONNIE"],
  ["DONALD", "DON", "DONNIE"],
  ["EDWARD", "ED", "EDDIE", "TED"],
  ["FREDERICK", "FRED", "FREDDIE"],
  ["GREGORY", "GREG"],
  ["JEFFREY", "JEFF"],
  ["JOSEPH", "JOE", "JOEY"],
  ["LAWRENCE", "LARRY"],
  ["MATTHEW", "MATT"],
  ["NICHOLAS", "NICK", "NICKY"],
  ["PATRICK", "PAT", "PATTY"],
  ["SAMUEL", "SAM", "SAMMY"],
  ["SUSAN", "SUE", "SUZY"],
  ["ANDREW", "ANDY", "DREW"],
  ["ALEXANDER", "ALEX"],
  ["BENJAMIN", "BEN", "BENNY"],
  ["DANIEL", "DAN", "DANNY"],
  ["JENNIFER", "JEN", "JENNY", "JENN"],
  ["KATHERINE", "CATHERINE", "KATE", "KATIE", "KATHY", "CATHY"],
  ["MARGARET", "MEG", "MAGGIE", "PEGGY"],
  ["PATRICIA", "TRISH"],
  ["DEBORAH", "DEB", "DEBBIE"],
  ["BARBARA", "BARB", "BARBIE"],
  ["CHRISTOPHER", "CHRIS"],
  ["TIMOTHY", "TIM", "TIMMY"],
  ["GERALD", "GERRY", "JERRY"],
  ["RAYMOND", "RAY"],
  ["FRANCIS", "FRANK", "FRANKIE"],
  ["FRANCES", "FRAN", "FRANNIE"],
  ["VICTORIA", "VICKY", "TORI"],
  ["REBECCA", "BECKY"],
  ["CYNTHIA", "CINDY"],
  ["DOROTHY", "DOT", "DOTTIE"],
];
const NICKNAME_MAP = Object.fromEntries(NICKNAME_GROUPS.flatMap((g) => g.map((n) => [n, g])));

async function runTokenQuery(env, tokens) {
  const conditions = tokens.map(() => "owner_name_normalized LIKE ?").join(" AND ");
  const params = tokens.map((t) => `%${t}%`);
  const { results } = await env.DB.prepare(
    `SELECT id, owner_name, city, state, holder_name, property_type, cash_reported, reported_date
     FROM properties WHERE ${conditions}
     ORDER BY cash_reported DESC LIMIT 25`
  )
    .bind(...params)
    .all();
  return results;
}

async function handleSearch(url, env) {
  const name = (url.searchParams.get("name") || "").trim();
  if (name.length < 2) {
    return Response.json({ error: "Enter at least 2 characters" }, { status: 400 });
  }
  const normalized = normalizeName(name);
  const tokens = normalized.split(" ").filter(Boolean).slice(0, 4);
  if (tokens.length === 0) {
    return Response.json({ error: "Enter a name" }, { status: 400 });
  }

  // Tier 1: every token must match -- the precise, high-confidence case.
  const exact = await runTokenQuery(env, tokens);
  const seen = new Set(exact.map((r) => r.id));
  let results = exact.map((r) => ({ ...r, match_tier: "exact" }));

  // Tier 2: substitute known nickname/formal-name variants (only fires when
  // tier 1 came up thin) -- catches "Bob Smith" vs. a record filed as
  // "Robert Smith", in either direction.
  if (results.length === 0) {
    const variantQueries = [];
    for (let i = 0; i < tokens.length; i++) {
      for (const variant of NICKNAME_MAP[tokens[i]] || []) {
        if (variant === tokens[i]) continue;
        const variantTokens = [...tokens];
        variantTokens[i] = variant;
        variantQueries.push(runTokenQuery(env, variantTokens));
      }
    }
    for (const batch of await Promise.all(variantQueries)) {
      for (const r of batch) if (!seen.has(r.id)) { seen.add(r.id); results.push({ ...r, match_tier: "nickname" }); }
    }
  }

  // Tier 3: drop exactly one token (a middle initial, a dropped nickname
  // that isn't in the map, a truncated name) -- broader net, lower
  // confidence, only used as a last resort when tiers 1-2 are still thin.
  if (results.length === 0 && tokens.length > 1) {
    const subsetQueries = tokens.map((_, i) => runTokenQuery(env, tokens.filter((_, idx) => idx !== i)));
    for (const batch of await Promise.all(subsetQueries)) {
      for (const r of batch) if (!seen.has(r.id)) { seen.add(r.id); results.push({ ...r, match_tier: "partial" }); }
    }
  }

  results = results.slice(0, 25);

  const confidence = await scoreMatchConfidence(
    name,
    results.map((r) => ({ id: r.id, owner_name: r.owner_name, city: r.city, holder_name: r.holder_name })),
    env
  );
  const enriched = results.map((r) => ({
    ...r,
    can_solicit: canSolicit(r.state, r.reported_date),
    confidence: confidence[r.id]?.confidence ?? null,
    confidence_reason: confidence[r.id]?.reason ?? null,
  }));
  return Response.json({ results: enriched });
}

/** Agent 3: weekly watchlist sweep -- emails anyone watching a name that just got a match. */
async function handleWatchlist(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.email || !body.full_name) {
    return Response.json({ error: "email and full_name are required" }, { status: 400 });
  }
  await env.DB.prepare(`INSERT INTO watchlist (email, full_name, name_normalized) VALUES (?, ?, ?)`)
    .bind(body.email, body.full_name, normalizeName(body.full_name))
    .run();
  return Response.json({ ok: true });
}

async function watchlistSweep(env) {
  const { results: watchers } = await env.DB.prepare(
    `SELECT id, email, full_name, name_normalized FROM watchlist WHERE notified_at IS NULL`
  ).all();

  for (const w of watchers) {
    const tokens = w.name_normalized.split(" ").filter(Boolean).slice(0, 4);
    if (tokens.length === 0) continue;
    const conditions = tokens.map(() => "owner_name_normalized LIKE ?").join(" AND ");
    const params = tokens.map((t) => `%${t}%`);
    const { results: matches } = await env.DB.prepare(
      `SELECT owner_name, city, holder_name, cash_reported FROM properties WHERE ${conditions} LIMIT 5`
    )
      .bind(...params)
      .all();
    if (matches.length === 0) continue;

    const list = matches
      .map((m) => `<li>$${(m.cash_reported || 0).toLocaleString()} — ${m.owner_name}, ${m.city || "CA"} (held by ${m.holder_name || "unknown"})</li>`)
      .join("");
    await sendEmail(env, {
      to: w.email,
      subject: "We found a possible unclaimed-money match for you",
      html: `<p>Hi ${w.full_name},</p><p>A search for your name just turned up a possible match in California's unclaimed-property records:</p><ul>${list}</ul><p>Search again to verify and claim it: <a href="${env.SITE_URL || "#"}">${env.SITE_URL || "the site"}</a>.</p>`,
    });
    await env.DB.prepare(`UPDATE watchlist SET notified_at = datetime('now') WHERE id = ?`).bind(w.id).run();
  }
}

/** Create a lead row + a Stripe Checkout Session for the flat filing fee. */
async function handleCheckout(request, env, origin) {
  const body = await request.json().catch(() => null);
  if (!body || !body.email || !body.full_name) {
    return Response.json({ error: "email and full_name are required" }, { status: 400 });
  }
  if (!env.STRIPE_SECRET_KEY) {
    return Response.json({ error: "Payments aren't configured yet (missing STRIPE_SECRET_KEY)." }, { status: 500 });
  }

  const feeCents = Number(env.FILING_FEE_CENTS || 2900);
  const { meta } = await env.DB.prepare(
    `INSERT INTO leads (email, full_name, property_id) VALUES (?, ?, ?)`
  )
    .bind(body.email, body.full_name, body.property_id || null)
    .run();
  const leadId = meta.last_row_id;

  const params = new URLSearchParams({
    mode: "payment",
    "success_url": `${origin}/?paid=success`,
    "cancel_url": `${origin}/?paid=cancelled`,
    "customer_email": body.email,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(feeCents),
    "line_items[0][price_data][product_data][name]": FILING_FEE_LABEL,
    "metadata[lead_id]": String(leadId),
    "metadata[property_id]": String(body.property_id || ""),
  });

  const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const session = await stripeRes.json();
  if (!stripeRes.ok) {
    return Response.json({ error: session.error?.message || "Stripe error" }, { status: 502 });
  }

  await env.DB.prepare(`UPDATE leads SET stripe_session_id = ? WHERE id = ?`).bind(session.id, leadId).run();
  return Response.json({ url: session.url });
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const parts = Object.fromEntries(signatureHeader.split(",").map((p) => p.split("=")));
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signedPayload = `${timestamp}.${rawBody}`;
  const signatureBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const expected = hex(signatureBuf);

  if (expected.length !== v1.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return mismatch === 0;
}

async function handleStripeWebhook(request, env) {
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");
  if (!env.STRIPE_WEBHOOK_SECRET || !(await verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET))) {
    return new Response("Invalid signature", { status: 400 });
  }

  const event = JSON.parse(rawBody);
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    await env.DB.prepare(
      `UPDATE leads SET paid = 1, paid_at = datetime('now') WHERE stripe_session_id = ?`
    )
      .bind(session.id)
      .run();

    const lead = await env.DB.prepare(
      `SELECT id, full_name, email, property_id FROM leads WHERE stripe_session_id = ?`
    )
      .bind(session.id)
      .first();
    if (lead) {
      const property = lead.property_id
        ? await env.DB.prepare(`SELECT owner_name, city, holder_name, property_type, cash_reported, reported_date FROM properties WHERE id = ?`)
            .bind(lead.property_id)
            .first()
        : null;
      const packet = await draftClaimPacket(lead, property, env);
      if (packet && env.SUPPORT_EMAIL) {
        const checklist = packet.document_checklist.map((item) => `<li>${item}</li>`).join("");
        await sendEmail(env, {
          to: env.SUPPORT_EMAIL,
          subject: `New paid claim to file: ${lead.full_name}`,
          html: `<p><strong>Claimant:</strong> ${lead.full_name} (${lead.email})</p><p><strong>Property:</strong> ${property ? `${property.owner_name} — $${property.cash_reported} — held by ${property.holder_name || "unknown"}` : "unknown"}</p><h3>Cover letter draft</h3><pre style="white-space:pre-wrap;font-family:inherit">${packet.cover_letter}</pre><h3>Document checklist</h3><ul>${checklist}</ul>`,
        });
      }
    }
  }
  return Response.json({ received: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response(htmlPage(env), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/refund-policy") {
      return new Response(refundPolicyPage(env), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/states") {
      return new Response(await statesPage(env), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/api/search" && request.method === "GET") {
      return handleSearch(url, env);
    }
    if (url.pathname === "/api/checkout" && request.method === "POST") {
      return handleCheckout(request, env, url.origin);
    }
    if (url.pathname === "/api/stripe-webhook" && request.method === "POST") {
      return handleStripeWebhook(request, env);
    }
    if (url.pathname === "/api/watchlist" && request.method === "POST") {
      return handleWatchlist(request, env);
    }
    // Debug-only: manually fire one round of state research on demand, instead
    // of waiting for the weekly cron, so a newly-added ANTHROPIC_API_KEY can
    // be verified immediately. Gated behind ADMIN_KEY if one is set; remove
    // this route (or set ADMIN_KEY) once you're done testing.
    if (url.pathname === "/api/admin/run-coverage-sweep" && request.method === "GET") {
      if (env.ADMIN_KEY && url.searchParams.get("key") !== env.ADMIN_KEY) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (!env.ANTHROPIC_API_KEY) {
        return Response.json({ ran: false, reason: "ANTHROPIC_API_KEY not set" }, { status: 200 });
      }
      await stateCoverageSweep(env, 1);
      return Response.json({ ran: true });
    }
    return new Response("Not found", { status: 404 });
  },

  /** Runs on the cron in wrangler.toml -- an hour after the weekly CA data refresh. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(watchlistSweep(env));
    ctx.waitUntil(stateCoverageSweep(env));
  },
};
