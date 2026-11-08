import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { locationFromCf, normalizeAutoLocation, parseAutoLocation, saveAutoLocation, setTrustedLocationHeaders, AUTO_LOCATION_HEADER } from '../src/utils/autoLocation.js';
import { toBroadcastSamples, handleUpdate } from '../src/handlers/update.js';
import { getAllServers, getServerDetail, clearAllCaches } from '../src/utils/cache.js';
import { getWorkerLatestReportUpdates } from '../src/utils/latestReportCache.js';
import { handleServerAPI, handleServersAPI } from '../src/handlers/dashboard.js';
import { initDatabase } from '../src/database/schema.js';
import { MetricsBroadcaster } from '../src/durable/MetricsBroadcaster.js';

const cf = { country: 'JP', city: 'Tokyo', latitude: '35.68', longitude: '139.69' };
const now = 1794140000000;
const place = locationFromCf(cf, now);

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
  const headers = new Headers({ [AUTO_LOCATION_HEADER]: JSON.stringify({ ...place, country: 'US' }), 'cf-ipcountry': 'US' });
  setTrustedLocationHeaders(headers, cf);
  assert.equal(parseAutoLocation(headers.get(AUTO_LOCATION_HEADER)).country, 'JP');
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
  const tasks = [];
  const request = (secret, metrics) => {
    const req = new Request('https://example.com/update', { method: 'POST', body: JSON.stringify({ id: 'http-geo-node', secret, metrics }) });
    Object.defineProperty(req, 'cf', { value: cf });
    return req;
  };
  const env = { DB, API_SECRET: 'test-secret' }, ctx = { waitUntil(p) { tasks.push(p); } };
  assert.equal((await handleUpdate(request('bad', { cpu: 10 }), env, ctx)).status, 401);
  assert.equal((await handleUpdate(request('test-secret', null), env, ctx)).status, 400);
  assert.equal((await DB.prepare("SELECT auto_location FROM servers").first()).auto_location, null);
  assert.equal((await handleUpdate(request('test-secret', { cpu: 10, location: { ...place, country: 'US' } }), env, ctx)).status, 200);
  await Promise.allSettled(tasks);
  assert.equal(parseAutoLocation((await DB.prepare('SELECT auto_location FROM servers').first()).auto_location).city, 'Tokyo');
  assert.equal(getWorkerLatestReportUpdates(['http-geo-node'])[0].samples.at(-1).payload.location.country, 'JP');
  const sys = { is_public: 'true' };
  const detail = await (await handleServerAPI(new Request('https://example.com/api/server?id=http-geo-node'), env, sys)).json();
  const list = await (await handleServersAPI(new Request('https://example.com/api/servers'), env, sys)).json();
  assert.equal(detail.location.city, 'Tokyo');
  assert.deepEqual(list.servers[0].location, detail.location);
  assert.equal('auto_location' in detail, false);
  assert.equal('auto_location' in list.servers[0], false);
});

test('WebSocket reporting uses the authenticated attachment rather than client-supplied location', async () => {
  globalThis.WebSocketRequestResponsePair = class { constructor() {} };
  const env = { DB: { prepare() { return { bind() { return this; }, async all() { return { results: [{ name: 'auto_location' }] }; }, async run() { return { success: true }; } }; } } };
  const doInstance = new MetricsBroadcaster({ setWebSocketAutoResponse() {}, getWebSockets() { return []; }, storage: { async get() { return null; }, async put() {} } }, env);
  const socket = { send() {}, serializeAttachment() {} };
  doInstance._resolveAgentContext = async () => ({ serverId: 'ws-node', serverDetail: { id: 'ws-node' }, attachment: { autoLocation: place }, regionCode: 'JP', agentVersion: '' });
  doInstance._getAgentRealtimeState = () => ({ realtimeActive: false });
  let payload;
  doInstance._cacheLatestReportUpdates = updates => { payload = updates[0].samples.at(-1).payload; };
  doInstance._persistAgentHistoryIfDue = async () => ({ persisted: true });
  doInstance._buildAgentConfigAck = async () => null;
  doInstance._getAgentNextWssReportAfterMs = () => 2000;
  // Auth and payload handling are kept intact; only unrelated persistence/broadcast transport is replaced.
  await doInstance._handleAgentReportMessage(socket, JSON.stringify({ id: 'ws-node', metrics: { cpu: 10, location: { ...place, country: 'US' } } }), {});
  assert.equal(payload.location.country, 'JP');
});
