const ready = new WeakSet();
const pending = new WeakMap();

/** Additive, once per database binding; legacy databases remain readable during rollout. */
export async function ensureDynamicProbeSchema(db) {
  if (ready.has(db)) return;
  if (pending.has(db)) return pending.get(db);
  const operation = (async () => {
    for (const [table, column, definition] of [
      ['servers', 'probe_selection', "TEXT DEFAULT ''"],
      ['metrics_history', 'probe_results', "TEXT DEFAULT '{}'"],
      ['metrics_history_old', 'probe_results', "TEXT DEFAULT '{}'"],
    ]) {
      const { results = [] } = await db.prepare(`PRAGMA table_info(${table})`).all();
      if (!results.length || results.some(entry => entry.name === column)) continue;
      try { await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run(); }
      catch (error) { if (!/duplicate column/i.test(error.message)) throw error; }
    }
    ready.add(db);
  })();
  pending.set(db, operation);
  try { await operation; } finally { pending.delete(db); }
}
