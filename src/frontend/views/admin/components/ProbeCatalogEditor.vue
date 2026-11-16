<script setup>
import { computed } from 'vue'
import { normalizeProbeCatalog } from '../../../../shared/probes.js'

const catalog = defineModel({ default: () => ({ enabled: false, groups: [] }) })
const error = computed(() => {
  try { normalizeProbeCatalog(catalog.value); return '' } catch (error) { return error.message }
})
const newId = prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
function enable(event) {
  catalog.value.enabled = event.target.checked
  if (catalog.value.enabled && !catalog.value.groups.length) {
    addGroup('IPv4', 'ipv4'); addGroup('IPv6', 'ipv6')
  }
}
function addGroup(name = '新分组', family = 'auto') {
  catalog.value.groups.push({ id: newId('g'), name, family, targets: [] })
}
function addTarget(group) {
  group.targets.push({ id: newId('p'), name: '', address: '', enabled: true })
}
</script>

<template>
  <div class="probe-catalog">
    <label class="probe-catalog__switch"><input type="checkbox" :checked="catalog.enabled" @change="enable"> 启用自定义 Ping 节点与分组</label>
    <p class="probe-catalog__hint">可自由增删节点。IPv4 服务器自动选择 IPv4 分组，IPv6 服务器选择 IPv6 分组，双栈同时选择两组；通用分组适用于任一网络。</p>
    <p class="probe-catalog__hint">新增节点需要支持自定义探测的 Agent；旧版 Agent 保留已有探测配置。</p>
    <template v-if="catalog.enabled">
      <section v-for="(group, groupIndex) in catalog.groups" :key="group.id" class="probe-catalog__group">
        <div class="probe-catalog__group-head">
          <input v-model="group.name" class="form-input" maxlength="80" aria-label="分组名称" placeholder="分组名称">
          <select v-model="group.family" class="form-select" aria-label="分组适用网络">
            <option value="ipv4">IPv4</option><option value="ipv6">IPv6</option><option value="auto">通用 / 双栈</option>
          </select>
          <button type="button" class="btn btn-secondary" :aria-label="`删除分组 ${group.name}`" @click="catalog.groups.splice(groupIndex, 1)">删除分组</button>
        </div>
        <div v-for="(target, index) in group.targets" :key="target.id" class="probe-catalog__target">
          <input v-model="target.enabled" type="checkbox" :aria-label="`启用 ${target.name || '节点'}`">
          <input v-model="target.name" class="form-input" maxlength="80" aria-label="节点名称" placeholder="节点名称">
          <input v-model.trim="target.address" class="form-input" maxlength="60" aria-label="探测地址" placeholder="IP / 域名，可附端口">
          <button type="button" class="btn btn-secondary" :aria-label="`删除节点 ${target.name}`" @click="group.targets.splice(index, 1)">删除</button>
        </div>
        <p v-if="!group.targets.length" class="probe-catalog__hint">该分组还没有探测节点。</p>
        <button type="button" class="btn btn-secondary" @click="addTarget(group)">＋ 添加节点</button>
      </section>
      <button type="button" class="btn btn-secondary" @click="addGroup()">＋ 添加分组</button>
      <p v-if="error" class="text-red" role="alert">{{ error }}</p>
    </template>
  </div>
</template>

<style scoped>
.probe-catalog { margin-bottom: 18px; }
.probe-catalog__switch { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.probe-catalog__hint { font-size: 13px; opacity: .7; line-height: 1.6; margin: 8px 0; }
.probe-catalog__group { border: 1px solid var(--border-color, #8884); border-radius: 8px; padding: 12px; margin: 12px 0; }
.probe-catalog__group-head { display: grid; grid-template-columns: minmax(0, 1fr) 140px auto; gap: 8px; margin-bottom: 12px; }
.probe-catalog__target { display: grid; grid-template-columns: 20px minmax(0, 1fr) minmax(0, 2fr) auto; gap: 8px; align-items: center; margin-bottom: 8px; }
.form-input, .form-select { min-width: 0; }
@media (max-width: 560px) {
  .probe-catalog__group-head { grid-template-columns: minmax(0, 1fr) 120px; }
  .probe-catalog__target { grid-template-columns: 20px minmax(0, 1fr) auto; }
  .probe-catalog__target input[aria-label="探测地址"] { grid-column: 2; grid-row: 2; }
  .probe-catalog__target button { grid-column: 3; grid-row: 1 / 3; }
}
</style>
