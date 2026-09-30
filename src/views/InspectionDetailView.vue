<script setup lang="ts">
import { computed, h, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NDataTable, NInput, NSelect, NTag, useDialog, useMessage } from 'naive-ui'
import { useInspectionStore } from '../stores/inspection'
import type { CheckResult, Defect, InspectionRecord, InspectionStatus, RetestResult } from '../types'

const route = useRoute()
const router = useRouter()
const store = useInspectionStore()
const message = useMessage()
const dialog = useDialog()
const record = computed(() => store.records.find((item) => item.id === route.params.id))
const device = computed(() => (record.value ? store.deviceOf(record.value) : undefined))
const linkedDefects = computed(() => (record.value ? store.defectsOf(record.value) : []))
const release = computed(() => (record.value ? store.releaseOf(record.value) : undefined))
const form = reactive<Partial<InspectionRecord>>({})
const stopState = computed({
  get: () => device.value?.openState === '停用' ? '停用隔离' : '正常开放',
  set: (value: string) => {
    if (!device.value) return
    const result = store.setDeviceOpen(device.value.id, value === '正常开放', value === '正常开放' ? '值班台调整为开放' : '值班台执行停用隔离')
    result.ok ? message.success(result.message) : message.error(result.message)
  }
})

watch(record, (value) => {
  if (value) Object.assign(form, structuredClone(value))
}, { immediate: true })

const items = computed(() => record.value?.items ?? [])
const transitions: InspectionStatus[] = ['待检验', '需整改', '整改中', '待复测', '已关闭', '停用']
const locked = computed(() => !!record.value?.pendingBatchId)

function save() {
  if (!record.value) return
  const result = store.updateRecord(record.value.id, {
    assignedTo: form.assignedTo,
    dueDate: form.dueDate,
    risk: form.risk,
    items: form.items
  })
  result.ok ? message.success('检验记录已保存并生成新版本') : message.error(result.message)
}

function changeStatus(next: InspectionStatus) {
  if (!record.value) return
  dialog.warning({
    title: `确认流转至${next}`,
    content: '系统会校验异常项、设备开放状态和复测要求，并写入操作审计。',
    positiveText: '确认流转',
    negativeText: '取消',
    onPositiveClick: () => {
      const result = store.transition(record.value!.id, next, `由${record.value!.status}流转至${next}`)
      result.ok ? message.success(result.message) : message.error(result.message)
    }
  })
}

const columns = [
  { title: '检验项', key: 'name', width: 130 },
  { title: '结果', key: 'result', width: 120, render: (row: any) => h(NSelect, { value: row.result, disabled: locked.value, options: ['正常', '异常', '不适用'].map((value) => ({ label: value, value })), onUpdateValue: (value: CheckResult) => { row.result = value } }) },
  { title: '实测值', key: 'reading', width: 160, render: (row: any) => h(NInput, { value: row.reading, disabled: locked.value, onUpdateValue: (value: string) => { row.reading = value } }) },
  { title: '判定标准', key: 'limit', width: 150 },
  { title: '备注', key: 'note', render: (row: any) => h(NInput, { value: row.note, disabled: locked.value, onUpdateValue: (value: string) => { row.note = value } }) }
]

// 缺陷复测
const showRetest = ref(false)
const activeDefect = ref<Defect | null>(null)
const retestResult = ref<RetestResult>('复测通过')
const retestNote = ref('')
function openRetest(defect: Defect, preset: RetestResult) {
  activeDefect.value = defect
  retestResult.value = preset
  retestNote.value = ''
  showRetest.value = true
}
function submitRetest() {
  if (!activeDefect.value) return
  const result = store.submitRetest(activeDefect.value.id, retestResult.value, retestNote.value)
  result.ok ? message.success(result.message) : message.error(result.message)
  showRetest.value = false
}
function closeDefect(defect: Defect) {
  const result = store.closeDefect(defect.id)
  result.ok ? message.success(result.message) : message.error(result.message)
}

