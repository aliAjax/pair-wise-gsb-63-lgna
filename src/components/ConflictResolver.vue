<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NTag } from 'naive-ui'
import { useInspectionStore } from '../stores/inspection'

const props = defineProps<{ batchId: string; field: string }>()
const emit = defineEmits<{ resolve: [batchId: string, field: string, resolution: 'offline' | 'online'] }>()

const store = useInspectionStore()

const conflict = computed(() => {
  const batch = store.batches.find((item) => item.id === props.batchId)
  const record = batch && store.records.find((item) => item.deviceCode === batch.deviceCode)
  return record?.conflicts.find((item) => item.field === props.field)
})

const collectedShort = computed(() => conflict.value?.collectedAt.replace('T', ' ').slice(5, 16) ?? '')
</script>

<template>
  <div v-if="conflict" class="conflict-inner" :class="{ resolved: conflict.resolved }">
    <div class="conflict-label">{{ conflict.fieldLabel }}</div>
    <div class="conflict-values">
      <div class="conflict-side offline">
        <small>补录值（采集 {{ collectedShort }}）</small>
        <b>{{ conflict.offlineValue }}</b>
      </div>
      <div class="conflict-side online">
        <small>值班室在线值</small>
        <b>{{ conflict.onlineValue }}</b>
      </div>
    </div>
    <NTag v-if="conflict.resolved" type="success" size="small" :bordered="false">
      已采用{{ conflict.resolution === 'offline' ? '补录值' : '值班室值' }}
    </NTag>
    <div v-else class="conflict-btns">
      <NButton size="tiny" type="warning" tertiary @click="emit('resolve', batchId, field, 'offline')">采用补录值</NButton>
      <NButton size="tiny" tertiary @click="emit('resolve', batchId, field, 'online')">采用值班室值</NButton>
    </div>
  </div>
</template>
