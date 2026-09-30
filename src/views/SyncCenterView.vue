<script setup lang="ts">
import { reactive, ref } from 'vue'
import { NButton, NRadioGroup, NRadio, NTag, useMessage } from 'naive-ui'
import { useInspectionStore } from '../stores/inspection'
import { scenarios } from '../services/scenarios'
import { armNextWriteFailure, isTextField } from '../services/sync'
import type { BatchStatus, SyncBatch } from '../types'

const store = useInspectionStore()
const message = useMessage()
const writing = ref<string>('')

// 冲突裁决选择：batchId -> `${entityType}:${entityId}:${path}` -> resolution
const choices = reactive<Record<string, Record<string, string>>>({})

const statusType: Record<BatchStatus, 'default' | 'warning' | 'info' | 'error' | 'success'> = {
  待合并: 'warning',
  待值班长确认: 'error',
  已确认待写入: 'info',
  写入失败: 'error',
  已拦截: 'error',
  已放行: 'success'
}

function ownerOf(batch: SyncBatch, path: string) {
  const change = batch.changes.find((item) => item.path === path)
  return change ? `${change.entityType}:${change.entityId}` : ''
}
function choiceKey(batch: SyncBatch, path: string) {
  return `${ownerOf(batch, path)}:${path}`
}
function choice(batchId: string, key: string, fallback?: string) {
  return choices[batchId]?.[key] ?? fallback ?? ''
}
function setChoice(batchId: string, key: string, value: string) {
  if (!choices[batchId]) choices[batchId] = {}
  choices[batchId]![key] = value
}

function canConfirm(batch: SyncBatch) {
  // 枚举字段冲突必须二选一；文本字段默认并列保留
  return (batch.conflicts ?? []).every((conflict) => {
    if (isTextField(conflict.path)) return true
    return choice(batch.id, choiceKey(batch, conflict.path), conflict.resolution) !== ''
  })
}

function stage(id: string) {
  const result = store.stageBatch(id)
  result.ok ? message.success(result.message) : message.warning(result.message)
}

function merge(batch: SyncBatch) {
  const result = store.uploadAndMerge(batch.id)
  result.ok ? message.success(result.message) : result.message.includes('不能重放') ? message.error(result.message) : message.warning(result.message)
}

function attemptReplay(batch: SyncBatch) {
  try {
    const result = store.replayBatch(batch.id)
    message.info(result.message)
  } catch (error) {
    message.error(error instanceof Error ? error.message : '重放被拒绝')
  }
}

function confirm(batch: SyncBatch) {
  const resolutionList = (batch.conflicts ?? []).map((conflict) => {
    const entityKey = ownerOf(batch, conflict.path)
    const fallback = isTextField(conflict.path) ? '并列保留' : ''
    return {
      path: conflict.path,
      entityKey,
      resolution: (choice(batch.id, choiceKey(batch, conflict.path), fallback) || fallback) as '并列保留' | '采用采集端' | '采用值班室'
    }
  })
  const result = store.confirmBatch(batch.id, resolutionList)
  result.ok ? message.success(result.message) : message.error(result.message)
}

async function writeBatch(batch: SyncBatch) {
  writing.value = batch.id
  try {
    const result = await store.writeReleases(batch.id)
    result.ok ? message.success(result.message) : message.error(result.message)
  } finally {
    writing.value = ''
  }
}

function retry(batch: SyncBatch) {
  const result = store.retryFailedBatch(batch.id)
  if (result.ok) void writeBatch(batch)
  else message.warning(result.message)
}

function armFailure() {
  message.warning(armNextWriteFailure())
}

function toggleDevice(deviceId: string, open: boolean) {
  const result = store.setDeviceOpen(deviceId, open, open ? '值班室现场确认后重开' : '值班室执行停用隔离')
  result.ok ? message.success(result.message) : message.error(result.message)
}

const batchReleases = (batch: SyncBatch) => store.releases.filter((item) => batch.releaseIds.includes(item.id))
const scenarioOf = (batch: SyncBatch) => scenarios.find((spec) => batch.id.startsWith(spec.id))
</script>

