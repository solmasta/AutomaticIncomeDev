#!/usr/bin/env node
// One-off reconnaissance: for each candidate state, fetch its public unclaimed-
// property search page and report real, observable signals about how it's
// actually built -- not a guess from search-engine summaries. Run this from
// somewhere with real internet access (GitHub Actions, not this sandboxed dev
// container, which blocks most .gov domains outright).
//
// What it checks per URL:
//   - Does it load a CAPTCHA library (recaptcha/hcaptcha/turnstile)? If so,
//     that page's search almost certainly can't be automated at all.
//   - What <form> tags exist, their action/method -- reveals whether search
//     submits as a plain HTML form post (scrapeable, if no CAPTCHA) or is
//     JS-driven (likely calling a JSON API under the hood).
//   - Any inline <script> content mentioning fetch/XHR/api paths -- a hint at
//     an underlying API endpoint worth investigating directly.
//
// This is necessarily approximate (a static fetch can't fully replicate what
// happens after a real search submission in a JS-heavy page), but it's real
// signal instead of speculation, and cheap enough to run against many
// candidates before committing to building a real integration for any of them.

const CANDIDATES = {
  TX_new: "https://www.claimittexas.gov/app/claim-search",
  TX_legacy: "https://mycpa.cpa.state.tx.us/up/search.jsp",
  NY: "https://www.osc.ny.gov/unclaimed-funds",
  FL: "https://www.fltreasurehunt.gov/ClaimSearch/Search",
  PA: "https://www.patreasury.gov/unclaimed-property/",
  IL: "https://icash.illinoistreasurer.gov/",
};

const CAPTCHA_MARKERS = ["recaptcha", "hcaptcha", "turnstile", "g-recaptcha", "cf-turnstile"];

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; research-bot/1.0)" },
    redirect: "follow",
  });
  const text = await res.text();
  return { status: res.status, finalUrl: res.url, text };
}

function findForms(html) {
  const forms = [];
  const re = /<form[^>]*action="([^"]*)"[^>]*method="([^"]*)"[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) forms.push({ action: m[1], method: m[2] });
  // Also catch forms with method before action or no action at all
  const re2 = /<form\b[^>]*>/gi;
  const allForms = html.match(re2) || [];
  return { detailed: forms, rawCount: allForms.length };
}

function findApiHints(html) {
  const hints = new Set();
  const scriptBlocks = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of scriptBlocks) {
    const apiPathMatches = block.match(/["'`](\/[a-zA-Z0-9_\-\/]*(?:api|search|query)[a-zA-Z0-9_\-\/]*)["'`]/gi) || [];
    for (const p of apiPathMatches) hints.add(p.replace(/["'`]/g, ""));
  }
  return [...hints].slice(0, 10);
}

async function main() {
  const report = {};
  for (const [name, url] of Object.entries(CANDIDATES)) {
    try {
      const { status, finalUrl, text } = await fetchText(url);
      const lowerText = text.toLowerCase();
      const captcha = CAPTCHA_MARKERS.filter((m) => lowerText.includes(m));
      const forms = findForms(text);
      const apiHints = findApiHints(text);
      report[name] = {
        requestedUrl: url,
        finalUrl,
        status,
        htmlBytes: text.length,
        captchaMarkersFound: captcha,
        formCount: forms.rawCount,
        formDetails: forms.detailed,
        apiPathHints: apiHints,
      };
    } catch (err) {
      report[name] = { requestedUrl: url, error: String(err) };
    }
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
