<script setup lang="ts">
import { computed, ref } from 'vue'
import { NInput, NSwitch, NTag } from 'naive-ui'
import { useInspectionStore } from '../stores/inspection'

const store = useInspectionStore()
const keyword = ref('')
const currentOnly = ref(true)

const entityLabel: Record<string, string> = {
  record: '检验记录', device: '设备', defect: '缺陷', release: '放行', batch: '批次'
}

const entries = computed(() => {
  const source = currentOnly.value ? store.effectiveAudit : store.audit
  return source.filter((item) => !keyword.value
    || `${item.recordId} ${item.action} ${item.operator} ${item.detail} ${entityLabel[item.entityType]}`.includes(keyword.value))
})

function isCurrent(rev: number, recordId: string, entityType: string) {
  return store.currentRev({ recordId, entityType: entityType as 'record' }) === rev
}
</script>

<template>
  <section class="content audit-layout">
    <div class="audit-head">
      <div><h2>操作审计与版本追溯</h2><p>默认只统计当前有效版本的动作；被新版本覆盖的历史动作可展开查看。</p></div>
      <div class="audit-tools">
        <label class="switch-line"><NSwitch v-model:value="currentOnly" size="small" /> 只看当前有效版本</label>
        <NInput v-model:value="keyword" clearable placeholder="按编号、操作人、动作搜索" style="max-width: 300px" />
      </div>
    </div>
    <div class="timeline">
      <article v-for="entry in entries" :key="entry.id" :class="{ stale: !currentOnly && !isCurrent(entry.rev, entry.recordId, entry.entityType) }">
        <div class="time">{{ entry.createdAt.replace('T', ' ').slice(0, 16) }}</div>
        <i />
        <div class="audit-card">
          <header>
            <strong>{{ entry.action }}</strong>
            <NTag size="small" :bordered="false">{{ entityLabel[entry.entityType] }}</NTag>
            <NTag size="small" :bordered="false" type="info">{{ entry.recordId }}</NTag>
            <NTag v-if="entry.migrated" size="small" :bordered="false" type="warning">旧数据迁移</NTag>
            <NTag v-if="!isCurrent(entry.rev, entry.recordId, entry.entityType)" size="small" :bordered="false" type="default">历史版本 R{{ entry.rev }}</NTag>
          </header>
          <p>{{ entry.detail }}</p>
          <small>操作人：{{ entry.operator }}</small>
        </div>
      </article>
    </div>
  </section>
</template>
