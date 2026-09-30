<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NInput, NModal, NRadioGroup, NRadio, NTag, useMessage } from 'naive-ui'
import { useInspectionStore } from '../stores/inspection'
import type { Defect, DefectStatus, RetestResult } from '../types'

const store = useInspectionStore()
const router = useRouter()
const message = useMessage()

const columns: DefectStatus[] = ['待处理', '整改中', '待复测', '复测通过', '已关闭']
const riskOrder = { 紧急: 0, 高: 1, 中: 2, 低: 3 }
const grouped = computed(() =>
  Object.fromEntries(columns.map((status) => [
    status,
    store.defects.filter((item) => item.status === status).sort((a, b) => riskOrder[a.risk] - riskOrder[b.risk])
  ]))
)
const deviceOf = (defect: Defect) => store.devices.find((item) => item.id === defect.deviceId)
const recordOf = (defect: Defect) => store.records.find((item) => item.id === defect.recordId)

// 复测录入
const showRetest = ref(false)
const active = ref<Defect | null>(null)
const retestResult = ref<RetestResult>('复测通过')
const retestNote = ref('')

function openRetest(defect: Defect, preset: RetestResult) {
  active.value = defect
  retestResult.value = preset
  retestNote.value = ''
  showRetest.value = true
}

function submit() {
  if (!active.value) return
  const result = store.submitRetest(active.value.id, retestResult.value, retestNote.value)
  result.ok ? message.success(result.message) : message.error(result.message)
  showRetest.value = false
}

function closeOne(defect: Defect) {
  const result = store.closeDefect(defect.id)
  result.ok ? message.success(result.message) : message.error(result.message)
}
</script>

<template>
  <section class="content">
    <div class="board-intro">
      <div><h2>缺陷处置泳道</h2><p>复测通过才可关闭缺陷并放行设备；复测不通过设备重新停用。点击卡片进入检验记录。</p></div>
      <NButton @click="store.resetDemo()">恢复演示数据</NButton>
    </div>
    <div class="kanban defect-kanban">
      <div v-for="column in columns" :key="column" class="kanban-column">
        <header><span>{{ column }}</span><b>{{ grouped[column].length }}</b></header>
        <article v-for="defect in grouped[column]" :key="defect.id" class="defect-card">
          <div @click="router.push(`/records/${defect.recordId}`)">
            <div>
              <NTag :type="defect.risk === '紧急' ? 'error' : defect.risk === '高' ? 'warning' : 'default'" size="small" :bordered="false">{{ defect.risk }}风险</NTag>
              <NTag v-if="defect.pendingBatchId" size="small" type="error" :bordered="false">合并待确认</NTag>
              <small>R{{ defect.rev }}</small>
            </div>
            <h3>{{ defect.title }}</h3>
            <p>{{ deviceOf(defect)?.name }} · {{ deviceOf(defect)?.code }}</p>
            <p v-if="defect.retestNote" class="retest-note">复测：{{ defect.retestNote }}</p>
            <footer>
              <span>{{ defect.assignee }}</span>
              <span :class="{ overdue: (recordOf(defect)?.dueDate ?? '') <= '2026-09-29' }">{{ recordOf(defect)?.dueDate }} 截止</span>
            </footer>
          </div>
          <div v-if="defect.status !== '已关闭'" class="defect-actions">
            <template v-if="!defect.pendingBatchId">
              <NButton size="tiny" type="primary" @click.stop="openRetest(defect, '复测通过')">复测通过</NButton>
              <NButton size="tiny" tertiary @click.stop="openRetest(defect, '复测不通过')">复测不通过</NButton>
              <NButton v-if="defect.status === '复测通过'" size="tiny" type="success" @click.stop="closeOne(defect)">关闭缺陷</NButton>
            </template>
            <span v-else class="muted">批次确认后统一裁决</span>
          </div>
        </article>
        <div v-if="!grouped[column].length" class="kanban-empty">暂无缺陷</div>
      </div>
    </div>
    <div class="conflict-table">
      <h3>闭环规则</h3>
      <p>缺陷必须有“复测通过”结论才能关闭；关闭缺陷并由值班长确认批次后，设备才可恢复开放并生成放行记录。值班室在复测回传前关闭的缺陷，回网合并时会被拒绝并退回待复测。</p>
    </div>

    <NModal v-model:show="showRetest" preset="card" title="录入复测结论" style="width: 520px">
      <p v-if="active" class="muted">{{ active.id }} · {{ active.title }}</p>
      <NRadioGroup v-model:value="retestResult" style="margin: 10px 0">
        <NRadio value="复测通过">复测通过</NRadio>
        <NRadio value="复测不通过">复测不通过</NRadio>
      </NRadioGroup>
      <NInput v-model:value="retestNote" type="textarea" placeholder="复测数据与说明（如：复检磨损 3.6 mm，负荷试验合格）" :rows="3" />
      <template #footer>
        <div class="modal-actions">
          <NButton @click="showRetest = false">取消</NButton>
          <NButton type="primary" @click="submit">提交复测</NButton>
        </div>
      </template>
    </NModal>
  </section>
</template>
