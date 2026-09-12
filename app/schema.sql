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

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  property_id INTEGER REFERENCES properties(id),
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
