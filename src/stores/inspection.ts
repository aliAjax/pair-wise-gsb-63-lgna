import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { seedAudit, seedDefects, seedDevices, seedRecords, seedReleases } from '../data/seed'
import { createOfflineInspection } from '../services/api'
import {
  batchConfirmable, FIELD_LABELS, flattenRecord, migratePersisted, resolveConflictValue, threeWayMerge,
  type MergeOutcome
} from '../services/sync'
import { SCHEMA_VERSION } from '../services/sync'
import type {
  AuditEntry, CheckResult, Defect, InspectionDraft, InspectionRecord, InspectionStatus,
  PersistedState, ReleaseRecord, SyncBatch
} from '../types'

const STORAGE_KEY = 'gsb63:inspection-platform-v2'
const LEGACY_KEY = 'gsb63:inspection-platform'

function readPersisted(): { state: PersistedState; migrated: boolean } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const result = migratePersisted(JSON.parse(raw))
      return { state: result.state, migrated: false }
    }
    // 旧数据首次打开：从 v1 键读取并迁移，保留原结论
    const legacy = localStorage.getItem(LEGACY_KEY)
    if (legacy) {
      const result = migratePersisted(JSON.parse(legacy))
      return { state: result.state, migrated: result.migrated }
    }
    return {
      state: {
        schemaVersion: SCHEMA_VERSION,
        records: structuredClone(seedRecords),
        devices: structuredClone(seedDevices),
        defects: structuredClone(seedDefects),
        releases: structuredClone(seedReleases),
        batches: [],
        audit: structuredClone(seedAudit)
      },
      migrated: false
    }
  } catch {
    return {
      state: {
        schemaVersion: SCHEMA_VERSION,
        records: structuredClone(seedRecords),
        devices: structuredClone(seedDevices),
        defects: structuredClone(seedDefects),
        releases: structuredClone(seedReleases),
        batches: [],
        audit: structuredClone(seedAudit)
      },
      migrated: false
    }
  }
}

interface ActionResult {
  ok: boolean
  message: string
}

let seq = 0
function uniqueId(prefix: string) {
  seq += 1
  return `${prefix}-${Date.now().toString(36)}-${seq}`
}

