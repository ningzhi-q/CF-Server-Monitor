<script setup>
import { computed } from 'vue'
import { normalizeProbeSelection, selectProbeTargets } from '../../../../shared/probes.js'
const props = defineProps({ catalog: { type: Object, required: true }, ipv4: String, ipv6: String })
const selection = defineModel({ default: '' })
const parsed = computed(() => normalizeProbeSelection(selection.value))
const automatic = computed(() => parsed.value.mode === 'auto')
const selected = computed(() => automatic.value
  ? selectProbeTargets(props.catalog, parsed.value, props.ipv4, props.ipv6).map(target => target.id)
  : parsed.value.targets)
function setAutomatic(event) {
  selection.value = { mode: event.target.checked ? 'auto' : 'manual', targets: [...selected.value] }
}
function toggle(ids, checked) {
  const targets = new Set(selected.value)
  for (const id of ids) { if (checked) targets.add(id); else targets.delete(id) }
  selection.value = { mode: 'manual', targets: [...targets] }
}
</script>

<template>
  <div class="probe-selection">
    <label><input type="checkbox" :checked="automatic" @change="setAutomatic"> 按 IPv4 / IPv6 能力自动选择</label>
    <p v-if="automatic && !ipv4 && !ipv6" class="probe-selection__hint">等待 Agent 上报网络能力后自动选择。</p>
    <section v-for="group in catalog.groups" :key="group.id">
      <label class="probe-selection__group"><input type="checkbox" :disabled="automatic" :checked="group.targets.filter(t => t.enabled).length > 0 && group.targets.filter(t => t.enabled).every(t => selected.includes(t.id))" @change="toggle(group.targets.filter(t => t.enabled).map(t => t.id), $event.target.checked)"> {{ group.name }} <small>{{ group.family === 'auto' ? '通用 / 双栈' : group.family === 'ipv4' ? 'IPv4' : 'IPv6' }}</small></label>
      <div class="probe-selection__targets">
        <label v-for="target in group.targets.filter(t => t.enabled)" :key="target.id"><input type="checkbox" :disabled="automatic" :checked="selected.includes(target.id)" @change="toggle([target.id], $event.target.checked)"> {{ target.name }}</label>
      </div>
    </section>
  </div>
</template>

<style scoped>
.probe-selection { border: 1px solid var(--border-color, #8884); padding: 12px; border-radius: 8px; margin-bottom: 16px; }
.probe-selection label { display: inline-flex; align-items: center; gap: 8px; }
.probe-selection section { margin-top: 12px; }
.probe-selection__group { font-weight: 600; }
.probe-selection__targets { display: flex; flex-wrap: wrap; gap: 8px 20px; margin: 8px 0 0 24px; }
.probe-selection__hint, .probe-selection small { opacity: .65; font-size: 12px; }
</style>
