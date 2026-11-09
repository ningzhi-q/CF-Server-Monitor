import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { locationFromCf, normalizeAutoLocation, normalizeLocationIp, refineAutoLocation, parseAutoLocation, saveAutoLocation, setTrustedLocationHeaders, AUTO_LOCATION_HEADER, AUTO_LOCATION_IP_HEADER } from '../src/utils/autoLocation.js';
import { toBroadcastSamples, handleUpdate } from '../src/handlers/update.js';
import { getAllServers, getServerDetail, clearAllCaches } from '../src/utils/cache.js';
import { getWorkerLatestReportUpdates } from '../src/utils/latestReportCache.js';
import { handleServerAPI, handleServersAPI } from '../src/handlers/dashboard.js';
import { initDatabase } from '../src/database/schema.js';
import { MetricsBroadcaster } from '../src/durable/MetricsBroadcaster.js';

const cf = { country: 'JP', city: 'Tokyo', latitude: '35.68', longitude: '139.69' };
const now = 1794140000000;
const place = locationFromCf(cf, now);

test('provider failure diagnostics expose no reporter IP, body or error text', async t => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  const coarse = locationFromCf({ country: 'HK', city: 'Hong Kong', latitude: '22.3', longitude: '114.1' }, now);
  const ip = '192.0.2.7';
  for (const fetcher of [async () => new Response('private-body', { status: 429 }), async () => { throw Error(`private-error ${ip}`); }]) {
    assert.deepEqual(await refineAutoLocation(coarse, ip, fetcher), coarse);
  }
  assert.deepEqual(warnings, [
    ['[auto-location] Lookup deferred:', 'HK', 'HTTP 429'],
    ['[auto-location] Lookup deferred:', 'HK', 'request or response failed']
  ]);
  assert.equal(JSON.stringify(warnings).includes(ip), false);
  assert.equal(JSON.stringify(warnings).includes('private-'), false);
});

test('city refinement validates provider IP/country/city and preserves coordinate ownership', async () => {
  const coarse = locationFromCf({ country: 'HK', city: 'Hong Kong', latitude: '22.27832', longitude: '114.17469' }, now);
  const ip = '192.0.2.1';
  const result = { ipAddress: ip, countryCode: 'HK', city: 'Kwun Tong' };
  let calls = 0;
  const fetcher = async (url, options) => { calls++; assert.equal(url, 'https://api.db-ip.com/v2/free/192.0.2.1'); assert.ok(options.signal); return Response.json(result); };
  assert.deepEqual(await refineAutoLocation(coarse, ip, fetcher), { ...coarse, city: 'Kwun Tong', city_source: 'db-ip' });
  assert.deepEqual(await refineAutoLocation(place, ip, fetcher), place);
  assert.equal(calls, 1, 'specific Cloudflare city is never queried or overwritten');
  assert.deepEqual(await refineAutoLocation(coarse, ip, async () => Response.json({ ...result, city: 'Hong Kong', stateProv: 'Kowloon' })), { ...coarse, subdivision: 'Kowloon', subdivision_source: 'db-ip' });
  for (const bad of [{ ...result, ipAddress: '192.0.2.2' }, { ...result, countryCode: 'US' }, { ...result, city: 'Hong Kong' }, { ...result, city: '' }, { ...result, city: ['Kwun Tong'] }, { ...result, city: 'a'.repeat(161) }, { ...result, city: 'a\ncity' }, null]) {
    assert.deepEqual(await refineAutoLocation(coarse, ip, async () => Response.json(bad)), coarse);
  }
  for (const failed of [async () => new Response('', { status: 429 }), async () => { throw Error('timeout'); }, async () => new Response('{bad')]) {
    assert.deepEqual(await refineAutoLocation(coarse, ip, failed), coarse);
  }
  for (const badIp of ['', '256.1.1.1', '../settings', '192.0.2.1?x=1', '[::1]', '::::']) assert.equal(normalizeLocationIp(badIp), null);
  assert.equal(normalizeLocationIp('2001:db8::1'), '2001:db8::1');
});