export const useInspectionStore = defineStore('inspection', () => {
  const initial = readPersisted()
  const records = ref<InspectionRecord[]>(initial.state.records)
  const devices = ref(initial.state.devices)
  const defects = ref<Defect[]>(initial.state.defects)
  const releases = ref<ReleaseRecord[]>(initial.state.releases)
  const batches = ref<SyncBatch[]>(initial.state.batches)
  const audit = ref<AuditEntry[]>(initial.state.audit)
  const migrationNotice = ref(initial.migrated ? '旧数据已完成首次迁移：基线与设备/缺陷档案已补齐，原结论保留' : '')

  const keyword = ref('')
  const status = ref<InspectionStatus | '全部'>('全部')
  const area = ref('全部')
  const liveMessage = ref('本地实时通道已就绪')
  /** 演示开关：下一批放行写入强制失败，用于验证“失败仅重试该批” */
  const forceNextReleaseFail = ref(false)

  const filtered = computed(() => records.value.filter((record) => {
    const haystack = `${record.id} ${record.deviceCode} ${record.deviceName} ${record.inspector} ${record.assignedTo}`.toLowerCase()
    return (!keyword.value || haystack.includes(keyword.value.toLowerCase()))
      && (status.value === '全部' || record.status === status.value)
      && (area.value === '全部' || record.area === area.value)
  }))

  function activeDefectsFor(recordId: string) {
    return defects.value.filter((defect) => defect.recordId === recordId && defect.active)
  }

  /** 合并/复测后重算缺陷状态：已关闭的缺陷若对应检验项再次异常则重新打开 */
  function reconcileDefects(record: InspectionRecord, retestPassed: boolean) {
    const linked = activeDefectsFor(record.id)
    for (const defect of linked) {
      const item = record.items.find((candidate) => candidate.id === defect.itemId)
      const unresolvedConflict = record.conflicts.some(
        (conflict) => !conflict.resolved && conflict.field === `item:${defect.itemId}.result`
      )
      if (unresolvedConflict) continue
      if (item?.result === '异常') {
        if (defect.status === '已关闭') {
          defect.status = '开放'
          defect.closedAt = undefined
          defect.retestPassed = false
          defect.releasedByBatch = undefined
          addAudit(record.id, '缺陷重新打开', '系统合并', `合并结果显示「${defect.title}」仍为异常，原关闭结论撤销`, '缺陷', record.version)
        }
      } else if (item && item.result !== '不适用') {
        if (retestPassed && (defect.status === '待复测' || defect.status === '复测通过' || defect.status === '整改中' || defect.status === '开放')) {
          defect.status = '复测通过'
          defect.retestPassed = true
          defect.retestRecordId = record.lastBatchId ? record.id : defect.retestRecordId
        }
      }
    }
  }

  const stats = computed(() => ({
    total: records.value.length,
    blocked: devices.value.filter((device) => !device.open).length,
    overdue: records.value.filter((item) => item.dueDate < '2026-09-30' && !['已关闭'].includes(item.status)).length,
    closed: defects.value.filter((item) => item.active && item.status === '已关闭').length,
    // 待办只按当前有效版本统计：未裁决冲突、待确认批次、失败放行、未闭环缺陷
    pendingConflicts: records.value.reduce((sum, record) => sum + record.conflicts.filter((conflict) => !conflict.resolved).length, 0),
    pendingBatches: batches.value.filter((batch) => batch.status !== '已确认').length,
    failedReleases: releases.value.filter((release) => release.status === '写入失败').length,
    openDefects: defects.value.filter((defect) => defect.active && defect.status !== '已关闭').length
  }))

  /** 审计统计只取当前有效版本：active 且版本号等于记录当前版本（迁移全局条目除外） */
  const effectiveAudit = computed(() => audit.value.filter((entry) => {
    if (!entry.active) return false
    if (entry.recordId === '*') return true
    const record = records.value.find((item) => item.id === entry.recordId)
    return !record || entry.version === record.version
  }))

  function addAudit(recordId: string, action: string, operator: string, detail: string, category: AuditEntry['category'] = '检验', version?: number) {
    const record = records.value.find((item) => item.id === recordId)
    audit.value.unshift({
      id: uniqueId(`A-${recordId}`),
      recordId,
      action,
      operator,
      detail,
      createdAt: new Date().toISOString(),
      version: version ?? record?.version ?? 1,
      active: true,
      category
    })
  }

  function addRecord(draft: InspectionDraft) {
    const record = createOfflineInspection(draft)
    records.value.unshift(record)
    if (!devices.value.some((device) => device.code === record.deviceCode)) {
      devices.value.push({
        code: record.deviceCode, name: record.deviceName, area: record.area, open: true,
        operatedFromVersion: 1, mergeLocked: false, lastDutyAction: '新建设备档案', updatedAt: record.createdAt
      })
    }
    addAudit(record.id, '创建检验记录', draft.inspector, '新建设备班次检验任务', '检验', 1)
    return record
  }

  function updateRecord(id: string, patch: Partial<InspectionRecord>, action = '保存检验记录') {
    const record = records.value.find((item) => item.id === id)
    if (!record) return
    Object.assign(record, patch, { version: record.version + 1, updatedAt: new Date().toISOString() })
    addAudit(id, action, '当前用户', `记录更新至版本 V${record.version}`)
  }

  function transition(id: string, next: InspectionStatus, detail: string): ActionResult {
    const record = records.value.find((item) => item.id === id)
    if (!record) return { ok: false, message: '记录不存在' }
    if (next === '已关闭' && record.items.some((item) => item.result === '异常')) {
      return { ok: false, message: '仍有异常项，复测未通过，不能关闭任务' }
    }
    if (next === '待复测' && !record.stopped && record.risk === '紧急') {
      return { ok: false, message: '紧急风险缺陷必须先执行停用' }
    }
    record.status = next
    record.version += 1
    record.updatedAt = new Date().toISOString()
    addAudit(id, `状态流转：${next}`, '当前用户', detail, '检验', record.version)
    return { ok: true, message: `已流转至${next}` }
  }

  /** 值班室操作设备：合并锁定期间禁止恢复开放，但安全停用始终允许 */
  function dutySetDeviceOpen(code: string, open: boolean, operator = '值班长'): ActionResult {
    const device = devices.value.find((item) => item.code === code)
    if (!device) return { ok: false, message: '设备不存在' }
    if (open && device.mergeLocked) {
      return { ok: false, message: '该设备存在待值班长确认的补录合并，确认前不能恢复开放' }
    }
    device.open = open
    device.operatedFromVersion = records.value.find((record) => record.deviceCode === code)?.version ?? device.operatedFromVersion
    device.lastDutyAction = open ? '值班室已重开设备' : '值班室执行停用隔离'
    device.updatedAt = new Date().toISOString()
    const record = records.value.find((item) => item.deviceCode === code)
    if (record && record.stopped === open) {
      record.stopped = !open
      record.version += 1
      record.updatedAt = device.updatedAt
      addAudit(record.id, open ? '值班室重开设备' : '值班室停用设备', operator, open ? '断网期间值班室将设备恢复开放' : '值班室执行停用隔离', '设备', record.version)
    }
    return { ok: true, message: open ? '设备已恢复开放' : '设备已停用隔离' }
  }

  /** 值班室依据自己掌握的复测情况关闭缺陷；若与补录结果冲突，合并阶段会并列保留并可能重新打开 */
  function dutyCloseDefect(defectId: string, operator = '值班长'): ActionResult {
    const defect = defects.value.find((item) => item.id === defectId && item.active)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    if (defect.status === '已关闭') return { ok: false, message: '缺陷已关闭' }
    if (!defect.retestPassed) {
      return { ok: false, message: '复测未通过，不能关闭缺陷' }
    }
    defect.status = '已关闭'
    defect.closedAt = new Date().toISOString()
    const record = records.value.find((item) => item.id === defect.recordId)
    if (record) {
      const item = record.items.find((candidate) => candidate.id === defect.itemId)
      if (item && item.result === '异常') item.result = '正常'
      record.version += 1
      record.updatedAt = defect.closedAt
      addAudit(record.id, '值班室关闭缺陷', operator, `值班室复测通过后关闭「${defect.title}」`, '缺陷', record.version)
    }
    return { ok: true, message: `缺陷「${defect.title}」已关闭` }
  }

  /** 值班室在检验员断网期间对记录字段做的在线修改（参与三路合并） */
  function dutyAmend(recordId: string, patch: Partial<Pick<InspectionRecord, 'assignedTo' | 'risk' | 'dueDate'>>, operator = '值班长'): ActionResult {
    const record = records.value.find((item) => item.id === recordId)
    if (!record) return { ok: false, message: '记录不存在' }
    const labels: Array<[string, string]> = []
    for (const [key, value] of Object.entries(patch)) {
      if ((record as Record<string, unknown>)[key] !== value) {
        labels.push([key, String(value)])
      }
    }
    Object.assign(record, patch, { version: record.version + 1, updatedAt: new Date().toISOString() })
    addAudit(recordId, '值班室在线修改', operator, `断网期间值班室修改：${labels.map(([key, value]) => `${FIELD_LABELS[key] ?? key}=${value}`).join('，') || '无变化'}`, '设备', record.version)
    return { ok: true, message: '值班室修改已保存为新版本' }
  }

  /** 值班室登记复测结果（断网期间在线侧的处置） */
  function dutyRecordRetest(defectId: string, passed: boolean, operator = '值班长'): ActionResult {
    const defect = defects.value.find((item) => item.id === defectId && item.active)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    defect.retestPassed = passed
    defect.status = passed ? '复测通过' : '待复测'
    const record = records.value.find((item) => item.id === defect.recordId)
    if (record) {
      const item = record.items.find((candidate) => candidate.id === defect.itemId)
      if (item) item.result = passed ? '正常' : '异常'
      record.version += 1
      record.updatedAt = new Date().toISOString()
      addAudit(record.id, '值班室登记复测', operator, `「${defect.title}」复测${passed ? '合格' : '不合格'}`, '缺陷', record.version)
    }
    return { ok: true, message: passed ? '复测合格，可关闭缺陷' : '复测不合格，缺陷保持开放' }
  }

  /** 检验员断网补录：生成补传批次，冻结采集时刻与基线，先放在本机待回网 */
  function queueBatch(input: {
    recordId: string
    inspector: string
    collectedAt: string
    changes: Record<string, string>
    retest?: Record<string, CheckResult>
  }): SyncBatch {
    const record = records.value.find((item) => item.id === input.recordId)!
    const batch: SyncBatch = {
      id: uniqueId('B'),
      deviceCode: record.deviceCode,
      inspector: input.inspector,
      collectedAt: input.collectedAt,
      uploadedAt: '',
      baselineVersion: record.version,
      baseline: flattenRecord(record),
      changes: input.changes,
      retest: input.retest,
      status: '待确认',
      conflictFields: []
    }
    batches.value.unshift(batch)
    addAudit(record.id, '断网补录已暂存', input.inspector, `采集时刻 ${input.collectedAt.replace('T', ' ')}，基线版本 V${record.version}，等待回网补传`, '合并', record.version)
    return batch
  }

  /** 回网合并：三路合并，冲突并列保留，设备进入合并锁定 */
  function mergeBatch(batchId: string): ActionResult {
    const batch = batches.value.find((item) => item.id === batchId)
    if (!batch) return { ok: false, message: '补传批次不存在' }
    if (batch.status === '已确认') return { ok: false, message: '已确认批次不能重放' }
    if (batch.status === '已合并') return { ok: false, message: '该批次已合并，等待值班长确认' }

    const record = records.value.find((item) => item.deviceCode === batch.deviceCode)
    if (!record) return { ok: false, message: '找不到对应检验记录' }

    const outcome: MergeOutcome = threeWayMerge(record, batch)
    const index = records.value.findIndex((item) => item.id === record.id)
    records.value[index] = outcome.record

    batch.status = '已合并'
    batch.uploadedAt = new Date().toISOString()
    batch.mergedAt = batch.uploadedAt
    batch.conflictFields = outcome.conflicts.map((conflict) => conflict.field)

    const device = devices.value.find((item) => item.code === batch.deviceCode)
    if (device) {
      device.mergeLocked = true
      device.updatedAt = batch.uploadedAt
    }

    const passed = outcome.retestResults.__all__ ?? false
    reconcileDefects(outcome.record, passed)

    addAudit(record.id, '回网三路合并', '系统合并',
      `批次 ${batch.id} 按基线 V${batch.baselineVersion} 合并；采纳字段 ${outcome.changedFields.length} 个，并列冲突 ${outchangeText(outcome)}，设备已锁定待值班长确认`,
      '合并', outcome.record.version)
    if (batch.retest) {
      addAudit(record.id, passed ? '复测通过（待放行）' : '复测未通过', batch.inspector,
        passed ? '补录复测结果显示全部检验项正常，待值班长确认后放行' : '补录复测仍有异常项，禁止关闭缺陷与放行',
        '缺陷', outcome.record.version)
    }
    return {
      ok: true,
      message: outcome.conflicts.length
        ? `合并完成，${outcome.conflicts.length} 个字段两边都改过，已并列保留待裁决`
        : '合并完成，设备已锁定，等待值班长确认'
    }
  }

  /** 值班长裁决并列冲突，选定值即时写回当前版本 */
  function resolveConflict(recordId: string, field: string, resolution: 'offline' | 'online', operator = '值班长'): ActionResult {
    const record = records.value.find((item) => item.id === recordId)
    const batch = batches.value.find((item) => item.deviceCode === record?.deviceCode && item.status === '已合并')
    if (!record || !batch) return { ok: false, message: '没有待裁决的合并批次' }
    const next = resolveConflictValue(record, field, resolution)
    next.conflicts.find((item) => item.field === field)!.resolvedBy = operator
    const index = records.value.findIndex((item) => item.id === recordId)
    records.value[index] = next
    const conflict = next.conflicts.find((item) => item.field === field)
    const passed = !next.items.some((item) => item.result === '异常')
    reconcileDefects(next, passed)
    addAudit(recordId, '裁决字段冲突', operator,
      `「${conflict?.fieldLabel ?? field}」采用${resolution === 'offline' ? '补录值' : '值班室值'}：${resolution === 'offline' ? conflict?.offlineValue : conflict?.onlineValue}`,
      '合并', next.version)
    return { ok: true, message: '冲突已裁决' }
  }

  /** 按批复测放行写入：失败只影响本批，可重试；幂等键保证同一批只放行一次 */
  function writeRelease(batch: SyncBatch): ReleaseRecord {
    const record = records.value.find((item) => item.deviceCode === batch.deviceCode)!
    let release = releases.value.find((item) => item.idempotencyKey === batch.id)
    if (!release) {
      release = {
        id: uniqueId('REL'),
        batchId: batch.id,
        deviceCode: batch.deviceCode,
        defectIds: activeDefectsFor(record.id).map((defect) => defect.id),
        retestRecordId: record.id,
        status: '写入失败',
        attempts: 0,
        idempotencyKey: batch.id
      }
      releases.value.unshift(release)
    }
    if (release.status === '已放行') return release
    release.attempts += 1
    if (forceNextReleaseFail.value) {
      forceNextReleaseFail.value = false
      release.status = '写入失败'
      addAudit(record.id, '放行写入失败', '系统', `批次 ${batch.id} 放行单写入失败（第 ${release.attempts} 次），仅该批需要重试`, '放行', record.version)
      return release
    }
    release.status = '已放行'
    release.releasedAt = new Date().toISOString()
    return release
  }

  /** 值班长确认批次：冲突裁尽 + 复测通过才放行关闭，确认后解锁；已确认批次拒绝重放 */
  function confirmBatch(batchId: string, operator = '值班长'): ActionResult {
    const batch = batches.value.find((item) => item.id === batchId)
    if (!batch) return { ok: false, message: '补传批次不存在' }
    if (batch.status === '已确认') return { ok: false, message: '已确认批次不能重放' }
    if (batch.status !== '已合并') return { ok: false, message: '批次尚未合并' }
    const record = records.value.find((item) => item.deviceCode === batch.deviceCode)
    if (!record) return { ok: false, message: '找不到对应检验记录' }
    if (!batchConfirmable(record, batch)) {
      return { ok: false, message: '仍有并列冲突未裁决，不能确认' }
    }

    const hasRetest = Boolean(batch.retest)
    const retestPassed = !record.items.some((item) => item.result === '异常')
    if (hasRetest && !retestPassed) {
      // 复测未通过：允许确认合并事实，但禁止关闭缺陷与放行，设备保持停用
      finalizeConfirmation(batch, record, operator, false)
      return { ok: true, message: '批次已确认；复测未通过，缺陷保持开放、设备继续停用' }
    }

    if (hasRetest) {
      const release = writeRelease(batch)
      batch.releaseId = release.id
      if (release.status === '写入失败') {
        return { ok: false, message: `第 ${release.attempts} 次放行写入失败，请仅重试本批（设备保持锁定）` }
      }
      // 放行成功：复测通过的缺陷才允许关闭
      for (const defect of activeDefectsFor(record.id)) {
        const item = record.items.find((candidate) => candidate.id === defect.itemId)
        if (item && item.result !== '异常') {
          defect.status = '已关闭'
          defect.closedAt = release.releasedAt
          defect.retestPassed = true
          defect.releasedByBatch = batch.id
        }
      }
      addAudit(record.id, '复测放行', operator, `批次 ${batch.id} 放行单写入成功（第 ${release.attempts} 次尝试），关联缺陷已关闭`, '放行', record.version)
    }

    finalizeConfirmation(batch, record, operator, retestPassed)
    return { ok: true, message: hasRetest ? '批次已确认，复测通过：缺陷关闭、设备恢复开放' : '批次已确认，合并锁定解除' }
  }

  function finalizeConfirmation(batch: SyncBatch, record: InspectionRecord, operator: string, retestPassed: boolean) {
    batch.status = '已确认'
    batch.confirmedAt = new Date().toISOString()
    batch.confirmedBy = operator
    const device = devices.value.find((item) => item.code === batch.deviceCode)
    if (device) {
      device.mergeLocked = false
      // 复测通过放行后恢复开放；纯资料批次按合并后的停用结论执行
      device.open = retestPassed ? true : !record.stopped
      record.stopped = !device.open
      device.operatedFromVersion = record.version
      device.lastDutyAction = retestPassed ? '值班长确认后恢复开放' : '值班长确认，维持停用'
      device.updatedAt = batch.confirmedAt
    }
    addAudit(record.id, '值班长确认批次', operator,
      `批次 ${batch.id} 已确认（采集于 ${batch.collectedAt.replace('T', ' ')}，基线 V${batch.baselineVersion}），合并锁定解除`,
      '合并', record.version)
  }

  /** 某批放行写入失败后只重试这批 */
  function retryRelease(batchId: string): ActionResult {
    const batch = batches.value.find((item) => item.id === batchId)
    if (!batch) return { ok: false, message: '补传批次不存在' }
    if (batch.status === '已确认') return { ok: false, message: '已确认批次不能重放' }
    const release = releases.value.find((item) => item.idempotencyKey === batch.id)
    if (!release) return { ok: false, message: '该批次没有待写入的放行单' }
    if (release.status === '已放行') return { ok: false, message: '该批已放行，无需重试' }
    const result = confirmBatch(batch.id)
    return result
  }

  function resetDemo() {
    records.value = structuredClone(seedRecords)
    devices.value = structuredClone(seedDevices)
    defects.value = structuredClone(seedDefects)
    releases.value = structuredClone(seedReleases)
    batches.value = []
    audit.value = structuredClone(seedAudit)
    migrationNotice.value = ''
  }

  watch([records, devices, defects, releases, batches, audit], () => {
    const state: PersistedState = {
      schemaVersion: SCHEMA_VERSION,
      records: records.value,
      devices: devices.value,
      defects: defects.value,
      releases: releases.value,
      batches: batches.value,
      audit: audit.value
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }, { deep: true })

  return {
    records, devices, defects, releases, batches, audit, migrationNotice,
    keyword, status, area, liveMessage, forceNextReleaseFail,
    filtered, stats, effectiveAudit,
    addRecord, updateRecord, transition,
    dutySetDeviceOpen, dutyAmend, dutyCloseDefect, dutyRecordRetest,
    queueBatch, mergeBatch, resolveConflict, confirmBatch, retryRelease,
    resetDemo
  }
})

function outchangeText(outcome: MergeOutcome): string {
  return outcome.conflicts.length ? `${outcome.conflicts.length} 个` : '0 个'
}
