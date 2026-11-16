import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeploymentCatalog } from '../scripts/activate-dynamic-ping.mjs';

test('migrates six actual IPv4 endpoints and their verified IPv6 counterparts', async () => {
  const fields = ['custom_ct', 'custom_cu', 'custom_cm', 'custom_bd', 'node_1', 'node_2'];
  const hosts = ['bj-ct', 'bj-cu', 'bj-cm', 'hl-ct', 'hl-cu', 'hl-cm'];
  const settings = Object.fromEntries(fields.flatMap((f, i) => [[f, `${hosts[i]}-v4.ip.zstaticcdn.com:80`], [`${f}_name`, `ISP ${i}`]]));
  const catalog = await buildDeploymentCatalog(settings, async (host, family) => host.includes(`-v${family}.`) ? ['resolved'] : []);
  assert.deepEqual(catalog.groups.map(g => [g.family, g.targets.length]), [['ipv4', 6], ['ipv6', 6]]);
  assert.equal(new Set(catalog.groups.flatMap(g => g.targets.map(t => t.id))).size, 12);
  assert.ok(catalog.groups[1].targets.every(t => t.address.endsWith('-v6.ip.zstaticcdn.com:80')));
});

test('preserves existing user groups and an intentionally disabled target', async () => {
  const catalog = { enabled: false, groups: [{ id: 'g_mine', name: '我的组', family: 'ipv4', targets: [{ id: 'p_mine', name: '我的地址', address: '1.1.1.1:443', enabled: false }] }] };
  assert.deepEqual(await buildDeploymentCatalog({ probe_catalog: catalog }), { ...catalog, enabled: true });
});

test('does not add an IPv6 endpoint without an AAAA record and rejects unresolved originals', async () => {
  const settings = { custom_ct: 'bj-ct-v4.ip.zstaticcdn.com:80' };
  const catalog = await buildDeploymentCatalog(settings, async (host, family) => host.includes('-v4.') && family === 4 ? ['resolved'] : []);
  assert.equal(catalog.groups.length, 1);
  assert.equal(catalog.groups[0].targets.length, 1);
  await assert.rejects(buildDeploymentCatalog(settings, async () => []), /无法解析/);
});

test('classifies IP literals without DNS and keeps dual stack hostnames in the common group', async () => {
  const catalog = await buildDeploymentCatalog({ custom_ct: '1.1.1.1:443', custom_cu: '[2606:4700:4700::1111]:443', custom_cm: 'example.com:443' }, async () => ['resolved']);
  assert.deepEqual(catalog.groups.map(g => g.family), ['ipv4', 'ipv6', 'auto']);
});


test('fills the existing IPv6 group without changing user IDs and is idempotent', async () => {
  const original = { enabled: true, groups: [
    { id: 'g_my_v4', name: 'ipv4', family: 'ipv4', targets: [
      { id: 'p_my_ct', name: '北京电信', address: 'bj-ct-v4.ip.zstaticcdn.com:80', enabled: true },
      { id: 'p_my_cu', name: '北京联通', address: 'bj-cu-v4.ip.zstaticcdn.com:80', enabled: false },
    ] },
    { id: 'g_my_v6', name: 'ipv6', family: 'ipv6', targets: [] },
  ] };
  const lookup = async (host, family) => host.includes('-v6.') && family === 6 ? ['resolved'] : [];
  const result = await buildDeploymentCatalog({ probe_catalog: original }, lookup);
  assert.deepEqual(result.groups[0], original.groups[0]);
  assert.equal(original.groups[1].targets.length, 0);
  assert.equal(result.groups[1].id, 'g_my_v6');
  assert.deepEqual(result.groups[1].targets.map(t => [t.name, t.enabled]), [['北京电信', true], ['北京联通', false]]);
  assert.deepEqual(await buildDeploymentCatalog({ probe_catalog: result }, lookup), result);
});

test('never duplicates an existing disabled IPv6 target', async () => {
  const original = { enabled: true, groups: [
    { id: 'g_v4', name: 'ipv4', family: 'ipv4', targets: [{ id: 'p_ct', name: 'ct', address: 'bj-ct-v4.ip.zstaticcdn.com:80', enabled: true }] },
    { id: 'g_v6', name: 'ipv6', family: 'ipv6', targets: [{ id: 'p_ct6', name: '自定义', address: 'bj-ct-v6.ip.zstaticcdn.com:80', enabled: false }] },
  ] };
  assert.deepEqual(await buildDeploymentCatalog({ probe_catalog: original }, async () => ['resolved']), original);
});
