import { patchServerLocationCaches } from './cache.js';

export const AUTO_LOCATION_HEADER = 'X-CFSM-Internal-Auto-Location';
const REFRESH_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const MAX_ENTRIES = 5000;
const databaseStates = new WeakMap();

// This DTO contains an IP geolocation reference, never the reporter's IP address.
export function normalizeAutoLocation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { latitude, longitude, country, city, source, observed_at } = value;
  if (source !== 'cloudflare-ip' || typeof country !== 'string' ||
      !/^[A-Z]{2}$/.test(country) || ['XX', 'T1'].includes(country) ||
      typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
      typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180 ||
      (latitude === 0 && longitude === 0) ||
      typeof observed_at !== 'number' || !Number.isSafeInteger(observed_at) || observed_at <= 0 ||
      (city !== null && city !== undefined && (typeof city !== 'string' || city.length > 160 || /[\x00-\x1f]/.test(city)))) return null;
  return { latitude, longitude, country, city: city?.trim() || null, source, observed_at };
}

export function parseAutoLocation(value) {
  if (typeof value !== 'string' || value.length > 1024) return null;
  try { return normalizeAutoLocation(JSON.parse(value)); } catch { return null; }
}

export function locationFromCf(cf, now = Date.now()) {
  if (!cf || typeof cf !== 'object') return null;
  const coordinate = value => (typeof value === 'number' ||
    (typeof value === 'string' && value.trim() !== '' && /^-?\d+(\.\d+)?$/.test(value.trim())))
    ? Number(value) : NaN;
  return normalizeAutoLocation({
    latitude: coordinate(cf.latitude), longitude: coordinate(cf.longitude),
    country: typeof cf.country === 'string' ? cf.country.toUpperCase() : null,
    city: cf.city ?? null, source: 'cloudflare-ip', observed_at: now
  });
}

// Always replace user-supplied headers at the public Worker boundary.
export function setTrustedLocationHeaders(headers, cf) {
  headers.delete(AUTO_LOCATION_HEADER);
  headers.delete('cf-ipcountry');
  if (typeof cf?.country === 'string' && /^[A-Z]{2}$/.test(cf.country)) headers.set('cf-ipcountry', cf.country);
  const location = locationFromCf(cf);
  if (location) headers.set(AUTO_LOCATION_HEADER, JSON.stringify(location));
}

async function ensureColumn(db, state) {
  if (!state.schema) state.schema = (async () => {
    const { results } = await db.prepare('PRAGMA table_info(servers)').all();
    if (results.some(column => column.name === 'auto_location')) return;
    try { await db.prepare('ALTER TABLE servers ADD COLUMN auto_location TEXT').run(); }
    catch (error) {
      const columns = await db.prepare('PRAGMA table_info(servers)').all();
      if (!columns.results.some(column => column.name === 'auto_location')) throw error;
    }
  })().catch(error => { state.schema = null; throw error; });
  await state.schema;
}

function samePlace(a, b) {
  return a && b && a.latitude === b.latitude && a.longitude === b.longitude &&
    a.country === b.country && a.city === b.city;
}

// Call only after authentication, server lookup and metric payload validation.
// A bounded, database-owned cache deduplicates reports. Failure never rejects metrics.
export async function saveAutoLocation(db, server, input, now = Date.now()) {
  const location = normalizeAutoLocation(input);
  if (!location) return null;
  location.observed_at = now;
  let state = databaseStates.get(db);
  if (!state) { state = { schema: null, entries: new Map() }; databaseStates.set(db, state); }
  let entry = state.entries.get(server.id);
  if (!entry) {
    entry = { saved: parseAutoLocation(server.auto_location), retryAt: 0, pending: null };
    state.entries.set(server.id, entry);
    while (state.entries.size > MAX_ENTRIES) state.entries.delete(state.entries.keys().next().value);
  }
  if (entry.pending) await entry.pending;
  if (samePlace(entry.saved, location) && now - entry.saved.observed_at < REFRESH_MS) return entry.saved;
  if (now < entry.retryAt) return location;
  entry.pending = (async () => {
    try {
      await ensureColumn(db, state);
      const serialized = JSON.stringify(location);
      await db.prepare('UPDATE servers SET auto_location = ? WHERE id = ?').bind(serialized, server.id).run();
      entry.saved = location;
      entry.retryAt = 0;
      server.auto_location = serialized;
      patchServerLocationCaches(db, server.id, serialized);
    } catch (error) {
      entry.retryAt = now + RETRY_MS;
      console.warn('[auto-location] Save deferred:', error?.message || 'database error');
    }
  })();
  await entry.pending;
  entry.pending = null;
  return entry.saved && samePlace(entry.saved, location) ? entry.saved : location;
}
