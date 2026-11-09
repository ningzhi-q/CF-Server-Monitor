import { patchServerLocationCaches } from './cache.js';

export const AUTO_LOCATION_HEADER = 'X-CFSM-Internal-Auto-Location';
export const AUTO_LOCATION_IP_HEADER = 'X-CFSM-Internal-Location-IP';
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
  const subdivision = value.subdivision_source === 'db-ip' && typeof value.subdivision === 'string' &&
    value.subdivision.trim() && value.subdivision.length <= 160 && !/[\x00-\x1f]/.test(value.subdivision) ? value.subdivision.trim() : null;
  return { latitude, longitude, country, city: city?.trim() || null, source, observed_at,
    ...(value.city_source === 'db-ip' ? { city_source: 'db-ip' } : {}),
    ...(subdivision ? { subdivision, subdivision_source: 'db-ip' } : {}) };
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
  headers.delete(AUTO_LOCATION_IP_HEADER);
  headers.delete('cf-ipcountry');
  if (typeof cf?.country === 'string' && /^[A-Z]{2}$/.test(cf.country)) headers.set('cf-ipcountry', cf.country);
  const location = locationFromCf(cf);
  if (location) headers.set(AUTO_LOCATION_HEADER, JSON.stringify(location));
  const ip = normalizeLocationIp(headers.get('cf-connecting-ip'));
  if (ip) headers.set(AUTO_LOCATION_IP_HEADER, ip);
}

export function normalizeLocationIp(value) {
  if (typeof value !== 'string' || value.length > 45) return null;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(value) && value.split('.').every(part => Number(part) <= 255)) return value;
  if (value.includes(':') && /^[0-9a-f:]+$/i.test(value)) {
    try { new URL(`https://[${value}]/`); return value; } catch { return null; }
  }
  return null;
}

// Only fill absent/coarse Hong Kong city names. Never use a different country,
// a region name as a city, or replace Cloudflare's approximate coordinates.
export async function refineAutoLocation(input, ip, fetcher = fetch) {
  const location = normalizeAutoLocation(input);
  const address = normalizeLocationIp(ip);
  if (!location || !address || (location.city && !(location.country === 'HK' && /^(hong kong|香港)$/i.test(location.city)))) return location;
  try {
    const response = await fetcher(`https://api.db-ip.com/v2/free/${encodeURIComponent(address)}`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return location;
    const body = await response.text();
    if (body.length > 4096) return location;
    const data = JSON.parse(body);
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.ipAddress !== address || data.countryCode !== location.country ||
        typeof data.city !== 'string' || !data.city.trim()) return location;
    if (/^(hong kong|香港)$/i.test(data.city.trim())) {
      // HK districts/areas are not independent cities. Preserve the original city
      // and expose the provider's narrower administrative reference separately.
      if (location.country !== 'HK' || typeof data.stateProv !== 'string' || /^(hong kong|香港)$/i.test(data.stateProv.trim())) return location;
      return normalizeAutoLocation({ ...location, subdivision: data.stateProv, subdivision_source: 'db-ip' }) || location;
    }
    return normalizeAutoLocation({ ...location, city: data.city.trim(), city_source: 'db-ip' }) || location;
  } catch { return location; }
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
    a.country === b.country && a.city === b.city && a.city_source === b.city_source && a.subdivision === b.subdivision;
}

// Call only after authentication, server lookup and metric payload validation.
// A bounded, database-owned cache deduplicates reports. Failure never rejects metrics.
export async function saveAutoLocation(db, server, input, now = Date.now(), options = {}) {
  let location = normalizeAutoLocation(input);
  if (!location) return null;
  location.observed_at = now;
  let state = databaseStates.get(db);
  if (!state) { state = { schema: null, entries: new Map() }; databaseStates.set(db, state); }
  let entry = state.entries.get(server.id);
  if (!entry) {
    entry = { saved: parseAutoLocation(server.auto_location), retryAt: 0, pending: null, lookup: null };
    state.entries.set(server.id, entry);
    while (state.entries.size > MAX_ENTRIES) state.entries.delete(state.entries.keys().next().value);
  }
  if (entry.pending) await entry.pending;
  const ip = normalizeLocationIp(options.ip);
  if (ip && (!location.city || (location.country === 'HK' && /^(hong kong|香港)$/i.test(location.city)))) {
    const key = JSON.stringify([ip, location.country, location.city, location.latitude, location.longitude]);
    if (entry.lookup?.key !== key || now >= entry.lookup.expiresAt) {
      // Promise is installed before awaiting, deduplicating concurrent reports.
      entry.lookup = { key, expiresAt: now + REFRESH_MS, result: refineAutoLocation(location, ip, options.fetcher) };
    }
    location = { ...await entry.lookup.result, observed_at: now };
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