<template>
  <section class="content sync-center">
    <div class="sync-intro">
      <div>
        <h2>断网补录 · 回网合并 · 放行闭环</h2>
        <p>补传批次携带采集时刻与基线快照；同一字段两端都改过则并列保留；值班长确认前设备锁定；复测通过才可关闭缺陷并放行；放行按批写入，失败只重试这批，已确认批次不可重放。</p>
      </div>
      <div class="sync-tools">
        <NButton size="small" tertiary @click="armFailure">安排下一批写入失败</NButton>
        <NButton size="small" tertiary @click="store.resetDemo()">恢复演示数据</NButton>
      </div>
    </div>

    <!-- 场景发起 -->
    <div class="scenario-grid">
      <article v-for="spec in scenarios" :key="spec.id" class="scenario-card">
        <header>
          <strong>{{ spec.title }}</strong>
          <small>{{ spec.id }}</small>
        </header>
        <p>{{ spec.description }}</p>
        <dl>
          <div><dt>采集时刻</dt><dd>{{ spec.collectedAt.replace('T', ' ').slice(5, 16) }}</dd></div>
          <div><dt>回网时刻</dt><dd>{{ spec.uploadedAt.replace('T', ' ').slice(5, 16) }}</dd></div>
          <div><dt>检验员</dt><dd>{{ spec.inspector }}</dd></div>
        </dl>
        <NButton type="primary" size="small" block @click="stage(spec.id)">断网暂存补录（带回传基线）</NButton>
      </article>
    </div>

    <!-- 批次流水线 -->
    <h3 class="block-title">补传批次流水线</h3>
    <div v-if="!store.batches.length" class="empty-line">暂无补传批次，从上方场景发起一次断网补录</div>

    <article v-for="batch in store.batches" :key="batch.id" class="batch-card">
      <header class="batch-head">
        <div>
          <strong>{{ batch.id }}</strong>
          <span class="muted">{{ scenarioOf(batch)?.title }}</span>
        </div>
        <NTag :type="statusType[batch.status]" :bordered="false">{{ batch.status }}{{ batch.replayBlocked ? ' · 已拦截重放' : '' }}</NTag>
      </header>

      <div class="batch-meta">
        <span>检验员：{{ batch.inspector }}</span>
        <span>采集时刻：{{ batch.collectedAt.replace('T', ' ').slice(0, 16) }}</span>
        <span>回网时刻：{{ batch.uploadedAt.replace('T', ' ').slice(0, 16) }}</span>
        <span>基线：{{ batch.baselines.map((b) => `${b.entityType === 'device' ? '设备' : b.entityType === 'defect' ? '缺陷' : '记录'} ${b.entityId}@R${b.rev}`).join('，') }}</span>
        <span v-if="batch.confirmedBy">确认人：{{ batch.confirmedBy }} @ {{ batch.confirmedAt?.replace('T', ' ').slice(5, 16) }}</span>
      </div>

      <!-- 合并报告 -->
      <ul v-if="batch.mergeReport?.length" class="merge-report">
        <li v-for="(line, index) in batch.mergeReport" :key="index">{{ line }}</li>
      </ul>

      <!-- 冲突裁决 -->
      <div v-if="batch.status === '待值班长确认'" class="conflict-box">
        <h4>并列保留的字段冲突（{{ batch.conflicts?.length ?? 0 }}）— 值班长逐项裁决后才能确认</h4>
        <table class="conflict-table">
          <thead><tr><th style="width:150px">字段</th><th style="width:130px">基线</th><th style="width:170px">采集端（补传）</th><th style="width:170px">值班室（并发）</th><th>裁决</th></tr></thead>
          <tbody>
            <tr v-for="conflict in batch.conflicts" :key="conflict.path">
              <td>{{ conflict.label }}</td>
              <td class="muted">{{ conflict.baseValue || '—' }}</td>
              <td>{{ conflict.offlineValue }}</td>
              <td>{{ conflict.dutyValue }}</td>
              <td>
                <NRadioGroup
                  :value="choice(batch.id, choiceKey(batch, conflict.path), conflict.resolution)"
                  @update:value="(value: string) => setChoice(batch.id, choiceKey(batch, conflict.path), value)"
                >
                  <NRadio v-if="isTextField(conflict.path)" value="并列保留">并列保留</NRadio>
                  <NRadio value="采用采集端">采用采集端</NRadio>
                  <NRadio value="采用值班室">采用值班室</NRadio>
                </NRadioGroup>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="batch-actions">
          <NButton type="primary" size="small" :disabled="!canConfirm(batch)" @click="confirm(batch)">
            值班长确认（复测通过才关缺陷/放行，否则设备继续停用）
          </NButton>
          <span v-if="!canConfirm(batch)" class="muted">枚举字段冲突必须先二选一</span>
        </div>
      </div>

      <!-- 放行记录 -->
      <div v-if="batchReleases(batch).length" class="release-box">
        <h4>本批放行记录（写入失败只重试这批）</h4>
        <div v-for="release in batchReleases(batch)" :key="release.id" class="release-row">
          <NTag size="small" :type="release.state === '写入成功' ? 'success' : release.state === '写入失败' ? 'error' : 'warning'" :bordered="false">{{ release.state }}</NTag>
          <strong>{{ release.deviceName }}</strong>
          <span class="muted">{{ release.id }}</span>
          <span class="muted">尝试 {{ release.attempts }} 次</span>
          <span v-if="release.lastError" class="error-text">{{ release.lastError }}</span>
          <span v-if="release.writtenAt" class="muted">写入于 {{ release.writtenAt.replace('T', ' ').slice(5, 16) }}</span>
        </div>
      </div>

      <footer class="batch-actions">
        <template v-if="batch.status === '待合并'">
          <NButton type="primary" size="small" @click="merge(batch)">回网补传并三方合并</NButton>
          <NButton size="small" tertiary @click="attemptReplay(batch)">尝试重放（防重放校验）</NButton>
        </template>
        <template v-else-if="batch.status === '已确认待写入'">
          <NButton type="primary" size="small" :loading="writing === batch.id" @click="writeBatch(batch)">写入本批放行</NButton>
        </template>
        <template v-else-if="batch.status === '写入失败'">
          <NButton type="error" size="small" :loading="writing === batch.id" @click="retry(batch)">只重试这批</NButton>
          <span class="muted">其他批次不受影响</span>
        </template>
        <template v-else>
          <NButton size="small" tertiary @click="attemptReplay(batch)">尝试重放（应被拒绝）</NButton>
          <span v-if="batch.status === '已放行'" class="muted">终态：已确认批次不可重放</span>
          <span v-else-if="batch.status === '已拦截'" class="error-text">终态：复测未通过，不放行，设备继续停用</span>
        </template>
      </footer>
    </article>

    <!-- 值班室设备控制 -->
    <h3 class="block-title">值班室设备开放控制</h3>
    <div class="device-grid">
      <article v-for="device in store.devices" :key="device.id" class="device-card">
        <header>
          <strong>{{ device.name }} <small>{{ device.code }}</small></strong>
          <NTag size="small" :type="device.openState === '开放' ? 'success' : 'error'" :bordered="false">
            {{ device.reopenLocked ? '合并锁定·停用' : device.openState }}
          </NTag>
        </header>
        <p class="muted">{{ device.openNote }}</p>
        <div class="device-actions">
          <NButton size="tiny" :disabled="device.openState === '开放'" @click="toggleDevice(device.id, true)">值班室重开</NButton>
          <NButton size="tiny" tertiary :disabled="device.openState === '停用'" @click="toggleDevice(device.id, false)">停用隔离</NButton>
        </div>
        <small class="muted">R{{ device.rev }} · 未关闭缺陷 {{ store.defects.filter((d) => d.deviceId === device.id && d.status !== '已关闭').length }} 项</small>
      </article>
    </div>
  </section>
</template>