test('coarse city lookups are cached per database, refreshed daily and on IP change', async () => {
  const db = { prepare() { return { bind() { return this; }, async all() { return { results: [{ name: 'auto_location' }] }; }, async run() { return { success: true }; } }; } };
  const coarse = locationFromCf({ country: 'HK', city: 'Hong Kong', latitude: '22.27832', longitude: '114.17469' }, now);
  const server = { id: 'refinement' };
  let calls = 0;
  const options = { ip: '192.0.2.1', fetcher: async url => { calls++; return Response.json({ ipAddress: decodeURIComponent(url.split('/').at(-1)), countryCode: 'HK', city: 'Kwun Tong' }); } };
  const results = await Promise.all([saveAutoLocation(db, server, coarse, now, options), saveAutoLocation(db, server, coarse, now + 1, options)]);
  assert.equal(calls, 1);
  assert.ok(results.every(value => value.city === 'Kwun Tong'));
  assert.equal(JSON.stringify(server).includes('192.0.2.1'), false, 'IP never persists in server DTO');
  await saveAutoLocation(db, server, coarse, now + 2, options);
  assert.equal(calls, 1);
  await saveAutoLocation(db, server, coarse, now + 24 * 60 * 60 * 1000 + 1, options);
  assert.equal(calls, 2);
  await saveAutoLocation(db, server, coarse, now + 24 * 60 * 60 * 1000 + 2, { ...options, ip: '192.0.2.2' });
  assert.equal(calls, 3);
});

test('Singapore area refinement preserves the city-state and original coordinates', async () => {
  const coarse = locationFromCf({ country: 'SG', city: 'Singapore', latitude: '1.28967', longitude: '103.85007' }, now);
  const ip = '192.0.2.3';
  const answer = { ipAddress: ip, countryCode: 'SG', city: 'Singapore (Tampines)' };
  assert.deepEqual(await refineAutoLocation(coarse, ip, async () => Response.json(answer)), {
    ...coarse, subdivision: 'Tampines', subdivision_source: 'db-ip'
  });
  assert.deepEqual(await refineAutoLocation(coarse, ip, async () => Response.json({ ...answer, city: 'Singapore' })), coarse);
  const specific = { ...coarse, city: 'Kampong Loyang' };
  assert.deepEqual(await refineAutoLocation(specific, ip, async () => { throw Error('must not query a specific city'); }), specific);
  for (const stateProv of ['a'.repeat(161), 'bad\narea']) {
    const hk = { ...coarse, country: 'HK', city: 'Hong Kong' };
    assert.deepEqual(await refineAutoLocation(hk, ip, async () => Response.json({ ipAddress: ip, countryCode: 'HK', city: 'Hong Kong', stateProv })), hk);
  }
});

test('provider failure retries after a minute, retains same-IP detail, and never carries it across IP changes', async () => {
  const db = { prepare() { return { bind() { return this; }, async all() { return { results: [{ name: 'auto_location' }] }; }, async run() { return { success: true }; } }; } };
  const coarse = locationFromCf({ country: 'SG', city: 'Singapore', latitude: '1.28967', longitude: '103.85007' }, now);
  const server = { id: 'retry-area' };
  let calls = 0, fail = true;
  const options = { ip: '192.0.2.3', fetcher: async url => {
    calls++;
    if (fail) throw Error('timeout');
    return Response.json({ ipAddress: url.split('/').at(-1), countryCode: 'SG', city: 'Singapore (Tampines)' });
  } };
  assert.equal((await saveAutoLocation(db, server, coarse, now, options)).subdivision, undefined);
  await saveAutoLocation(db, server, coarse, now + 59999, options);
  assert.equal(calls, 1);
  fail = false;
  assert.equal((await saveAutoLocation(db, server, coarse, now + 60000, options)).subdivision, 'Tampines');
  assert.equal(calls, 2);
  const refreshedAt = now + 60000 + 24 * 60 * 60 * 1000;
  fail = true;
  assert.equal((await saveAutoLocation(db, server, coarse, refreshedAt, options)).subdivision, 'Tampines');
  assert.equal(calls, 3);
  assert.equal((await saveAutoLocation(db, server, coarse, refreshedAt + 1, { ...options, ip: '192.0.2.4' })).subdivision, undefined);
  assert.equal(calls, 4);
  assert.equal(JSON.stringify(server).includes('192.0.2.'), false);
});

