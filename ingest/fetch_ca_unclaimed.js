#!/usr/bin/env node
// Downloads California's official public unclaimed-property bulk file and
// turns it into D1-ready SQL batches. Zero npm dependencies on purpose so it
// runs anywhere with Node 18+ and (on Linux) the `unzip` binary.
//
// Run this somewhere with real internet access — a sandboxed dev container
// may block sco.ca.gov outright. GitHub Actions works fine (see the
// .github/workflows/refresh-ca-data.yml job that runs this weekly).
//
// Usage:
//   node ingest/fetch_ca_unclaimed.js
// Env overrides:
//   DOWNLOAD_PAGE_URL   default: https://sco.ca.gov/upd_download_property_records.html
//   CSV_URL_OVERRIDE    skip auto-discovery and use this URL directly
//   MIN_CASH            default: 500 (only keep properties worth pursuing)
//   OUTPUT_DIR          default: ingest/output
//   BATCH_SIZE          default: 100 rows per single INSERT statement (D1's
//                       per-statement size limit rejected 1000; 100 confirmed OK)
//   STATEMENTS_PER_FILE default: 50 statements bundled per SQL file, so each
//                       `wrangler d1 execute` CLI invocation applies many
//                       statements at once instead of one process per batch

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import path from "node:path";

const DOWNLOAD_PAGE_URL =
  process.env.DOWNLOAD_PAGE_URL || "https://sco.ca.gov/upd_download_property_records.html";
const MIN_CASH = Number(process.env.MIN_CASH || 500);
// Defaults assume this script runs with its own directory (ingest/) as the
// cwd -- true both when run locally as `node fetch_ca_unclaimed.js` from
// inside ingest/, and in the GitHub Actions workflow, which sets
// working-directory: ingest for this step. Don't re-prefix "ingest" here.
const OUTPUT_DIR = process.env.OUTPUT_DIR || "output";
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 300);
const TMP_DIR = "tmp";

async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": "unclaimed-money-finder-ingest/1.0" } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

/** Find candidate CSV/ZIP download links on the SCO page and score them. */
function discoverCsvUrl(html, pageUrl) {
  const anchorRe = /<a[^>]+href="([^"]+\.(?:csv|zip))"[^>]*>(.*?)<\/a>/gis;
  const candidates = [];
  let m;
  while ((m = anchorRe.exec(html))) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, " ");
    candidates.push({ url: new URL(href, pageUrl).toString(), text });
  }
  if (candidates.length === 0) return null;

  const score = (c) => {
    const s = (c.text + " " + c.url).toLowerCase();
    let points = 0;
    if (s.includes("500")) points += 5;
    if (s.includes("all propert")) points += 1; // fallback, lowest preference
    if (s.includes("9.99") || s.includes("499")) points -= 5; // low-value buckets
    return points;
  };
  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0].url;
}

