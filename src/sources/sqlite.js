// Read-only access to agents that store sessions in SQLite, via Node's built-in
// node:sqlite (Node 22.5+). On older Nodes these agents are skipped.
let mod;

async function load() {
  if (mod !== undefined) return mod;
  const emit = process.emitWarning;
  process.emitWarning = () => {}; // hide the "SQLite is experimental" warning on some Node versions
  try {
    mod = await import('node:sqlite');
  } catch {
    mod = null;
  } finally {
    process.emitWarning = emit;
  }
  return mod;
}

const open = new Map();

/** Returns a cached read-only DatabaseSync, or null if unavailable. */
export async function openDb(path) {
  if (open.has(path)) return open.get(path);
  const m = await load();
  let db = null;
  if (m) {
    try {
      db = new m.DatabaseSync(path, { readOnly: true });
    } catch (e) {
      if (process.env.DEBUG) process.stderr.write(`can't open ${path}: ${e.message}\n`);
    }
  } else if (process.env.DEBUG) process.stderr.write(`node:sqlite unavailable; skipping ${path}\n`);
  open.set(path, db);
  return db;
}

export function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

export function parseJson(s) {
  if (s == null) return null;
  if (typeof s !== 'string') s = Buffer.from(s).toString('utf8');
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
