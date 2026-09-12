// Unclaimed-money finder: free search over public state unclaimed-property
// records, with an opt-in "help me claim it" lead capture that only pays off
// if the person actually gets their money.
//
// IMPORTANT — this is not legal advice. Most states cap the fee a "finder"
// can charge for helping someone claim unclaimed property, and many forbid
// soliciting a fee until the property has been on the state's books for a
// while (commonly ~24 months). STATE_RULES below encodes conservative
// defaults; verify the actual current statute for every state you operate
// in before charging anyone anything.
const STATE_RULES = {
  CA: {
    label: "California",
    feeCapPercent: 10,
    soliciteWaitMonths: 24,
    verified: false, // set true only after you've confirmed against the current statute
  },
};

function htmlPage() {
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
  .cta { margin-top: 10px; }
  .cta button { background: #059669; font-size: 0.9rem; padding: 8px 12px; }
  #status { color: #666; margin: 12px 0; }
  .lead-form { display: none; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .lead-form input { flex: 1; min-width: 160px; padding: 8px 10px; border-radius: 6px; border: 1px solid #ccc; }
</style>
</head>
<body>
  <h1>Find Your Unclaimed Money</h1>
  <p class="sub">Free search of California's public unclaimed-property records. If we find money that's yours, you can try to claim it yourself for free — or ask us to handle the paperwork for a cut of what you recover.</p>
  <form id="search-form">
    <input type="text" id="name" placeholder="Your full name (e.g. Jane A Smith)" required>
    <button type="submit">Search</button>
  </form>
  <div id="status"></div>
  <div id="results"></div>

  <div class="disclosure">
    <strong>How this works:</strong> Search is always free, no signup required.
    We only get paid if you get paid — and only up to what your state legally
    allows a finder to charge (we cap our fee at your state's limit and
    disclose it before you agree to anything). Some states require the
    property to have been on the books for a while before a finder can even
    offer to help; if that applies, we'll tell you and point you to the free
    self-service claim process instead.
  </div>

  <script>
    const form = document.getElementById('search-form');
    const status = document.getElementById('status');
    const results = document.getElementById('results');

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
            <div class="meta">Reported: \${r.reported_date || 'unknown'} \${r.can_solicit ? '' : '(too recent for a finder fee — claim it yourself for free)'}</div>
            <div class="cta">
              \${r.can_solicit
                ? '<button class="ask-help" data-id="' + r.id + '">Ask us to help claim it (' + r.fee_cap_percent + '% fee, only if you get paid)</button>'
                : '<a href="https://www.sco.ca.gov/upd_form_claim.html" target="_blank" rel="noopener">File it yourself for free →</a>'}
            </div>
            <form class="lead-form" data-id="\${r.id}">
              <input type="text" name="full_name" placeholder="Full name" required>
              <input type="email" name="email" placeholder="Email" required>
              <button type="submit">Send</button>
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
            await fetch('/api/lead', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                property_id: formEl.dataset.id,
                full_name: fd.get('full_name'),
                email: fd.get('email'),
              }),
            });
            formEl.innerHTML = '<em>Thanks — we\\'ll be in touch.</em>';
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
  if (!rule) return { allowed: false, feeCapPercent: 0 };
  if (!reportedDate) return { allowed: true, feeCapPercent: rule.feeCapPercent };
  const reported = new Date(reportedDate);
  if (isNaN(reported.getTime())) return { allowed: true, feeCapPercent: rule.feeCapPercent };
  const monthsAgo = (Date.now() - reported.getTime()) / (1000 * 60 * 60 * 24 * 30);
  return { allowed: monthsAgo >= rule.soliciteWaitMonths, feeCapPercent: rule.feeCapPercent };
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
  const enriched = results.map((r) => {
    const { allowed, feeCapPercent } = canSolicit(r.state, r.reported_date);
    return { ...r, can_solicit: allowed, fee_cap_percent: feeCapPercent };
  });
  return Response.json({ results: enriched });
}

async function handleLead(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.email || !body.full_name) {
    return Response.json({ error: "email and full_name are required" }, { status: 400 });
  }
  await env.DB.prepare(
    `INSERT INTO leads (email, full_name, property_id, message) VALUES (?, ?, ?, ?)`
  )
    .bind(body.email, body.full_name, body.property_id || null, body.message || null)
    .run();
  return Response.json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" ) {
      return new Response(htmlPage(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/api/search" && request.method === "GET") {
      return handleSearch(url, env);
    }
    if (url.pathname === "/api/lead" && request.method === "POST") {
      return handleLead(request, env);
    }
    return new Response("Not found", { status: 404 });
  },
};
