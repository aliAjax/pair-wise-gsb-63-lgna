<script setup lang="ts">
import { computed, h, reactive, ref, watch } from 'vue'
import {
  NAlert, NButton, NCheckbox, NDataTable, NDatePicker, NInput, NSelect, NSwitch, NTag, useMessage
} from 'naive-ui'
import { useInspectionStore } from '../stores/inspection'
import { FIELD_LABELS } from '../services/sync'
import ConflictResolver from '../components/ConflictResolver.vue'
import type { CheckResult } from '../types'

const store = useInspectionStore()
const message = useMessage()
function notify(result: { ok: boolean; message: string }) {
  result.ok ? message.success(result.message) : message.error(result.message)
}

/* ---------------- 值班室设备操作 ---------------- */
const deviceColumns = [
  { title: '设备', key: 'code', width: 190, render: (row: any) => `${row.name} / ${row.code}` },
  { title: '区域', key: 'area', width: 90 },
  {
    title: '开放状态', key: 'open', width: 105,
    render: (row: any) => h(NTag, { type: row.open ? 'success' : 'error', bordered: false }, { default: () => row.open ? '正常开放' : '停用隔离' })
  },
  {
    title: '合并锁定', key: 'mergeLocked', width: 100,
    render: (row: any) => row.mergeLocked
      ? h(NTag, { type: 'warning', bordered: false }, { default: () => '锁定中' })
      : h('span', { style: 'color:#9aa8a5' }, '—')
  },
  { title: '值班室最近操作', key: 'lastDutyAction' },
  { title: '依据版本', key: 'operatedFromVersion', width: 90, render: (row: any) => `V${row.operatedFromVersion}` },
  {
    title: '', key: 'actions', width: 178,
    render: (row: any) => h('div', { style: 'display:flex;gap:6px' }, [
      h(NButton, {
        size: 'small', type: 'primary', tertiary: true, disabled: row.open || row.mergeLocked,
        title: row.mergeLocked ? '待值班长确认，不能恢复开放' : '',
        onClick: () => notify(store.dutySetDeviceOpen(row.code, true))
      }, { default: () => '恢复开放' }),
      h(NButton, {
        size: 'small', type: 'error', tertiary: true, disabled: !row.open,
        onClick: () => notify(store.dutySetDeviceOpen(row.code, false))
      }, { default: () => '停用隔离' })
    ])
  }
]

/* ---------------- 断网补录批次 ---------------- */
const recordOptions = computed(() => store.records.map((record) => ({
  label: `${record.deviceName} / ${record.deviceCode}（${record.id} · V${record.version}）`,
  value: record.id
})))

const selectedRecordId = ref(store.records[0]?.id ?? '')
const selectedRecord = computed(() => store.records.find((record) => record.id === selectedRecordId.value))
const offlineInspector = ref('周宁')
const collectedAt = ref(Date.now() - 1000 * 60 * 90)

interface ChangeRow { field: string; enabled: boolean; value: string }
const changeRows = reactive<Record<string, ChangeRow>>({})
const retestFlags = reactive<Record<string, boolean>>({})

function fieldOptions(record: NonNullable<typeof selectedRecord.value>) {
  const scalar = ['assignedTo', 'risk', 'dueDate'].map((field) => ({
    label: FIELD_LABELS[field], value: field, kind: 'scalar'
  }))
  const itemResults = record.items.map((item) => ({
    label: `${item.name}·检验结果`, value: `item:${item.id}.result`, kind: 'result'
  }))
  return [...scalar, ...itemResults]
}

watch(selectedRecord, () => {
  for (const key of Object.keys(changeRows)) delete changeRows[key]
  for (const key of Object.keys(retestFlags)) delete retestFlags[key]
  ensureRows()
}, { immediate: true })

function ensureRows() {
  const record = selectedRecord.value
  if (!record) return
  for (const option of fieldOptions(record)) {
    if (changeRows[option.value]) continue
    const value = option.kind === 'scalar'
      ? String((record as unknown as Record<string, string>)[option.value])
      : record.items.find((item) => item.id === option.value.split(':')[1].split('.')[0])?.result ?? ''
    changeRows[option.value] = { field: option.value, enabled: false, value }
  }
  for (const item of record.items) {
    if (retestFlags[item.id] === undefined) retestFlags[item.id] = false
  }
}

