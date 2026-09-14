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
</style>
</head>
<body>
  <h1>Find Your Unclaimed Money</h1>
  <p class="sub">Free search of California's public unclaimed-property records. You can always file the claim yourself for free directly with the state — or pay a flat $${feeDisplay} fee to have it prepared and filed for you.</p>
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
          return;
        }
        status.textContent = data.results.length + ' possible match(es) found. Verify these are really you before doing anything.';
        results.innerHTML = data.results.map((r) => \`
          <div class="card">
            <div class="amount">\${money(r.cash_reported || 0)}</div>
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
        \`).join('');

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

  const conditions = tokens.map(() => "owner_name_normalized LIKE ?").join(" AND ");
  const params = tokens.map((t) => `%${t}%`);
  const stmt = env.DB.prepare(
    `SELECT id, owner_name, city, state, holder_name, property_type, cash_reported, reported_date
     FROM properties WHERE ${conditions}
     ORDER BY cash_reported DESC LIMIT 25`
  ).bind(...params);

  const { results } = await stmt.all();
  const enriched = results.map((r) => ({ ...r, can_solicit: canSolicit(r.state, r.reported_date) }));
  return Response.json({ results: enriched });
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
    if (url.pathname === "/api/search" && request.method === "GET") {
      return handleSearch(url, env);
    }
    if (url.pathname === "/api/checkout" && request.method === "POST") {
      return handleCheckout(request, env, url.origin);
    }
    if (url.pathname === "/api/stripe-webhook" && request.method === "POST") {
      return handleStripeWebhook(request, env);
    }
    return new Response("Not found", { status: 404 });
  },
};