function exportRecord() {
  if (!record.value) return
  const blob = new Blob([JSON.stringify({ record: record.value, device: device.value, defects: linkedDefects.value, release: release.value }, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${record.value.id}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

function uploadPhoto() {
  if (!record.value || locked.value) return message.error('批次待确认期间记录已锁定')
  record.value.evidenceCount += 1
  message.success('已模拟上传现场照片')
}
</script>

<template>
  <section v-if="record" class="content detail-layout">
    <div class="detail-main">
      <div class="section-head">
        <div>
          <p>{{ record.deviceCode }} · {{ record.area }} · {{ record.shift }}</p>
          <h2>{{ record.deviceName }}</h2>
        </div>
        <div class="head-actions">
          <NTag :type="device?.openState === '开放' ? 'success' : 'error'" :bordered="false">
            {{ device?.reopenLocked ? '合并锁定·停用' : device?.openState }}
          </NTag>
          <NButton @click="exportRecord">导出记录</NButton>
          <NButton type="primary" :disabled="locked" @click="save">保存新版本</NButton>
        </div>
      </div>

      <div v-if="locked" class="lock-banner">
        补录批次 {{ record.pendingBatchId }} 待值班长确认，设备与记录已锁定；确认前设备不能恢复开放。
        <NButton size="tiny" type="primary" @click="router.push('/sync')">前往合并中心</NButton>
      </div>

      <div class="form-band">
        <label>整改责任人 <NInput v-model:value="form.assignedTo" :disabled="locked" /></label>
        <label>截止日期 <input v-model="form.dueDate" class="native-date" type="date" :disabled="locked" /></label>
        <label>风险等级 <NSelect v-model:value="form.risk" :disabled="locked" :options="['低', '中', '高', '紧急'].map((value) => ({ label: value, value }))" /></label>
        <label>设备状态 <NSelect v-model:value="stopState" :disabled="device?.reopenLocked" :options="['正常开放', '停用隔离'].map((value) => ({ label: value, value }))" /></label>
      </div>

      <!-- 并列保留字段 -->
      <div v-if="record.parallelFields?.length || device?.parallelFields?.length" class="parallel-box">
        <h3>两端都改过 · 并列保留</h3>
        <div v-for="field in [...(record.parallelFields ?? []), ...(device?.parallelFields ?? [])]" :key="field.path" class="parallel-row">
          <strong>{{ field.label }}</strong>
          <span class="offline-val">采集端：{{ field.offlineValue }}</span>
          <span class="duty-val">值班室：{{ field.dutyValue }}</span>
          <NTag size="small" :type="field.resolution === '并列保留' ? 'warning' : 'default'" :bordered="false">
            {{ field.resolution ?? '待值班长裁决' }}{{ field.confirmedValue ? ` → ${field.confirmedValue}` : '' }}
          </NTag>
        </div>
      </div>

      <h3>逐项检验结果</h3>
      <NDataTable :columns="columns" :data="items" :bordered="false" size="small" />

      <div class="evidence-panel">
        <div><strong>现场证据</strong><span>{{ record.evidenceCount }} 张照片 · 最近上传 09:31</span></div>
        <div class="evidence-list"><span>锁止间隙近景</span><span>设备铭牌</span><span>制动测试仪表</span><button @click="uploadPhoto">上传照片</button></div>
      </div>

      <!-- 关联缺陷 -->
      <h3>关联缺陷（{{ linkedDefects.length }}）</h3>
      <div class="linked-defects">
        <article v-for="defect in linkedDefects" :key="defect.id" class="linked-defect">
          <header>
            <strong>{{ defect.title }}</strong>
            <NTag size="small" :type="defect.status === '已关闭' ? 'success' : defect.retestResult === '复测不通过' ? 'error' : 'warning'" :bordered="false">{{ defect.status }}</NTag>
          </header>
          <p class="muted">{{ defect.id }} · {{ defect.risk }}风险 · {{ defect.assignee }} · R{{ defect.rev }}</p>
          <p v-if="defect.retestNote">复测：{{ defect.retestNote }}（{{ defect.retestResult }}）</p>
          <p v-if="defect.closeRejected" class="error-text">值班室曾在复测通过前关闭，已被合并拒绝并退回待复测</p>
          <div v-if="defect.status !== '已关闭' && !defect.pendingBatchId" class="defect-actions">
            <NButton size="tiny" @click="openRetest(defect, '复测通过')">复测通过</NButton>
            <NButton size="tiny" tertiary @click="openRetest(defect, '复测不通过')">复测不通过</NButton>
            <NButton v-if="defect.retestResult === '复测通过'" size="tiny" type="success" @click="closeDefect(defect)">关闭缺陷</NButton>
          </div>
        </article>
      </div>
    </div>

    <aside class="detail-side">
      <div>
        <span class="side-label">当前流程</span>
        <strong>{{ record.status }}</strong>
        <small>版本 V{{ record.version }} · 基线 V{{ record.baselineVersion }} · 更新于 {{ record.updatedAt.replace('T', ' ').slice(0, 16) }}</small>
      </div>
      <div class="flow-list">
        <button v-for="status in transitions" :key="status" :class="{ active: status === record.status }" @click="changeStatus(status)">
          <span>{{ status }}</span><small>{{ status === record.status ? '当前状态' : '执行流转' }}</small>
        </button>
      </div>
      <div class="rule-note">
        <strong>闭环校验</strong>
        <p>复测通过才可关闭缺陷；设备恢复开放且缺陷全部关闭后检验记录才能闭环；值班长确认合并前设备保持停用锁定。</p>
      </div>

      <!-- 放行记录 -->
      <div v-if="release" class="release-side">
        <span class="side-label">放行记录</span>
        <strong>{{ release.deviceName }}</strong>
        <NTag size="small" :type="release.state === '写入成功' ? 'success' : 'error'" :bordered="false">{{ release.state }}</NTag>
        <small>{{ release.id }} · 尝试 {{ release.attempts }} 次</small>
        <small v-if="release.lastError" class="error-text">{{ release.lastError }}</small>
      </div>

      <NButton block @click="router.push('/audit')">查看完整审计</NButton>
    </aside>

    <NModal v-model:show="showRetest" preset="card" title="录入复测结论" style="width: 500px">
      <p v-if="activeDefect" class="muted">{{ activeDefect.id }} · {{ activeDefect.title }}</p>
      <NSelect v-model:value="retestResult" :options="['复测通过', '复测不通过'].map((value) => ({ label: value, value }))" style="margin: 10px 0" />
      <NInput v-model:value="retestNote" type="textarea" placeholder="复测数据与说明" :rows="3" />
      <template #footer>
        <div class="modal-actions">
          <NButton @click="showRetest = false">取消</NButton>
          <NButton type="primary" @click="submitRetest">提交复测</NButton>
        </div>
      </template>
    </NModal>
  </section>
  <section v-else class="content empty-state">未找到检验记录</section>
</template>
