<script setup lang="ts">
import { computed, ref } from 'vue'
import { NInput, NSwitch, NTag } from 'naive-ui'
import { useInspectionStore } from '../stores/inspection'

const store = useInspectionStore()
const keyword = ref('')
const showAllVersions = ref(false)

// 默认只按当前有效版本统计；开关后可查看被合并/裁决取代的历史条目
const entries = computed(() => {
  const source = showAllVersions.value ? store.audit : store.effectiveAudit
  return source.filter((item) => !keyword.value || `${item.recordId} ${item.action} ${item.operator} ${item.detail}`.includes(keyword.value))
})

const categoryType: Record<string, 'default' | 'info' | 'success' | 'warning' | 'error'> = {
  合并: 'warning', 放行: 'success', 设备: 'info', 缺陷: 'error', 检验: 'default', 迁移: 'info'
}
</script>

<template>
  <section class="content audit-layout">
    <div class="audit-head">
      <div>
        <h2>操作审计与版本追溯</h2>
        <p>审计与待办统计只按当前有效版本；被后续合并/裁决取代的条目默认隐藏，可展开查看。</p>
      </div>
      <div class="audit-tools">
        <label class="version-switch">
          <span>显示历史失效版本</span>
          <NSwitch v-model:value="showAllVersions" size="small" />
        </label>
        <NInput v-model:value="keyword" clearable placeholder="按编号、操作人、动作搜索" style="width: 280px" />
      </div>
    </div>

    <div class="audit-count">
      当前展示 <b>{{ entries.length }}</b> 条 ·
      有效版本 <b>{{ store.effectiveAudit.length }}</b> 条 ·
      历史版本 <b>{{ store.audit.length - store.effectiveAudit.length }}</b> 条
    </div>

    <div class="timeline">
      <article v-for="entry in entries" :key="entry.id" :class="{ inactive: !entry.active }">
        <div class="time">{{ entry.createdAt.replace('T', ' ').slice(0, 16) }}</div>
        <i />
        <div class="audit-card">
          <header>
            <span class="audit-title">
              <strong>{{ entry.action }}</strong>
              <NTag size="small" :type="categoryType[entry.category ?? '检验'] ?? 'default'" :bordered="false">{{ entry.category ?? '检验' }}</NTag>
              <NTag v-if="!entry.active" size="small" type="default" :bordered="false">已失效</NTag>
            </span>
            <NTag size="small" :bordered="false">{{ entry.recordId }} · V{{ entry.version }}</NTag>
          </header>
          <p>{{ entry.detail }}</p>
          <small>操作人：{{ entry.operator }}</small>
        </div>
      </article>
    </div>
  </section>
</template>