test('a valid provider answer without a finer locality remains cached for a day', async () => {
  const db = { prepare() { return { bind() { return this; }, async all() { return { results: [{ name: 'auto_location' }] }; }, async run() { return { success: true }; } }; } };
  const coarse = locationFromCf({ country: 'SG', city: 'Singapore', latitude: '1.28967', longitude: '103.85007' }, now);
  let calls = 0;
  const options = { ip: '192.0.2.3', fetcher: async () => { calls++; return Response.json({ ipAddress: '192.0.2.3', countryCode: 'SG', city: 'Singapore' }); } };
  const server = { id: 'no-finer-area' };
  await saveAutoLocation(db, server, coarse, now, options);
  await saveAutoLocation(db, server, coarse, now + 60001, options);
  assert.equal(calls, 1);
});

test('Cloudflare data is validated without guessing absent coordinates or cities', () => {
  assert.equal(place.city, 'Tokyo');
  assert.equal(locationFromCf({ ...cf, city: undefined }, now).city, null);
  for (const invalid of [{}, { ...cf, latitude: '' }, { ...cf, latitude: null }, { ...cf, latitude: '91' }, { ...cf, longitude: Infinity }, { ...cf, latitude: '0', longitude: '0' }, { ...cf, country: 'XX' }, { ...cf, city: ['Tokyo'] }]) {
    assert.equal(locationFromCf(invalid, now), null);
  }
  assert.equal(normalizeAutoLocation({ ...place, observed_at: -1 }), null);
  assert.equal(parseAutoLocation('{invalid'), null);
});

test('the public Worker replaces forged headers and strips all body locations from broadcast samples', () => {
  const headers = new Headers({ [AUTO_LOCATION_HEADER]: JSON.stringify({ ...place, country: 'US' }), [AUTO_LOCATION_IP_HEADER]: '192.0.2.99', 'cf-connecting-ip': '192.0.2.1', 'cf-ipcountry': 'US' });
  setTrustedLocationHeaders(headers, cf);
  assert.equal(parseAutoLocation(headers.get(AUTO_LOCATION_HEADER)).country, 'JP');
  assert.equal(headers.get(AUTO_LOCATION_IP_HEADER), '192.0.2.1');
  const samples = [0, 1].map(i => ({ ts: now + i, metrics: { cpu: 10, location: { ...place, country: 'US' }, auto_location: 'fake' } }));
  const broadcast = toBroadcastSamples('node', samples, 'JP', '', null, place);
  assert.equal(broadcast[0].payload.location, undefined);
  assert.deepEqual(broadcast[1].payload.location, place);
  assert.equal(broadcast[1].payload.auto_location, undefined);
  assert.equal(samples[0].metrics.auto_location, 'fake', 'input is not mutated');
  setTrustedLocationHeaders(headers, {});
  assert.equal(headers.has(AUTO_LOCATION_HEADER), false);
  assert.equal(headers.has('cf-ipcountry'), false);
});

test('real SQL adds only the location column, updates caches and deduplicates repeated reports per database', async t => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', compatibilityDate: '2024-12-01', d1Databases: ['DB', 'OTHER'] });
  t.after(() => mf.dispose());
  const DB = await mf.getD1Database('DB');
  const OTHER = await mf.getD1Database('OTHER');
  for (const db of [DB, OTHER]) {
    await db.prepare("CREATE TABLE servers (id TEXT PRIMARY KEY, region TEXT, tags TEXT, sort_order INTEGER)").run();
    await db.prepare("INSERT INTO servers VALUES ('node','JP','production',1)").run();
  }
  let updates = 0;
  const tracked = { prepare(sql) { if (sql.startsWith('UPDATE servers')) updates++; return DB.prepare(sql); } };
  await clearAllCaches();
  await getAllServers(tracked);
  const server = await getServerDetail(tracked, 'node', true);
  await saveAutoLocation(tracked, server, place, now);
  await saveAutoLocation(tracked, server, place, now + 1000);
  assert.equal(updates, 1);
  assert.equal(parseAutoLocation((await getAllServers(tracked))[0].auto_location).city, 'Tokyo');
  assert.equal(parseAutoLocation((await getServerDetail(tracked, 'node', true)).auto_location).country, 'JP');
  await saveAutoLocation(tracked, server, { ...place, city: 'Osaka', latitude: 34.69, longitude: 135.5 }, now + 2000);
  assert.equal(updates, 2);
  assert.equal(parseAutoLocation((await DB.prepare("SELECT * FROM servers").first()).auto_location).city, 'Osaka');
  await saveAutoLocation(tracked, server, place, now + 24 * 60 * 60 * 1000 + 1);
  assert.equal(updates, 3);
  await saveAutoLocation(OTHER, { id: 'node' }, place, now);
  assert.equal(parseAutoLocation((await OTHER.prepare("SELECT * FROM servers").first()).auto_location).city, 'Tokyo');
  const row = await DB.prepare('SELECT * FROM servers').first();
  assert.equal(row.tags, 'production');
  assert.equal(row.region, 'JP');
  assert.deepEqual((await DB.prepare('PRAGMA table_info(servers)').all()).results.map(c => c.name), ['id','region','tags','sort_order','auto_location']);
});