async function download(url, destPath) {
  const res = await fetch(url, { headers: { "user-agent": "unclaimed-money-finder-ingest/1.0" } });
  if (!res.ok || !res.body) throw new Error(`Download failed: ${url} -> ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
}

async function findCsv(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const found = await findCsv(full);
      if (found) return found;
    } else if (e.name.toLowerCase().endsWith(".csv")) {
      return full;
    }
  }
  return null;
}

/** Minimal RFC4180-ish line parser: handles quoted fields with embedded delimiters/quotes. */
function parseDelimitedLine(line, delimiter) {
  const fields = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields.map((f) => f.trim());
}

/** CA's public bulk file turned out to be pipe-delimited NAUPA-standard export with NO
 * header row (discovered against the real 04_From_500_To_Beyond.zip file) -- confirmed
 * by inspecting an actual data row: fixed field positions below, verified against it.
 * Comma-delimited-with-header files (an older assumption, kept as a fallback in case a
 * future refresh reverts format) are still auto-detected and handled the old way. */
function detectDelimiter(line) {
  // A literal pipe character essentially never shows up in ordinary name/address
  // text, so "any pipes at all" is a far more reliable signal than comparing
  // raw pipe vs. comma counts -- a comma-containing address ("123 MAIN ST, APT 2")
  // could otherwise outnumber pipes on an actually-pipe-delimited line and cause
  // a misdetection that silently scrambles every field for the whole file.
  return line.includes("|") ? "|" : ",";
}

const NAUPA_FIXED_FIELDS = {
  sourceRowId: 0,
  propertyType: 1,
  cashReported: 2,
  ownerName: 6,
  city: 10,
  holderName: 17,
  // No report/void date is exposed in this public extract at all -- reportedDate is
  // left null for NAUPA-format rows. See README for what that means for the
  // solicitation-wait-period gate.
};

function looksLikeHeaderRow(fields) {
  const joined = fields.join(" ").toLowerCase();
  return joined.includes("owner") && joined.includes("name");
}

function buildHeaderMap(headers) {
  const lower = headers.map((h) => h.toLowerCase());
  const find = (...needles) => lower.findIndex((h) => needles.every((n) => h.includes(n)));
  return {
    ownerName: find("owner", "name") >= 0 ? find("owner", "name") : find("name"),
    city: find("city"),
    holderName: find("holder"),
    propertyType: find("property", "type") >= 0 ? find("property", "type") : find("type"),
    cashReported: find("cash") >= 0 ? find("cash") : find("amount"),
    reportedDate: find("report", "date"),
  };
}

function normalizeName(name) {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sqlEscape(v) {
  if (v === null || v === undefined || v === "") return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function main() {
  await mkdir(TMP_DIR, { recursive: true });
  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await mkdir(OUTPUT_DIR, { recursive: true });

  let csvUrl = process.env.CSV_URL_OVERRIDE;
  if (!csvUrl) {
    console.log(`Discovering CSV link on ${DOWNLOAD_PAGE_URL} ...`);
    const html = await fetchText(DOWNLOAD_PAGE_URL);
    csvUrl = discoverCsvUrl(html, DOWNLOAD_PAGE_URL);
    if (!csvUrl) {
      throw new Error(
        "Could not find a CSV/ZIP link on the download page. " +
          "The page layout may have changed — inspect it manually and set CSV_URL_OVERRIDE."
      );
    }
  }
  console.log(`Using source file: ${csvUrl}`);

  const downloadPath = path.join(TMP_DIR, path.basename(new URL(csvUrl).pathname) || "data.download");
  await download(csvUrl, downloadPath);

  let csvPath = downloadPath;
  if (downloadPath.toLowerCase().endsWith(".zip")) {
    const extractDir = path.join(TMP_DIR, "extracted");
    await mkdir(extractDir, { recursive: true });
    execFileSync("unzip", ["-o", downloadPath, "-d", extractDir]);
    csvPath = await findCsv(extractDir);
    if (!csvPath) throw new Error("No .csv found inside the downloaded zip.");
  }

  const rl = createInterface({ input: createReadStream(csvPath, { encoding: "utf8" }) });
  let headerMap = null;
  let delimiter = null;
  let fixedFormat = false;
  let batch = [];
  let batchIndex = 0;
  let totalKept = 0;
  let totalSeen = 0;

  // Two-level batching: each INSERT statement holds STATEMENT_ROWS rows (kept
  // well under D1's per-statement size limit -- 1000 rows tripped SQLITE_TOOBIG,
  // 100 is confirmed safe against the real schema/data), but many statements
  // get bundled into one file so `wrangler d1 execute` processes them in a
  // single CLI invocation. At 100 rows/statement and one invocation per file,
  // importing CA's full ~760k-row $500+ file would mean ~7,600 separate
  // `wrangler` process launches (each with real CLI-startup + network
  // overhead) -- realistically hours. Bundling STATEMENTS_PER_FILE statements
  // per file cuts that to ~STATEMENTS_PER_FILE-times fewer invocations.
  const STATEMENT_ROWS = BATCH_SIZE;
  const STATEMENTS_PER_FILE = Number(process.env.STATEMENTS_PER_FILE || 50);
  let fileStatements = [];

  const buildStatement = (rows) => {
    const values = rows
      .map(
        (r) =>
          `(${sqlEscape(r.ownerName)}, ${sqlEscape(normalizeName(r.ownerName))}, ${sqlEscape(r.city)}, 'CA', ${sqlEscape(r.holderName)}, ${sqlEscape(r.propertyType)}, ${r.cashReported}, ${sqlEscape(r.reportedDate)})`
      )
      .join(",\n  ");
    return `INSERT INTO properties (owner_name, owner_name_normalized, city, state, holder_name, property_type, cash_reported, reported_date)\nVALUES\n  ${values};\n`;
  };

  const flushFile = async () => {
    if (fileStatements.length === 0) return;
    const fileName = path.join(OUTPUT_DIR, `${String(batchIndex).padStart(5, "0")}_ca_batch.sql`);
    await writeFile(fileName, fileStatements.join("\n"), "utf8");
    batchIndex++;
    fileStatements = [];
  };

  const flushBatch = async () => {
    if (batch.length > 0) {
      fileStatements.push(buildStatement(batch));
      batch = [];
    }
    if (fileStatements.length >= STATEMENTS_PER_FILE) await flushFile();
  };

  // First batch resets CA rows so the weekly sync doesn't accumulate stale duplicates.
  await writeFile(path.join(OUTPUT_DIR, "00000_reset_ca.sql"), `DELETE FROM properties WHERE state = 'CA';\n`, "utf8");
  batchIndex = 1;

  for await (const rawLine of rl) {
    if (!rawLine) continue;

    if (delimiter === null) {
      delimiter = detectDelimiter(rawLine);
      const firstFields = parseDelimitedLine(rawLine, delimiter);
      if (looksLikeHeaderRow(firstFields)) {
        headerMap = buildHeaderMap(firstFields);
        if (headerMap.ownerName < 0) {
          throw new Error(
            `Header row detected but no owner-name column found: ${firstFields.join(" | ")}. ` +
              "Update buildHeaderMap() to match the real column name."
          );
        }
        continue; // consumed as the header row, not a data row
      }
      // No header row -- this file is the fixed-position NAUPA format, and this
      // first line is already a data row, so fall through and parse it below.
      fixedFormat = true;
    }

    const fields = parseDelimitedLine(rawLine, delimiter);
    totalSeen++;

    let ownerName, city, holderName, propertyType, cashReported, reportedDate;
    if (fixedFormat) {
      ownerName = fields[NAUPA_FIXED_FIELDS.ownerName];
      city = fields[NAUPA_FIXED_FIELDS.city] || "";
      holderName = fields[NAUPA_FIXED_FIELDS.holderName] || "";
      propertyType = fields[NAUPA_FIXED_FIELDS.propertyType] || "";
      cashReported = Number(String(fields[NAUPA_FIXED_FIELDS.cashReported] || "").replace(/[^0-9.]/g, "")) || 0;
      reportedDate = ""; // not present in this public extract
    } else {
      ownerName = fields[headerMap.ownerName];
      city = headerMap.city >= 0 ? fields[headerMap.city] : "";
      holderName = headerMap.holderName >= 0 ? fields[headerMap.holderName] : "";
      propertyType = headerMap.propertyType >= 0 ? fields[headerMap.propertyType] : "";
      cashReported = Number(String(headerMap.cashReported >= 0 ? fields[headerMap.cashReported] : "").replace(/[^0-9.]/g, "")) || 0;
      reportedDate = headerMap.reportedDate >= 0 ? fields[headerMap.reportedDate] : "";
    }

    if (!ownerName || cashReported < MIN_CASH) continue;

    // Some real owner names strip down to nothing once normalized (e.g. purely
    // punctuation/non-Latin text) -- owner_name_normalized is NOT NULL in the
    // schema, and such a record wouldn't be findable by name search anyway, so
    // skip it rather than let sqlEscape("") silently emit a literal NULL and
    // blow up the whole batch's INSERT on a constraint violation.
    if (!normalizeName(ownerName)) continue;

    if (totalKept === 0) {
      // Print the first real row that will actually be imported so a human can
      // eyeball it in the Actions log and confirm fields landed in the right
      // places before trusting the rest of the run.
      console.log(
        `Format detected: ${fixedFormat ? "fixed-position NAUPA" : "header-based CSV"}, delimiter ${JSON.stringify(delimiter)}.\n` +
          `Sample parsed row -> owner: ${JSON.stringify(ownerName)}, city: ${JSON.stringify(city)}, ` +
          `holder: ${JSON.stringify(holderName)}, cash: ${cashReported}, type: ${JSON.stringify(propertyType)}`
      );
    }

    batch.push({ ownerName, city, holderName, propertyType, cashReported, reportedDate });
    totalKept++;
    if (batch.length >= STATEMENT_ROWS) await flushBatch();
  }
  await flushBatch(); // pushes any partial trailing statement into fileStatements
  await flushFile(); // writes any partial trailing file (< STATEMENTS_PER_FILE statements)

  console.log(`Done. Scanned ${totalSeen} rows, kept ${totalKept} at >= $${MIN_CASH}.`);
  console.log(`Wrote ${batchIndex - 1} SQL batch file(s) to ${OUTPUT_DIR}/ (${STATEMENT_ROWS} rows/statement, up to ${STATEMENTS_PER_FILE} statements/file).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
