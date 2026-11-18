import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { compileScript, parse } from '@vue/compiler-sfc';
import { Miniflare } from 'miniflare';
import * as billing from '../src/frontend/utils/server.js';
import { PING_NODE_FIELDS, validatePingNode } from '../src/frontend/utils/pingNode.js';
import { handleAdminAPI } from '../src/handlers/admin.js';
import { generateToken } from '../src/middleware/auth.js';
import { initDatabase } from '../src/database/schema.js';
import { normalizeProbeCatalog, normalizeProbeSelection, selectProbeTargets, publicProbeCatalog, normalizeProbeResults } from '../src/shared/probes.js';
import { buildAgentConfig, serializeAgentConfig, describeAgentConfig } from '../src/utils/agentConfig.js';
import { ensureDynamicProbeSchema } from '../src/database/dynamicProbes.js';
import { getDashboardLatencyHistory } from '../src/database/schema.js';
import { createHistoryTableSql } from '../src/utils/historyFields.js';
import { buildHistoryId } from '../src/database/indexOptimization.js';
import { normalizeProbeMetricRow, mergeMetricsIntoServer } from '../src/utils/metrics.js';

const catalog = { enabled: true, groups: ['ipv4', 'ipv6', 'auto'].map((family, index) => ({
  id: `g_${index}`, name: family, family,
  targets: Array.from({ length: 6 }, (_, n) => ({ id: `p_${index}_${n}`, name: `线路 ${n}`, address: family === 'ipv6' ? '[2606:4700:4700::1111]:443' : '1.1.1.1:443', enabled: true }))
})) };

test('catalog exceeds eight targets, preserves IDs across edits and omits private addresses publicly', () => {
  const normalized = normalizeProbeCatalog(catalog);
  assert.equal(normalized.groups.flatMap(g => g.targets).length, 18);
  const edited = structuredClone(normalized);
  edited.groups[0].targets.splice(1, 1);
  edited.groups[0].targets[0].name = '改名';
  assert.equal(normalizeProbeCatalog(edited).groups[0].targets[0].id, 'p_0_0');
  assert.equal(JSON.stringify(publicProbeCatalog(normalized)).includes('address'), false);
  assert.throws(() => normalizeProbeCatalog({ ...catalog, groups: [catalog.groups[0], catalog.groups[0]] }));
  for (const address of ['999.1.1.1', 'https://host', 'host:65536', '-invalid.host']) {
    const invalid = structuredClone(catalog); invalid.groups[0].targets[0].address = address;
    assert.throws(() => normalizeProbeCatalog(invalid), address);
  }
  const mismatch = structuredClone(catalog); mismatch.groups[0].targets[0].address = '[::1]';
  assert.throws(() => normalizeProbeCatalog(mismatch));
});

test('IPv4 / IPv6 / dual stack automatic selection and explicit manual selection', () => {
  const automatic = normalizeProbeSelection();
  for (const [v4, v6, families] of [['1', '0', ['ipv4', 'auto']], ['0', '1', ['ipv6', 'auto']], ['1', '1', ['ipv4', 'ipv6', 'auto']], ['0', '0', []], ['192.0.2.1', '0', ['ipv4', 'auto']], ['0', '2001:db8::1', ['ipv6', 'auto']], ['192.0.2.1', '2001:db8::1', ['ipv4', 'ipv6', 'auto']], ['2001:db8::1', '192.0.2.1', []]]) {
    assert.deepEqual([...new Set(selectProbeTargets(catalog, automatic, v4, v6).map(t => t.family))], families);
  }
  assert.deepEqual(selectProbeTargets(catalog, { mode: 'manual', targets: [] }, '1', '1'), []);
  assert.deepEqual(selectProbeTargets(catalog, { mode: 'manual', targets: ['p_1_0'] }, '1', '0').map(t => t.id), ['p_1_0']);
  const disabled = structuredClone(catalog); disabled.groups[1].targets[0].enabled = false;
  assert.deepEqual(selectProbeTargets(disabled, { mode: 'manual', targets: ['p_1_0'] }, '1', '1'), []);
});

