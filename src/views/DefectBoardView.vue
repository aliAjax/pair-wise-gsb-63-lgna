<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NTag } from 'naive-ui'
import { useInspectionStore } from '../stores/inspection'

const store = useInspectionStore()
const router = useRouter()
const columns = ['需整改', '整改中', '待复测', '已关闭'] as const
const riskOrder = { 紧急: 0, 高: 1, 中: 2, 低: 3 }
const grouped = computed(() => Object.fromEntries(columns.map((status) => [status, store.records.filter((item) => item.status === status).sort((a, b) => riskOrder[a.risk] - riskOrder[b.risk])])))
</script>

<template>
  <section class="content">
    <div class="board-intro">
      <div><h2>缺陷处置泳道</h2><p>按风险等级排列未闭环任务，点击卡片进入现场处置记录。</p></div>
      <NButton @click="store.resetDemo()">恢复演示数据</NButton>
    </div>
    <div class="kanban">
      <div v-for="column in columns" :key="column" class="kanban-column">
        <header><span>{{ column }}</span><b>{{ grouped[column].length }}</b></header>
        <article v-for="record in grouped[column]" :key="record.id" @click="router.push(`/records/${record.id}`)">
          <div><NTag :type="record.risk === '紧急' ? 'error' : record.risk === '高' ? 'warning' : 'default'" size="small" :bordered="false">{{ record.risk }}风险</NTag><small>V{{ record.version }}</small></div>
          <h3>{{ record.deviceName }}</h3>
          <p>{{ record.deviceCode }} · {{ record.area }}</p>
          <footer><span>{{ record.assignedTo }}</span><span :class="{ overdue: record.dueDate <= '2026-09-29' }">{{ record.dueDate }} 截止</span></footer>
        </article>
        <div v-if="!grouped[column].length" class="kanban-empty">暂无任务</div>
      </div>
    </div>
    <div class="conflict-table">
      <h3>资源冲突提示</h3>
      <p>早班维修一组同时承担高空飞翔紧急整改和家庭过山车复测，系统建议将后者调整至电气班组，避开开放高峰。</p>
      <button @click="store.updateRecord('INS-240821-02', { assignedTo: '检验二组' }, '调整冲突工单')">调整冲突工单</button>
    </div>
  </section>
</template>