function queueBatch() {
  const record = selectedRecord.value
  if (!record) return
  const changes: Record<string, string> = {}
  for (const row of Object.values(changeRows)) {
    if (row.enabled) changes[row.field] = row.value
  }
  const retest: Record<string, CheckResult> = {}
  for (const item of record.items) {
    if (retestFlags[item.id]) retest[item.id] = '正常'
  }
  const collected = new Date(collectedAt.value)
  const stamp = new Date(collected.getTime() - collected.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  const batch = store.queueBatch({
    recordId: record.id,
    inspector: offlineInspector.value,
    collectedAt: stamp,
    changes,
    retest: Object.keys(retest).length ? retest : undefined
  })
  message.success(`补录批次 ${batch.id.slice(-6)} 已暂存（采集于 ${stamp.replace('T', ' ')}），等待回网`)
}

/* ---------------- 值班室并行处置 ---------------- */
const dutyAssignee = reactive<Record<string, string>>({})
function amendAssignee(recordId: string) {
  const value = dutyAssignee[recordId]
  if (!value) return message.warning('请先填写值班室要改派的责任人')
  notify(store.dutyAmend(recordId, { assignedTo: value }))
}

/* ---------------- 合并 / 裁决 / 确认 / 重试 ---------------- */
function batchRecord(batchId: string) {
  const batch = store.batches.find((item) => item.id === batchId)
  return store.records.find((record) => record.deviceCode === batch?.deviceCode)
}
function resolve(batchId: string, field: string, resolution: 'offline' | 'online') {
  const record = batchRecord(batchId)
  if (record) notify(store.resolveConflict(record.id, field, resolution))
}

const statusTagType: Record<string, 'default' | 'warning' | 'success'> = {
  待确认: 'default', 已合并: 'warning', 已确认: 'success'
}
</script>

<template>
  <section class="content sync-layout">
    <NAlert v-if="store.migrationNotice" type="success" :show-icon="true" class="migrate-banner" title="旧数据迁移完成">
      {{ store.migrationNotice }}
    </NAlert>

    <div class="metric-strip">
      <article><span>待确认补录批次</span><strong>{{ store.stats.pendingBatches }}</strong><small>回网后需值班长确认</small></article>
      <article><span>并列字段冲突</span><strong>{{ store.stats.pendingConflicts }}</strong><small>两边都改过，待裁决</small></article>
      <article><span>放行写入失败</span><strong>{{ store.stats.failedReleases }}</strong><small>仅失败批次需重试</small></article>
      <article><span>未闭环缺陷（有效版本）</span><strong>{{ store.stats.openDefects }}</strong><small>复测通过才能关闭</small></article>
    </div>

    <div class="sync-card">
      <div class="sync-head">
        <h2>设备状态与合并锁定</h2>
        <p>值班室在检验员断网期间可重开设备或停用隔离；回网合并后设备锁定，<b>值班长确认前不能恢复开放</b>。</p>
      </div>
      <NDataTable :columns="deviceColumns" :data="store.devices" :bordered="false" size="small" />
    </div>

    <div class="sync-grid">
      <div class="sync-card">
        <div class="sync-head">
          <h2>检验员断网补录</h2>
          <p>补传批次冻结现场采集时刻与离线基线，回网时按基线做字段级三路合并。</p>
        </div>
        <div class="batch-form">
          <label class="full">检验记录
            <NSelect v-model:value="selectedRecordId" :options="recordOptions" size="small" />
          </label>
          <label>检验员 <NInput v-model:value="offlineInspector" size="small" /></label>
          <label>现场采集时刻
            <NDatePicker v-model:value="collectedAt" type="datetime" size="small" style="width:100%" />
          </label>

          <template v-if="selectedRecord">
            <strong class="block-title">断网期间改动的字段（勾选即纳入补传）</strong>
            <div v-for="option in fieldOptions(selectedRecord)" :key="option.value" class="change-row">
              <NCheckbox v-model:checked="changeRows[option.value].enabled">{{ option.label }}</NCheckbox>
              <NSelect
                v-if="option.kind === 'result'"
                v-model:value="changeRows[option.value].value"
                :options="['正常', '异常', '不适用'].map((value) => ({ label: value, value }))"
                size="small" :disabled="!changeRows[option.value].enabled"
              />
              <NSelect
                v-else-if="option.value === 'risk'"
                v-model:value="changeRows[option.value].value"
                :options="['低', '中', '高', '紧急'].map((value) => ({ label: value, value }))"
                size="small" :disabled="!changeRows[option.value].enabled"
              />
              <NInput v-else v-model:value="changeRows[option.value].value" size="small" :disabled="!changeRows[option.value].enabled" />
            </div>

            <strong class="block-title">复测登记（本批为现场复测）</strong>
            <div v-for="item in selectedRecord.items" :key="item.id" class="change-row">
              <NCheckbox v-model:checked="retestFlags[item.id]">
                {{ item.name }} 复测合格（{{ item.result }} → 正常）
              </NCheckbox>
            </div>

            <NButton type="primary" block @click="queueBatch">暂存补录批次（模拟断网采集）</NButton>
          </template>
        </div>
      </div>

      <div class="sync-card">
        <div class="sync-head">
          <h2>值班室并行处置</h2>
          <p>模拟断网期间值班室重开设备、改派责任人或登记复测；回网后与补录三方对账。</p>
        </div>
        <div class="duty-list">
          <div v-for="record in store.records" :key="record.id" class="duty-item">
            <header>
              <strong>{{ record.deviceName }}</strong>
              <NTag size="small" :bordered="false">{{ record.id }} · V{{ record.version }}</NTag>
            </header>
            <div class="duty-actions">
              <NButton size="tiny" @click="notify(store.dutySetDeviceOpen(record.deviceCode, true))">重开设备</NButton>
              <NButton size="tiny" type="error" tertiary @click="notify(store.dutySetDeviceOpen(record.deviceCode, false))">停用隔离</NButton>
              <span class="amend">
                <NInput v-model:value="dutyAssignee[record.id]" size="tiny" placeholder="值班室改派责任人" />
                <NButton size="tiny" tertiary @click="amendAssignee(record.id)">改派</NButton>
              </span>
            </div>
            <div v-for="defect in store.defects.filter((d) => d.recordId === record.id && d.active)" :key="defect.id" class="defect-line">
              <NTag size="small" :type="defect.status === '已关闭' ? 'success' : defect.status === '复测通过' ? 'info' : 'warning'" :bordered="false">
                {{ defect.title }} · {{ defect.status }}
              </NTag>
              <span class="defect-buttons">
                <NButton size="tiny" tertiary @click="notify(store.dutyRecordRetest(defect.id, true))">复测合格</NButton>
                <NButton size="tiny" tertiary @click="notify(store.dutyRecordRetest(defect.id, false))">复测不合格</NButton>
                <NButton size="tiny" type="primary" tertiary :disabled="defect.status === '已关闭'" @click="notify(store.dutyCloseDefect(defect.id))">关闭缺陷</NButton>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="sync-card">
      <div class="sync-head">
        <div>
          <h2>回网补传批次</h2>
          <p>同一字段两边都改过则并列保留；值班长裁尽冲突并确认后设备才解除锁定；<b>已确认批次不可重放</b>。</p>
        </div>
        <label class="fail-switch">
          <span>模拟下一批放行写入失败</span>
          <NSwitch v-model:value="store.forceNextReleaseFail" size="small" />
        </label>
      </div>

      <div v-if="!store.batches.length" class="kanban-empty">暂无补传批次 —— 先在左上方“断网补录”中暂存一批</div>

      <div v-for="batch in store.batches" :key="batch.id" class="batch-card">
        <header>
          <div class="batch-title">
            <strong>{{ batch.id }}</strong>
            <NTag :type="statusTagType[batch.status]" size="small" :bordered="false">{{ batch.status }}</NTag>
            <NTag v-if="batch.retest" size="small" type="info" :bordered="false">含复测</NTag>
          </div>
          <small>
            设备 {{ batch.deviceCode }} · 采集于 {{ batch.collectedAt.replace('T', ' ') }}
            · 基线 V{{ batch.baselineVersion }} · 检验员 {{ batch.inspector }}
          </small>
        </header>

        <div v-if="batch.status === '待确认'" class="batch-actions">
          <NButton size="small" type="primary" @click="notify(store.mergeBatch(batch.id))">回网并三路合并</NButton>
          <span>合并后设备进入“待值班长确认”锁定</span>
        </div>

        <template v-else>
          <div v-if="batch.conflictFields.length" class="conflict-panel">
            <strong>并列保留的字段冲突（必须逐条裁决后才能确认）</strong>
            <div v-for="field in batch.conflictFields" :key="field" class="conflict-row">
              <ConflictResolver :batch-id="batch.id" :field="field" @resolve="resolve" />
            </div>
          </div>
          <div v-else class="no-conflict">无字段冲突，合并值可直接确认。</div>

          <div v-if="batch.releaseId && store.releases.find((r) => r.id === batch.releaseId)?.status === '写入失败'" class="release-fail">
            <NAlert type="error" :show-icon="false">
              放行单写入失败（已尝试 {{ store.releases.find((r) => r.id === batch.releaseId)?.attempts }} 次），设备保持锁定。
              失败只影响本批，其他批次不受影响：
              <NButton size="tiny" type="error" style="margin-left:8px" @click="notify(store.retryRelease(batch.id))">仅重试本批放行</NButton>
            </NAlert>
          </div>

          <div v-if="batch.status === '已合并'" class="batch-actions">
            <NButton size="small" type="primary" @click="notify(store.confirmBatch(batch.id))">值班长确认并放行</NButton>
            <span>复测通过才关闭缺陷并恢复开放；确认后本批不可重放</span>
          </div>
          <div v-else class="confirmed-line">
            已于 {{ batch.confirmedAt?.replace('T', ' ').slice(0, 16) }} 由 {{ batch.confirmedBy }} 确认，设备锁定解除
            <NButton size="tiny" tertiary style="margin-left:8px" disabled>禁止重放</NButton>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>
