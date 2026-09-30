<script setup lang="ts">
import { computed, ref } from 'vue'
import { NInput, NTag } from 'naive-ui'
import { useInspectionStore } from '../stores/inspection'

const store = useInspectionStore()
const keyword = ref('')
const entries = computed(() => store.audit.filter((item) => !keyword.value || `${item.recordId} ${item.action} ${item.operator} ${item.detail}`.includes(keyword.value)))
</script>

<template>
  <section class="content audit-layout">
    <div class="audit-head">
      <div><h2>操作审计与版本追溯</h2><p>记录创建、检验修改、状态流转和冲突处理的完整时间线。</p></div>
      <NInput v-model:value="keyword" clearable placeholder="按编号、操作人、动作搜索" style="max-width: 330px" />
    </div>
    <div class="timeline">
      <article v-for="entry in entries" :key="entry.id">
        <div class="time">{{ entry.createdAt.replace('T', ' ').slice(0, 16) }}</div>
        <i />
        <div class="audit-card">
          <header><strong>{{ entry.action }}</strong><NTag size="small" :bordered="false">{{ entry.recordId }}</NTag></header>
          <p>{{ entry.detail }}</p>
          <small>操作人：{{ entry.operator }}</small>
        </div>
      </article>
    </div>
  </section>
</template>
