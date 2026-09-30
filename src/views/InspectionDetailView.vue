<script setup lang="ts">
import { computed, h, reactive, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NDataTable, NInput, NSelect, NTag, useDialog, useMessage } from 'naive-ui'
import { useInspectionStore } from '../stores/inspection'
import type { CheckResult, InspectionRecord, InspectionStatus } from '../types'

const route = useRoute()
const router = useRouter()
const store = useInspectionStore()
const message = useMessage()
const dialog = useDialog()
const record = computed(() => store.records.find((item) => item.id === route.params.id))
const form = reactive<Partial<InspectionRecord>>({})
const stopState = computed({
  get: () => form.stopped ? '停用隔离' : '正常开放',
  set: (value: string) => { form.stopped = value === '停用隔离' }
})

watch(record, (value) => {
  if (value) Object.assign(form, structuredClone(value))
}, { immediate: true })

const items = computed(() => record.value?.items ?? [])
const transitions: InspectionStatus[] = ['待检验', '需整改', '整改中', '待复测', '已关闭', '停用']
const device = computed(() => record.value ? store.devices.find((item) => item.code === record.value!.deviceCode) : undefined)
const linkedDefects = computed(() => record.value ? store.defects.filter((defect) => defect.recordId === record.value!.id && defect.active) : [])
const unresolvedConflicts = computed(() => record.value?.conflicts.filter((conflict) => !conflict.resolved) ?? [])

function save() {
  if (!record.value) return
  store.updateRecord(record.value.id, {
    assignedTo: form.assignedTo,
    dueDate: form.dueDate,
    risk: form.risk,
    stopped: form.stopped,
    items: form.items
  })
  message.success('检验记录已保存并生成新版本')
}

function changeStatus(next: InspectionStatus) {
  if (!record.value) return
  dialog.warning({
    title: `确认流转至${next}`,
    content: '系统会校验异常项、停用状态和复测要求，并写入操作审计。',
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
  { title: '结果', key: 'result', width: 120, render: (row: any, index: number) => h(NSelect, { value: row.result, options: ['正常', '异常', '不适用'].map((value) => ({ label: value, value })), onUpdateValue: (value: CheckResult) => { row.result = value } }) },
  { title: '实测值', key: 'reading', width: 160, render: (row: any) => h(NInput, { value: row.reading, onUpdateValue: (value: string) => { row.reading = value } }) },
  { title: '判定标准', key: 'limit', width: 150 },
  { title: '备注', key: 'note', render: (row: any) => h(NInput, { value: row.note, onUpdateValue: (value: string) => { row.note = value } }) }
]

function exportRecord() {
  if (!record.value) return
  const blob = new Blob([JSON.stringify(record.value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${record.value.id}.json`
  anchor.click()
  URL.revokeObjectURL(url)
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
          <NTag v-if="device?.mergeLocked" type="warning" :bordered="false">合并锁定·待值班长确认</NTag>
          <NTag :type="record.stopped ? 'error' : record.status === '已关闭' ? 'success' : 'warning'" :bordered="false">{{ record.stopped ? '设备已停用' : record.status }}</NTag>
          <NButton @click="exportRecord">导出记录</NButton>
          <NButton type="primary" @click="save">保存新版本</NButton>
        </div>
      </div>

      <div v-if="unresolvedConflicts.length" class="conflict-banner">
        <strong>{{ unresolvedConflicts.length }} 个字段并列冲突</strong>
        <span>补录值与值班室值都保留在当前版本，需值班长在「断网补录·合并」页裁决后才能确认放行。</span>
        <div v-for="conflict in unresolvedConflicts" :key="conflict.field" class="conflict-mini">
          <b>{{ conflict.fieldLabel }}</b>
          <em>补录：{{ conflict.offlineValue }}</em>
          <em>值班室：{{ conflict.onlineValue }}</em>
        </div>
      </div>

      <div v-if="linkedDefects.length" class="defect-strip">
        <span class="side-label">关联缺陷（当前有效版本）</span>
        <NTag v-for="defect in linkedDefects" :key="defect.id" :type="defect.status === '已关闭' ? 'success' : defect.retestPassed ? 'info' : 'warning'" size="small" :bordered="false">
          {{ defect.title }} · {{ defect.status }}
        </NTag>
      </div>

      <div class="form-band">
        <label>整改责任人 <NInput v-model:value="form.assignedTo" /></label>
        <label>截止日期 <input v-model="form.dueDate" class="native-date" type="date" /></label>
        <label>风险等级 <NSelect v-model:value="form.risk" :options="['低', '中', '高', '紧急'].map((value) => ({ label: value, value }))" /></label>
        <label>设备状态 <NSelect v-model:value="stopState" :options="['正常开放', '停用隔离'].map((value) => ({ label: value, value }))" /></label>
      </div>

      <h3>逐项检验结果</h3>
      <NDataTable :columns="columns" :data="items" :bordered="false" size="small" />

      <div class="evidence-panel">
        <div><strong>现场证据</strong><span>{{ record.evidenceCount }} 张照片 · 最近上传 09:31</span></div>
        <div class="evidence-list"><span>锁止间隙近景</span><span>设备铭牌</span><span>制动测试仪表</span><button @click="record.evidenceCount += 1; message.success('已模拟上传现场照片')">上传照片</button></div>
      </div>
    </div>

    <aside class="detail-side">
      <div>
        <span class="side-label">当前流程</span>
        <strong>{{ record.status }}</strong>
        <small>版本 V{{ record.version }} · 合并基线 V{{ record.baselineVersion }} · 更新于 {{ record.updatedAt.replace('T', ' ').slice(0, 16) }}</small>
        <small v-if="device?.mergeLocked" style="color:#b47a1c">设备合并锁定中，值班长确认前不能恢复开放</small>
      </div>
      <div class="flow-list">
        <button v-for="status in transitions" :key="status" :class="{ active: status === record.status }" @click="changeStatus(status)">
          <span>{{ status }}</span><small>{{ status === record.status ? '当前状态' : '执行流转' }}</small>
        </button>
      </div>
      <div class="rule-note">
        <strong>闭环校验</strong>
        <p>异常项存在时禁止关闭；紧急风险必须先停用设备。所有操作均写入审计。</p>
      </div>
      <NButton block @click="router.push('/audit')">查看完整审计</NButton>
    </aside>
  </section>
  <section v-else class="content empty-state">未找到检验记录</section>
</template>
