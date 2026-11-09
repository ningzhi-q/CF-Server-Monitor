<template>
  <div class="expiration-date-input">
    <input v-if="permanent" type="text" :value="trans.permanent" class="form-input" :aria-label="trans.expirationDate" disabled>
    <input v-else type="date" :name="name" autocomplete="off" v-model="value" class="form-input" :aria-label="trans.expirationDate" :disabled="disabled" @click="openDatePicker">
    <label class="permanent-option">
      <input type="checkbox" :checked="permanent" :disabled="disabled" @change="togglePermanent">
      <span>{{ trans.permanent }}</span>
    </label>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { isPermanentExpiration, PERMANENT_EXPIRE_DATE } from '../../../utils/server.js'

const value = defineModel({ type: String, default: '' })
defineProps({
  trans: { type: Object, required: true },
  name: { type: String, default: undefined },
  disabled: { type: Boolean, default: false }
})

const permanent = computed(() => isPermanentExpiration(value.value))
const previousDate = ref(permanent.value ? '' : value.value)

watch(value, (date) => {
  if (!isPermanentExpiration(date)) previousDate.value = date
})

const togglePermanent = (event) => {
  value.value = event.target.checked ? PERMANENT_EXPIRE_DATE : previousDate.value
}

const openDatePicker = (event) => {
  const input = event.currentTarget
  if (typeof input.showPicker !== 'function') return
  try {
    input.showPicker()
  } catch (_) {}
}
</script>

<style scoped>
.permanent-option {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  cursor: pointer;
}
.permanent-option input {
  margin: 0;
}
</style>
