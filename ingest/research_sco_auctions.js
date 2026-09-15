#!/usr/bin/env node
// Verify CA's actual safe-deposit-box property auction program before
// building anything around it -- this sandbox can't reach either domain
// directly, so checking from GitHub Actions the same way as other recon.
//
// Goal: confirm (a) SCO's own site names its real auction vendor/process,
// and (b) that vendor's page is real and shows genuine auction info, not
// guess at either.

async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; research-bot/1.0)" }, redirect: "follow" });
  return { status: res.status, finalUrl: res.url, text: await res.text() };
}

async function main() {
  const urls = [
    "https://www.sco.ca.gov/upd_faq_about-unclaimed-property.html",
    "https://www.sco.ca.gov/upd_about_unclaimed_property.html",
    "http://www.lonestarauctioneers.com/auctions/SCO/index.asp",
  ];
  for (const url of urls) {
    try {
      const { status, finalUrl, text } = await fetchText(url);
      console.log(`\n=== ${url} ===`);
      console.log("status:", status, "finalUrl:", finalUrl, "bytes:", text.length);
      const lower = text.toLowerCase();
      console.log("mentions 'safe deposit':", lower.includes("safe deposit"));
      console.log("mentions 'auction':", lower.includes("auction"));
      console.log("mentions 'lone star':", lower.includes("lone star"));
      console.log("mentions 'state controller':", lower.includes("state controller"));
      console.log("mentions 'sco.ca.gov':", lower.includes("sco.ca.gov"));
      // Print any lines mentioning safe deposit or auction for direct context
      const relevantLines = text.split("\n").filter((l) => /safe deposit|auction/i.test(l)).slice(0, 15);
      console.log("relevant lines:\n" + relevantLines.join("\n"));
    } catch (err) {
      console.log(`\n=== ${url} ===\nERROR: ${err}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
