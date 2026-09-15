#!/usr/bin/env node
// Before building a 50-state directory, verify the actual NAUPA/MissingMoney
// URLs rather than guessing them -- this sandbox can't reach unclaimed.org
// directly (network egress blocked), so run this from GitHub Actions where
// it can. Prints enough of the real page content to confirm what these URLs
// actually do and whether they're safe to link 44+ states to in one place.

async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; research-bot/1.0)" }, redirect: "follow" });
  return { status: res.status, finalUrl: res.url, text: await res.text() };
}

async function main() {
  for (const url of ["https://unclaimed.org/search/", "https://unclaimed.org/", "https://www.missingmoney.com/"]) {
    try {
      const { status, finalUrl, text } = await fetchText(url);
      console.log(`\n=== ${url} ===`);
      console.log("status:", status, "finalUrl:", finalUrl, "bytes:", text.length);
      console.log(text.slice(0, 3000));
    } catch (err) {
      console.log(`\n=== ${url} ===\nERROR: ${err}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
