#!/usr/bin/env node
// Follow-up recon on NY: the landing page fetch showed a plain GET /search
// form with no CAPTCHA markers -- the most promising signal found across
// candidate states. This goes one level deeper: extract that form's actual
// input field names, then fire a real test query to see whether the *result*
// page (not just the landing page) is genuinely open or gated some other way
// (session requirement, soft rate-limit, JS-rendered results, etc).

async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; research-bot/1.0)" } });
  return { status: res.status, finalUrl: res.url, text: await res.text(), headers: Object.fromEntries(res.headers) };
}

function extractFormBlock(html, actionMatch) {
  const idx = html.indexOf(`action="${actionMatch}"`);
  if (idx === -1) return null;
  const formStart = html.lastIndexOf("<form", idx);
  const formEnd = html.indexOf("</form>", idx);
  if (formStart === -1 || formEnd === -1) return null;
  return html.slice(formStart, formEnd + "</form>".length);
}

function extractInputs(formHtml) {
  const inputs = [];
  const re = /<input[^>]*>/gi;
  let m;
  while ((m = re.exec(formHtml))) {
    const tag = m[0];
    const name = /name="([^"]*)"/i.exec(tag)?.[1];
    const type = /type="([^"]*)"/i.exec(tag)?.[1] || "text";
    if (name) inputs.push({ name, type });
  }
  const selectRe = /<select[^>]*name="([^"]*)"/gi;
  while ((m = selectRe.exec(formHtml))) inputs.push({ name: m[1], type: "select" });
  return inputs;
}

async function main() {
  const landing = await fetchText("https://www.osc.ny.gov/unclaimed-funds");
  const searchForm = extractFormBlock(landing.text, "/search");
  console.log("=== /search form block ===");
  console.log(searchForm ? searchForm.slice(0, 2000) : "NOT FOUND");
  const inputs = searchForm ? extractInputs(searchForm) : [];
  console.log("\n=== Extracted input fields ===");
  console.log(JSON.stringify(inputs, null, 2));

  // Try a real test query using the most plausible field name for a last name.
  const nameField = inputs.find((i) => /name|search|q\b/i.test(i.name)) || inputs[0];
  if (nameField) {
    const testUrl = `https://www.osc.ny.gov/search?${encodeURIComponent(nameField.name)}=SMITH`;
    console.log(`\n=== Test query: ${testUrl} ===`);
    const result = await fetchText(testUrl);
    console.log("status:", result.status);
    console.log("finalUrl:", result.finalUrl);
    console.log("bytes:", result.text.length);
    const lower = result.text.toLowerCase();
    console.log("mentions recaptcha/captcha:", /recaptcha|captcha/.test(lower));
    console.log("mentions 'smith' in response:", lower.includes("smith"));
    console.log("first 1500 chars of response:\n", result.text.slice(0, 1500));
  } else {
    console.log("No usable input field found to construct a test query.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
