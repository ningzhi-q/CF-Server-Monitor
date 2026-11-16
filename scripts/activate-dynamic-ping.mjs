import { createHash } from 'node:crypto';
import { resolve4, resolve6 } from 'node:dns/promises';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { normalizeProbeCatalog } from '../src/shared/probes.js';
import { PING_NODE_FIELDS, validatePingNode } from '../src/frontend/utils/pingNode.js';

const THEME_URL = 'https://github.com/ningzhi-q/CFSM-Glassmorphism/tree/theme-v1.2.1';
const resolve = async (host, family) => {
  try { return await (family === 4 ? resolve4(host) : resolve6(host)); }
  catch { return []; }
};

function hostOf(address) {
  return address.startsWith('[') ? address.slice(1, address.indexOf(']')) : address.split(':')[0];
}

export async function buildDeploymentCatalog(settings, lookup = resolve) {
  const existing = normalizeProbeCatalog(settings.probe_catalog);
  if (existing.groups.length) {
    const groups = structuredClone(existing.groups);
    const addresses = new Set(groups.flatMap(g => g.targets.map(t => t.address.toLowerCase())));
    let ipv6Group = groups.find(g => g.family === 'ipv6');
    for (const group of groups.filter(g => g.family === 'ipv4')) {
      for (const target of group.targets) {
        const host = hostOf(target.address);
        if (!/^[a-z0-9-]+-v4\.ip\.zstaticcdn\.com$/i.test(host)) continue;
        const address = target.address.replace(/-v4\.ip\.zstaticcdn\.com/i, '-v6.ip.zstaticcdn.com');
        if (addresses.has(address.toLowerCase()) || !(await lookup(hostOf(address), 6)).length) continue;
        if (!ipv6Group) {
          const usedIds = new Set(groups.map(g => g.id));
          let id = 'g_ipv6_deployment';
          while (usedIds.has(id)) id += '_x';
          ipv6Group = { id, name: 'IPv6', family: 'ipv6', targets: [] };
          groups.push(ipv6Group);
        }
        const digest = createHash('sha256').update(target.id + ':' + address).digest('hex').slice(0, 24);
        const id = `p_ipv6_${digest}`;
        if (groups.some(g => g.targets.some(t => t.id === id))) throw new Error('新增探测地址 ID 与现有配置冲突，未修改线上设置');
        ipv6Group.targets.push({ id, name: target.name, address, enabled: target.enabled });
        addresses.add(address.toLowerCase());
      }
    }
    return normalizeProbeCatalog({ enabled: true, groups });
  }
  const groups = new Map([
    ['ipv4', { id: 'g_ipv4', name: 'IPv4', family: 'ipv4', targets: [] }],
    ['ipv6', { id: 'g_ipv6', name: 'IPv6', family: 'ipv6', targets: [] }],
    ['auto', { id: 'g_common', name: '通用', family: 'auto', targets: [] }],
  ]);
  const addresses = new Set();
  const add = (field, name, address, family) => {
    if (addresses.has(address)) return;
    addresses.add(address);
    groups.get(family).targets.push({ id: `p_${field}_${family}`, name, address, enabled: true });
  };
  for (const field of PING_NODE_FIELDS) {
    const result = validatePingNode(settings[field]);
    if (!result.valid) throw new Error(`现有 ${field} 地址无效，未修改线上设置`);
    if (!result.value || result.value === '0') continue;
    const address = result.value;
    const host = hostOf(address);
    const name = String(settings[`${field}_name`] || field);
    const literal = isIP(host);
    const [v4, v6] = literal ? [literal === 4, literal === 6]
      : await Promise.all([lookup(host, 4).then(a => a.length > 0), lookup(host, 6).then(a => a.length > 0)]);
    if (!v4 && !v6) throw new Error(`现有 ${field} 地址无法解析，未修改线上设置`);
    add(field, name, address, v4 && v6 ? 'auto' : v4 ? 'ipv4' : 'ipv6');
    // Only add an ISP's matching IPv6 endpoint after confirming its AAAA record.
    if (/^[a-z0-9-]+-v4\.ip\.zstaticcdn\.com$/i.test(host)) {
      const ipv6Address = address.replace('-v4.ip.zstaticcdn.com', '-v6.ip.zstaticcdn.com');
      if ((await lookup(hostOf(ipv6Address), 6)).length) add(field, name, ipv6Address, 'ipv6');
    }
  }
  const catalog = normalizeProbeCatalog({ enabled: true, groups: [...groups.values()].filter(g => g.targets.length) });
  if (!catalog.groups.length) throw new Error('没有可迁移的实际探测地址，未修改线上设置');
  return catalog;
}

async function main() {
  const { CF_API_TOKEN, CF_ACCOUNT_ID, D1_DATABASE_ID } = process.env;
  if (!CF_API_TOKEN || !CF_ACCOUNT_ID || !D1_DATABASE_ID) throw new Error('缺少现有部署凭据');
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`;
  const query = async (sql, params = []) => {
    const response = await fetch(endpoint, {
      method: 'POST', headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }), signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json();
    if (!response.ok || !data.success || data.result.some(r => !r.success)) {
      throw new Error(`D1 操作失败，HTTP ${response.status}`);
    }
    return data.result[0];
  };
  // Read only fields needed for this deployment; credentials never enter results or artifacts.
  const fields = ['theme_url', 'probe_catalog', ...PING_NODE_FIELDS.flatMap(f => [f, `${f}_name`])];
  const select = `SELECT ${fields.map(f => `json_extract(value, '$.${f}') AS ${f}`).join(', ')} FROM settings WHERE key = 'site_options'`;
  const settings = (await query(select)).results[0];
  if (!settings) throw new Error('未找到现有站点配置');
  const legacy = (await query(`SELECT key, value FROM settings WHERE key IN (${PING_NODE_FIELDS.flatMap(f => [f, `${f}_name`]).map(() => '?').join(',')})`, PING_NODE_FIELDS.flatMap(f => [f, `${f}_name`]))).results;
  for (const row of legacy) if (settings[row.key] === null) settings[row.key] = row.value;
  const catalog = await buildDeploymentCatalog(settings);
  const plan = { theme_url: THEME_URL, probe_catalog: catalog };
  console.log(JSON.stringify({ mode: process.argv.includes('--apply') ? 'apply' : 'audit', ...plan }, null, 2));
  if (!process.argv.includes('--apply')) return;
  const updated = await query("UPDATE settings SET value = json_set(value, '$.theme_url', ?, '$.probe_catalog', json(?)) WHERE key = 'site_options' AND json_extract(value, '$.theme_url') IS ? AND json_extract(value, '$.probe_catalog') IS ?", [THEME_URL, JSON.stringify(catalog), settings.theme_url, settings.probe_catalog]);
  if (updated.meta.changes !== 1) throw new Error('配置已被其他操作修改，本次未覆盖');
  const verified = (await query(select)).results[0];
  if (verified.theme_url !== THEME_URL || JSON.stringify(normalizeProbeCatalog(verified.probe_catalog)) !== JSON.stringify(catalog)) throw new Error('配置写入后的核验失败');
  console.log(`已核验主题及 ${catalog.groups.length} 个分组、${catalog.groups.reduce((n, g) => n + g.targets.length, 0)} 个实际探测地址`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