test('schema 8 transports dynamic configuration while schema 3–7 preserves existing addresses', () => {
  for (let schema = 3; schema <= 7; schema++) {
    const config = buildAgentConfig({ custom_ct: '1.1.1.1' }, { probe_catalog: catalog }, schema);
    assert.equal(config.custom_ct, '1.1.1.1'); assert.equal('probe_catalog' in config, false);
  }
  const config = buildAgentConfig({}, { probe_catalog: catalog }, 8);
  assert.equal(config.custom_ct, '0'); assert.equal(config.node_4, '0');
  const encoded = new URLSearchParams(serializeAgentConfig(config));
  assert.deepEqual(JSON.parse(encoded.get('probe_catalog')), catalog);
  assert.deepEqual(JSON.parse(encoded.get('probe_selection')), { mode: 'auto', targets: [] });
});

test('dynamic samples retain zero / null / false and replace a deleted snapshot', () => {
  const probes = { p_zero: { ts: 1000, latency: 0, loss: 0 }, p_timeout: { ts: 1000, latency: null, loss: 100 }, p_off: { ts: 1000, latency: false, loss: false } };
  assert.deepEqual(normalizeProbeMetricRow({ probe_results: JSON.stringify(probes) }).probes, probes);
  const server = { probes }; mergeMetricsIntoServer(server, { probes: {} });
  assert.deepEqual(server.probes, {});
  assert.deepEqual(normalizeProbeResults({ bad: probes.p_zero, p_bad: { ts: '1000' } }), {});
});

test('additive D1 migration is idempotent and real dynamic history includes more than eight probes', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: { DB: 'dynamic-probes-test' } });
  try {
    const db = await mf.getD1Database('DB');
    await db.prepare('CREATE TABLE servers (id TEXT PRIMARY KEY)').run();
    await db.prepare('CREATE TABLE metrics_history_old (id INTEGER PRIMARY KEY)').run();
    await db.prepare(createHistoryTableSql('metrics_history')).run();
    await Promise.all([ensureDynamicProbeSchema(db), ensureDynamicProbeSchema(db)]);
    assert((await db.prepare('PRAGMA table_info(servers)').all()).results.some(c => c.name === 'probe_selection'));
    assert((await db.prepare('PRAGMA table_info(metrics_history_old)').all()).results.some(c => c.name === 'probe_results'));
    const ts = Date.UTC(2026, 10, 16, 0, 1, 30);
    const probes = Object.fromEntries(catalog.groups.flatMap(g => g.targets).map((t, i) => [t.id, { ts, latency: i, loss: 0 }]));
    probes.p_timeout = { ts, latency: null, loss: 100 };
    probes.p_stale = { ts: ts - 121000, latency: 3, loss: 0 };
    await db.prepare('INSERT INTO metrics_history (id, server_id, timestamp, probe_results) VALUES (?, ?, ?, ?)').bind(buildHistoryId(1, ts), 'server', ts, JSON.stringify(probes)).run();
    const windows = await getDashboardLatencyHistory(db, [{ id: 'server', history_partition_id: 1, timestamp: ts }], { now: ts + 60000, cache: false });
    const window = windows.get('server');
    const point = window.ping.find(p => 'p_0_0' in p);
    assert(point); assert.equal(point.p_0_0, 0); assert.equal(point.p_timeout, null);
    assert.equal('p_stale' in point, false);
    assert.equal(Object.keys(point).filter(k => k.startsWith('p_')).length, 19);
  } finally { await mf.dispose(); }
});


test('auto update defaults on, explicit off is sent and changes config MD5', async () => {
 const on = await describeAgentConfig({});
 const off = await describeAgentConfig({auto_update: '0'});
 assert.match(on.serialized, /&update=1(?:&|$)/);
 assert.match(off.serialized, /&update=0(?:&|$)/);
 assert.notEqual(on.md5, off.md5);
 const legacy = await describeAgentConfig({}, null, 7);
 assert.doesNotMatch(legacy.serialized, /&update=/);
});

