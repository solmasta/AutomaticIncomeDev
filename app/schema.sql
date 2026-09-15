-- D1 schema for the unclaimed-money finder.
-- Re-run safe: CREATE TABLE IF NOT EXISTS everywhere.

CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_row_id TEXT,               -- stable id from the source file, if one exists
  owner_name TEXT NOT NULL,
  owner_name_normalized TEXT NOT NULL,  -- upper-cased, punctuation-stripped, for matching
  city TEXT,
  state TEXT NOT NULL DEFAULT 'CA',
  holder_name TEXT,                 -- who is holding the money (bank, employer, etc.)
  property_type TEXT,
  cash_reported REAL,
  reported_date TEXT,               -- when the property was reported to the state
  last_synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_properties_name_norm ON properties(owner_name_normalized);
CREATE INDEX IF NOT EXISTS idx_properties_state ON properties(state);

CREATE TABLE IF NOT EXISTS watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  notified_at TEXT   -- set by the weekly watchlist-sweep agent once a match is emailed; NULL = still watching
);

CREATE INDEX IF NOT EXISTS idx_watchlist_name_norm ON watchlist(name_normalized);

-- Populated by the state-coverage research agent (and seeded once from this
-- session's manual recon) -- the /states directory renders from this table
-- instead of a hardcoded list, so newly-researched states show up
-- automatically without a code change.
CREATE TABLE IF NOT EXISTS state_coverage (
  state TEXT PRIMARY KEY,              -- two-letter code, e.g. 'CA', or 'DC'
  state_name TEXT NOT NULL,
  cash_search_type TEXT NOT NULL DEFAULT 'unchecked',
    -- 'bulk_download' | 'live_form_open' | 'captcha_blocked' | 'bot_detected' | 'js_app_unknown' | 'unchecked'
  cash_search_url TEXT,                -- the state's own official search/download page
  cash_search_notes TEXT,
  auction_vendor_verified INTEGER NOT NULL DEFAULT 0,
  auction_vendor_url TEXT,             -- official safe-deposit-box/tangible-property auction page, if any
  auction_notes TEXT,
  last_checked_at TEXT,
  checked_by TEXT NOT NULL DEFAULT 'manual',  -- 'agent' | 'manual'
  confidence TEXT                      -- brief note on how sure the agent is, for a human to sanity-check
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  property_id INTEGER REFERENCES properties(id),
  message TEXT,
  stripe_session_id TEXT,
  paid INTEGER NOT NULL DEFAULT 0,   -- flipped to 1 by the Stripe webhook on successful checkout
  paid_at TEXT,
  filed_at TEXT,                    -- set manually once you've actually filed the claim; NULL = still refundable per policy
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