test('database failure preserves reporting and backs off before retrying persistence', async () => {
  let attempts = 0;
  let fail = true;
  const db = { prepare(sql) {
    return { bind() { return this; }, async all() { return { results: [{ name: 'auto_location' }] }; }, async run() { attempts++; if (fail) throw Error('temporary failure'); return { success: true }; } };
  } };
  const server = { id: 'failure-node' };
  assert.equal((await saveAutoLocation(db, server, place, now)).city, 'Tokyo');
  await saveAutoLocation(db, server, place, now + 10);
  assert.equal(attempts, 1);
  fail = false;
  await saveAutoLocation(db, server, place, now + 60001);
  assert.equal(attempts, 2);
  assert.equal(parseAutoLocation(server.auto_location).city, 'Tokyo');
});

test('HTTP reporting persists trusted metadata only after authentication and usable metrics', async t => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', compatibilityDate: '2024-12-01', d1Databases: ['DB'] });
  t.after(() => mf.dispose());
  const DB = await mf.getD1Database('DB');
  await clearAllCaches();
  await initDatabase(DB);
  await DB.prepare("INSERT INTO servers (id, name, history_partition_id) VALUES ('http-geo-node','Test',1)").run();
  let lookups = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    lookups++;
    assert.equal(url, 'https://api.db-ip.com/v2/free/192.0.2.1');
    assert.ok(options.signal);
    return Response.json({ ipAddress: '192.0.2.1', countryCode: 'HK', city: 'Kwun Tong' });
  });
  const coarseCf = { country: 'HK', city: 'Hong Kong', latitude: '22.27832', longitude: '114.17469' };
  const tasks = [];
  const request = (secret, metrics) => {
    const req = new Request('https://example.com/update', { method: 'POST', headers: { 'cf-connecting-ip': '192.0.2.1' }, body: JSON.stringify({ id: 'http-geo-node', secret, metrics }) });
    Object.defineProperty(req, 'cf', { value: coarseCf });
    return req;
  };
  const env = { DB, API_SECRET: 'test-secret' }, ctx = { waitUntil(p) { tasks.push(p); } };
  assert.equal((await handleUpdate(request('bad', { cpu: 10 }), env, ctx)).status, 401);
  assert.equal((await handleUpdate(request('test-secret', null), env, ctx)).status, 400);
  assert.equal((await DB.prepare("SELECT auto_location FROM servers").first()).auto_location, null);
  assert.equal(lookups, 0, 'unauthenticated or invalid reports never query a provider');
  assert.equal((await handleUpdate(request('test-secret', { cpu: 10, location: { ...place, country: 'US' } }), env, ctx)).status, 200);
  await Promise.allSettled(tasks);
  assert.equal(parseAutoLocation((await DB.prepare('SELECT auto_location FROM servers').first()).auto_location).city, 'Kwun Tong');
  assert.equal(lookups, 1);
  assert.equal(getWorkerLatestReportUpdates(['http-geo-node'])[0].samples.at(-1).payload.location.country, 'HK');
  const sys = { is_public: 'true' };
  const detail = await (await handleServerAPI(new Request('https://example.com/api/server?id=http-geo-node'), env, sys)).json();
  const list = await (await handleServersAPI(new Request('https://example.com/api/servers'), env, sys)).json();
  assert.equal(detail.location.city, 'Kwun Tong');
  assert.equal(detail.location.city_source, 'db-ip');
  assert.equal(detail.location.latitude, Number(coarseCf.latitude));
  assert.equal(JSON.stringify(detail).includes('192.0.2.1'), false);
  assert.deepEqual(list.servers[0].location, detail.location);
  assert.equal('auto_location' in detail, false);
  assert.equal('auto_location' in list.servers[0], false);
});