// Execute the modal's production submit path: testing only the batch payload helper
// missed that the single-server save path omitted probe_selection entirely.
const adminSource = readFileSync(new URL('../src/frontend/views/admin/index.vue', import.meta.url), 'utf8');
const { descriptor } = parse(adminSource);
const { scriptSetupAst } = compileScript(descriptor, { id: 'probe-save-regression' });
const saveDeclarations = [
  'getPingNodeValidation', 'normalizeTrafficAlertPercentField',
  'createEditFormFromServer', 'buildEditPayloadFromForm', 'saveEdit'
].map(name => {
  const declaration = scriptSetupAst.find(node => node.type === 'VariableDeclaration'
    && node.declarations.some(item => item.id.name === name));
  assert.ok(declaration, `Missing production declaration: ${name}`);
  return descriptor.scriptSetup.content.slice(declaration.start, declaration.end);
}).join('\n');

test('single-server modal persists probe choices through authenticated D1 save, reopen and Agent config', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: { DB: 'probe-save-test' } });
  try {
    const db = await mf.getD1Database('DB');
    await initDatabase(db);
    const id = '00000000-0000-4000-8000-000000000001';
    await db.prepare('INSERT INTO servers (id, name) VALUES (?, ?)').bind(id, 'Probe save test').run();
    const env = { DB: db };
    const sys = { jwt_secret: randomBytes(32).toString('hex') };
    const token = await generateToken(env, sys);
    let reload;
    const context = {
      ...billing, PING_NODE_FIELDS, validatePingNode,
      editForm: { value: {} }, validationError: { value: null },
      saveResult: { value: null }, showEditModal: { value: true },
      trans: { value: { serverEdited: 'saved' } },
      getEffectiveConnectionMode: value => value || 'auto',
      buildPingNodeError: field => field, getMessage: value => value,
      cancelAutoUpdateWarning() {},
      loadServers() { reload = db.prepare('SELECT * FROM servers WHERE id = ?').bind(id).first(); },
      async adminApiForSite(payload) {
        const response = await handleAdminAPI(new Request('https://example.test/api/admin', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload)
        }), env, sys);
        const data = await response.json();
        return response.ok ? { data } : { error: data.error };
      }
    };
    const runtime = runInNewContext(`${saveDeclarations}\n({ saveEdit, createEditFormFromServer })`, context);
    let stored = await db.prepare('SELECT * FROM servers WHERE id = ?').bind(id).first();
    for (const choice of [
      { mode: 'manual', targets: ['p_1_0', 'p_1_1'] },
      { mode: 'manual', targets: [] },
      { mode: 'auto', targets: [] }
    ]) {
      context.editForm.value = runtime.createEditFormFromServer({ ...stored, ip_v4: '1', ip_v6: '1' });
      context.editForm.value.probe_selection = choice;
      context.showEditModal.value = true;
      await runtime.saveEdit();
      assert.equal(context.saveResult.value.success, true);
      assert.equal(context.showEditModal.value, false);
      stored = await reload;
      assert.deepEqual(normalizeProbeSelection(stored.probe_selection), choice);
      const reopened = runtime.createEditFormFromServer(stored);
      assert.deepEqual(normalizeProbeSelection(reopened.probe_selection), choice);
      const config = buildAgentConfig(stored, { probe_catalog: catalog }, 8);
      const encoded = new URLSearchParams(serializeAgentConfig(config));
      assert.deepEqual(JSON.parse(encoded.get('probe_selection')), choice);
      assert.deepEqual(selectProbeTargets(catalog, config.probe_selection, '1', '1').map(target => target.id),
        choice.mode === 'manual' ? choice.targets : catalog.groups.flatMap(group => group.targets.map(target => target.id)));
    }
    // A rejected save must retain the edited draft and leave stored choices intact.
    context.editForm.value.probe_selection = { mode: 'invalid', targets: [] };
    context.showEditModal.value = true;
    await runtime.saveEdit();
    assert.equal(context.saveResult.value.success, false);
    assert.equal(context.showEditModal.value, true);
    assert.equal(context.editForm.value.probe_selection.mode, 'invalid');
    stored = await db.prepare('SELECT * FROM servers WHERE id = ?').bind(id).first();
    assert.deepEqual(normalizeProbeSelection(stored.probe_selection), { mode: 'auto', targets: [] });
  } finally { await mf.dispose(); }
});
