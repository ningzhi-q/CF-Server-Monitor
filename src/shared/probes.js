import { validatePingNode } from '../frontend/utils/pingNode.js';

export const PROBE_ID_PATTERN = /^p_[a-zA-Z0-9_-]{1,60}$/;
const GROUP_ID_PATTERN = /^g_[a-zA-Z0-9_-]{1,60}$/;
const FAMILIES = new Set(['ipv4', 'ipv6', 'auto']);
const ownObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;

export function normalizeProbeCatalog(input) {
  if (input === undefined || input === null || input === '') return { enabled: false, groups: [] };
  const value = parse(input);
  if (!ownObject(value) || typeof value.enabled !== 'boolean' || !Array.isArray(value.groups)) throw new Error('探测分组格式无效');
  const ids = new Set();
  const groups = value.groups.map(group => {
    if (!ownObject(group) || !GROUP_ID_PATTERN.test(group.id) || ids.has(group.id)
      || typeof group.name !== 'string' || !group.name.trim() || group.name.length > 80
      || !FAMILIES.has(group.family) || !Array.isArray(group.targets)) throw new Error('探测分组名称、网络类型或编号无效');
    ids.add(group.id);
    const targets = group.targets.map(target => {
      if (!ownObject(target) || !PROBE_ID_PATTERN.test(target.id) || ids.has(target.id)
        || typeof target.name !== 'string' || !target.name.trim() || target.name.length > 80
        || typeof target.address !== 'string' || typeof target.enabled !== 'boolean') throw new Error('探测节点名称或编号无效');
      const address = validatePingNode(target.address);
      if (!address.valid || !address.value || address.value === '0') throw new Error('探测地址无效，请填写 IP 或域名，可附端口');
      const host = address.value.startsWith('[') ? address.value.slice(1, address.value.indexOf(']')) : address.value.split(':')[0];
      if (group.family === 'ipv4' && host.includes(':')) throw new Error('IPv4 分组不能使用 IPv6 地址');
      if (group.family === 'ipv6' && /^\d+\.\d+\.\d+\.\d+$/.test(host)) throw new Error('IPv6 分组不能使用 IPv4 地址');
      ids.add(target.id);
      return { id: target.id, name: target.name.trim(), address: address.value, enabled: target.enabled };
    });
    return { id: group.id, name: group.name.trim(), family: group.family, targets };
  });
  const result = { enabled: value.enabled, groups };
  // Configuration is sent as a bounded URL-encoded body, rather than growing fixed Agent slots.
  if (encodeURIComponent(JSON.stringify(result)).length > 58_000) throw new Error('探测配置超过传输大小限制');
  return result;
}

export function normalizeProbeSelection(input) {
  if (input === undefined || input === null || input === '') return { mode: 'auto', targets: [] };
  const value = parse(input);
  if (!ownObject(value) || !['auto', 'manual'].includes(value.mode) || !Array.isArray(value.targets)
    || value.targets.some(id => typeof id !== 'string' || !PROBE_ID_PATTERN.test(id))) throw new Error('探测节点选择格式无效');
  const result = { mode: value.mode, targets: [...new Set(value.targets)] };
  if (encodeURIComponent(JSON.stringify(result)).length > 4_000) throw new Error('手动选择超过传输大小限制');
  return result;
}

export function selectProbeTargets(catalog, selection, ipv4, ipv6) {
  const chosen = new Set(selection.targets);
  return catalog.enabled ? catalog.groups.flatMap(group => group.targets.filter(target => target.enabled && (
    selection.mode === 'manual' ? chosen.has(target.id)
      : group.family === 'ipv4' ? ipv4 === '1'
        : group.family === 'ipv6' ? ipv6 === '1' : ipv4 === '1' || ipv6 === '1'
  )).map(target => ({ ...target, family: group.family, group: group.id }))) : [];
}

export function publicProbeCatalog(input) {
  const catalog = normalizeProbeCatalog(input);
  return { enabled: catalog.enabled, groups: catalog.groups.map(group => ({
    id: group.id, name: group.name, family: group.family,
    targets: group.targets.filter(target => target.enabled).map(target => ({ id: target.id, name: target.name })),
  })) };
}

export function normalizeProbeResults(input) {
  try {
    const value = parse(input);
    if (!ownObject(value)) return {};
    const result = {};
    for (const [id, sample] of Object.entries(value)) {
      if (!PROBE_ID_PATTERN.test(id) || !ownObject(sample) || !Number.isFinite(sample.ts) || sample.ts <= 0) continue;
      const metric = (value, max = Infinity) => value === false || value === null ? value
        : typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
      result[id] = { ts: sample.ts, latency: metric(sample.latency), loss: metric(sample.loss, 100) };
    }
    return JSON.stringify(result).length <= 58_000 ? result : {};
  } catch { return {}; }
}