test('WebSocket reporting uses the authenticated attachment rather than client-supplied location', async t => {
  let lookups = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    lookups++;
    assert.equal(url, 'https://api.db-ip.com/v2/free/192.0.2.2');
    return Response.json({ ipAddress: '192.0.2.2', countryCode: 'HK', city: 'Hong Kong', stateProv: 'Kowloon' });
  });
  const coarse = locationFromCf({ country: 'HK', city: 'Hong Kong', latitude: '22.27832', longitude: '114.17469' }, now);
  globalThis.WebSocketRequestResponsePair = class { constructor() {} };
  const env = { DB: { prepare() { return { bind() { return this; }, async all() { return { results: [{ name: 'auto_location' }] }; }, async run() { return { success: true }; } }; } } };
  const doInstance = new MetricsBroadcaster({ setWebSocketAutoResponse() {}, getWebSockets() { return []; }, storage: { async get() { return null; }, async put() {} } }, env);
  const socket = { send() {}, serializeAttachment() {} };
  doInstance._resolveAgentContext = async () => ({ serverId: 'ws-node', serverDetail: { id: 'ws-node' }, attachment: { autoLocation: coarse, locationIp: '192.0.2.2' }, regionCode: 'HK', agentVersion: '' });
  doInstance._getAgentRealtimeState = () => ({ realtimeActive: false });
  let payload;
  doInstance._cacheLatestReportUpdates = updates => { payload = updates[0].samples.at(-1).payload; };
  doInstance._persistAgentHistoryIfDue = async () => ({ persisted: true });
  doInstance._buildAgentConfigAck = async () => null;
  doInstance._getAgentNextWssReportAfterMs = () => 2000;
  // Auth and payload handling are kept intact; only unrelated persistence/broadcast transport is replaced.
  await doInstance._handleAgentReportMessage(socket, JSON.stringify({ id: 'ws-node', metrics: { cpu: 10, location: { ...place, country: 'US' } } }), {});
  assert.equal(lookups, 1);
  assert.equal(payload.location.country, 'HK');
  assert.equal(payload.location.city, 'Hong Kong');
  assert.equal(payload.location.subdivision, 'Kowloon');
  assert.equal(payload.location.subdivision_source, 'db-ip');
  assert.equal(payload.location.latitude, coarse.latitude);
  assert.equal(JSON.stringify(payload).includes('192.0.2.2'), false);
});

test('legacy coarse WebSocket attachments reconnect after their report is acknowledged without looping new connections', async () => {
  globalThis.WebSocketRequestResponsePair = class { constructor() {} };
  const env = { DB: { prepare() { return { bind() { return this; }, async all() { return { results: [{ name: 'auto_location' }] }; }, async run() { return { success: true }; } }; } } };
  const instance = new MetricsBroadcaster({ setWebSocketAutoResponse() {}, getWebSockets() { return []; }, storage: { async get() { return null; }, async put() {} } }, env);
  instance._getAgentRealtimeState = () => ({ realtimeActive: false });
  instance._cacheLatestReportUpdates = () => {};
  instance._persistAgentHistoryIfDue = async () => ({ persisted: true });
  instance._buildAgentConfigAck = async () => null;
  instance._getAgentNextWssReportAfterMs = () => 2000;
  for (const [country, city, ipField, shouldReconnect] of [
    ['HK', 'Hong Kong', {}, true], ['SG', 'Singapore', {}, true],
    ['HK', 'Hong Kong', { locationIp: null }, false], ['JP', 'Tokyo', {}, false]
  ]) {
    const events = [];
    const attachment = { autoLocation: locationFromCf({ country, city, latitude: '22.3', longitude: '114.1' }, now), ...ipField };
    instance._resolveAgentContext = async () => ({ serverId: 'legacy-node', serverDetail: { id: 'legacy-node' }, attachment, regionCode: country, agentVersion: '' });
    const socket = { send(message) { events.push(JSON.parse(message).type); }, serializeAttachment() {}, close(code) { events.push(code); } };
    await instance._handleAgentReportMessage(socket, JSON.stringify({ id: 'legacy-node', metrics: { cpu: 10 } }), {});
    assert.deepEqual(events, shouldReconnect ? ['ack', 1012] : ['ack']);
  }
});
