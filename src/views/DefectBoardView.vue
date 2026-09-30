<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NTag, useMessage } from 'naive-ui'
import { useInspectionStore } from '../stores/inspection'

const store = useInspectionStore()
const router = useRouter()
const message = useMessage()
const columns = ['开放', '整改中', '待复测', '复测通过', '已关闭'] as const
const riskOrder = { 紧急: 0, 高: 1, 中: 2, 低: 3 }

// 只按当前有效版本（active）的缺陷统计
const grouped = computed(() => Object.fromEntries(columns.map((status) => [
  status,
  store.defects
    .filter((defect) => defect.active && defect.status === status)
    .sort((a, b) => riskOrder[a.risk] - riskOrder[b.risk])
])))

function recordOf(recordId: string) {
  return store.records.find((record) => record.id === recordId)
}
function notify(result: { ok: boolean; message: string }) {
  result.ok ? message.success(result.message) : message.error(result.message)
}
</script>

<template>
  <section class="content">
    <div class="board-intro">
      <div><h2>缺陷处置泳道</h2><p>仅统计当前有效版本的缺陷；复测通过才允许关闭并触发放行。</p></div>
      <NButton @click="store.resetDemo()">恢复演示数据</NButton>
    </div>
    <div class="kanban kanban-5">
      <div v-for="column in columns" :key="column" class="kanban-column">
        <header><span>{{ column }}</span><b>{{ grouped[column].length }}</b></header>
        <article v-for="defect in grouped[column]" :key="defect.id" @click="router.push(`/records/${defect.recordId}`)">
          <div>
            <NTag :type="defect.risk === '紧急' ? 'error' : defect.risk === '高' ? 'warning' : 'default'" size="small" :bordered="false">{{ defect.risk }}风险</NTag>
            <small>{{ defect.deviceCode }}</small>
          </div>
          <h3>{{ defect.title }}</h3>
          <p>{{ recordOf(defect.recordId)?.deviceName }} · 复测：{{ defect.retestPassed ? '已通过' : '未通过' }}</p>
          <footer>
            <span>{{ defect.releasedByBatch ? `放行 ${defect.releasedByBatch.slice(-6)}` : '未放行' }}</span>
            <span>{{ defect.closedAt ? defect.closedAt.slice(0, 10) : '开放中' }}</span>
          </footer>
        </article>
        <div v-if="!grouped[column].length" class="kanban-empty">暂无缺陷</div>
      </div>
    </div>
    <div class="conflict-table">
      <h3>闭环规则提示</h3>
      <p>缺陷必须在补录批次的复测结果合格、值班长确认且放行单写入成功后才会关闭；放行写入失败只重试对应批次，设备在确认前保持锁定。值班室可在「断网补录·合并」页模拟断网期间的并行复测。</p>
      <NButton size="small" tertiary @click="router.push('/sync')">前往断网补录 / 回网合并</NButton>
    </div>
  </section>
</template>
