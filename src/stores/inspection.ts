import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { seedAudit, seedDefects, seedDevices, seedRecords, seedReleases } from '../data/seed'
import { createOfflineInspection } from '../services/api'
import { applyFieldEdits, confirmMerged, mergeBatch, ReplayDeniedError, writeReleaseBatch } from '../services/sync'
import { buildOfflineBatch, scenarios, type ScenarioSpec } from '../services/scenarios'
import type {
  AuditEntry,
  BatchStatus,
  Defect,
  Device,
  InspectionDraft,
  InspectionRecord,
  InspectionStatus,
  ParallelField,
  ReleaseRecord,
  RetestResult,
  SyncBatch
} from '../types'

const STORAGE_KEY = 'gsb63:inspection-platform-v2'
const LEGACY_KEY = 'gsb63:inspection-platform'
const TODAY = '2026-09-30'

interface PersistedState {
  schema: 2
  records: InspectionRecord[]
  devices: Device[]
  defects: Defect[]
  releases: ReleaseRecord[]
  batches: SyncBatch[]
  audit: AuditEntry[]
}

// ---------------------------------------------------------------------------
// 旧数据首次打开迁移：补齐基线、派生出设备/缺陷、保留原结论
// ---------------------------------------------------------------------------

interface LegacyState {
  records: InspectionRecord[]
  audit: AuditEntry[]
}

function isLegacy(raw: unknown): raw is LegacyState & { schema?: number } {
  return !!raw && typeof raw === 'object' && Array.isArray((raw as LegacyState).records) && (raw as { schema?: number }).schema !== 2
}

function migrateLegacy(legacy: LegacyState): PersistedState {
  const now = new Date().toISOString()
  const records: InspectionRecord[] = []
  const devices = new Map<string, Device>()
  const defects: Defect[] = []
  const releases: ReleaseRecord[] = []
  const audit: AuditEntry[] = []

  legacy.records.forEach((record, index) => {
    // 保留原结论；基线补齐为 V1
    const migrated: InspectionRecord = {
      ...record,
      baselineVersion: record.baselineVersion ?? 1,
      deviceId: `DEV-${record.deviceCode}`,
      defectIds: [] as string[]
    }

    const device: Device = devices.get(migrated.deviceId) ?? {
      id: migrated.deviceId,
      code: record.deviceCode,
      name: record.deviceName,
      area: record.area,
      openState: record.stopped ? '停用' : '开放',
      reopenLocked: false,
      openNote: '旧数据迁移派生设备',
      rev: 1,
      baselineRev: 1,
      updatedAt: record.updatedAt,
      recordIds: [],
      defectIds: []
    }

    record.items.filter((item) => item.result === '异常').forEach((item) => {
      const defectId = `DEF-MIG-${String(index + 1).padStart(2, '0')}-${item.id.toUpperCase()}`
      const wasClosed = record.status === '已关闭'
      const defect: Defect = {
        id: defectId,
        deviceId: device.id,
        recordId: record.id,
        title: `${item.name}：${item.note || '检验异常'}`,
        itemId: item.id,
        risk: record.risk,
        // 保留原结论：已闭环记录的异常项视为复测通过后关闭
        status: wasClosed ? '已关闭' : record.status === '待复测' ? '待复测' : '整改中',
        retestResult: wasClosed ? '复测通过' : '未复测',
        retestNote: wasClosed ? '迁移自已闭环记录，保留原结论' : '',
        assignee: record.assignedTo,
        rev: 1,
        baselineRev: 1,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        closedAt: wasClosed ? record.updatedAt : undefined
      }
      defects.push(defect)
      migrated.defectIds.push(defectId)
      device.defectIds.push(defectId)
    })

    if (record.status === '已关闭') {
      const release: ReleaseRecord = {
        id: `REL-MIG-${String(index + 1).padStart(2, '0')}`,
        batchId: 'BATCH-LEGACY',
        deviceId: device.id,
        deviceName: device.name,
        defectIds: migrated.defectIds,
        operator: '数据迁移',
        state: '写入成功',
        attempts: 1,
        lastError: '',
        createdAt: record.updatedAt,
        writtenAt: record.updatedAt,
        rev: 1
      }
      releases.push(release)
      migrated.releaseId = release.id
    }

    device.recordIds.push(record.id)
    devices.set(device.id, device)
    records.push(migrated)
  })

  // 旧审计：补齐实体类型与版本；rev 对齐实体当前版本，视为当前有效版本的历史动作
  audit.push(...legacy.audit.map((entry) => ({
    ...entry,
    entityType: 'record' as const,
    rev: records.find((item) => item.id === entry.recordId)?.version ?? entry.rev ?? 1
  })))

  audit.unshift({
    id: `MIG-${Date.now()}`,
    recordId: '-',
    action: '旧数据迁移',
    operator: '系统',
    detail: `首次打开 v2：${records.length} 条检验记录补齐基线，派生 ${devices.size} 台设备、${defects.length} 项缺陷，原结论保持不变`,
    createdAt: now,
    rev: 1,
    entityType: 'batch',
    migrated: true
  })

  return { schema: 2, records, devices: [...devices.values()], defects, releases, batches: [], audit }
}

function seedState(): PersistedState {
  return {
    schema: 2,
    records: structuredClone(seedRecords),
    devices: structuredClone(seedDevices),
    defects: structuredClone(seedDefects),
    releases: structuredClone(seedReleases),
    batches: [],
    audit: structuredClone(seedAudit)
  }
}

function readPersisted(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as PersistedState
    const legacyRaw = localStorage.getItem(LEGACY_KEY)
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw) as LegacyState
      if (isLegacy(legacy)) {
        const migrated = migrateLegacy(legacy)
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated))
        return migrated
      }
    }
  } catch {
    // 损坏数据回落种子
  }
  return seedState()
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useInspectionStore = defineStore('inspection', () => {
  const initial = readPersisted()
  const records = ref<InspectionRecord[]>(initial.records)
  const devices = ref<Device[]>(initial.devices)
  const defects = ref<Defect[]>(initial.defects)
  const releases = ref<ReleaseRecord[]>(initial.releases)
  const batches = ref<SyncBatch[]>(initial.batches)
  const audit = ref<AuditEntry[]>(initial.audit)

  const keyword = ref('')
  const status = ref<InspectionStatus | '全部'>('全部')
  const area = ref('全部')
  const liveMessage = ref('本地实时通道已就绪 · 断网补传就绪')

  // ---- 查询 ----------------------------------------------------------------

  const filtered = computed(() => records.value.filter((record) => {
    const haystack = `${record.id} ${record.deviceCode} ${record.deviceName} ${record.inspector} ${record.assignedTo}`.toLowerCase()
    return (!keyword.value || haystack.includes(keyword.value.toLowerCase()))
      && (status.value === '全部' || record.status === status.value)
      && (area.value === '全部' || record.area === area.value)
  }))

  const pendingBatches = computed(() => batches.value.filter((batch) =>
    batch.status === '待合并' || batch.status === '待值班长确认' || batch.status === '已确认待写入' || batch.status === '写入失败'))

  /** 待办只按当前有效版本统计：未关闭缺陷与挂起批次，历史版本不计入 */
  const stats = computed(() => {
    const dueOf = (recordId: string) => records.value.find((record) => record.id === recordId)?.dueDate ?? ''
    return {
      total: records.value.length,
      blocked: devices.value.filter((item) => item.openState === '停用').length,
      overdue: defects.value.filter((item) => item.status !== '已关闭' && dueOf(item.recordId) < TODAY).length,
      closed: defects.value.filter((item) => item.status === '已关闭').length,
      pendingRetest: defects.value.filter((item) => item.status === '待复测' && item.retestResult !== '复测通过').length,
      pendingBatches: pendingBatches.value.length,
      lockedDevices: devices.value.filter((item) => item.reopenLocked).length
    }
  })

  const currentRev = (entry: Pick<AuditEntry, 'recordId' | 'entityType'>): number => {
    if (entry.entityType === 'device') return devices.value.find((item) => item.id === entry.recordId)?.rev ?? 0
    if (entry.entityType === 'defect') return defects.value.find((item) => item.id === entry.recordId)?.rev ?? 0
    if (entry.entityType === 'release') return releases.value.find((item) => item.id === entry.recordId)?.rev ?? 0
    if (entry.entityType === 'batch') return batches.value.some((item) => item.id === entry.recordId) ? 1 : 1
    return records.value.find((item) => item.id === entry.recordId)?.version ?? 0
  }

  /** 审计只按当前有效版本：rev 不等于实体当前版本的动作隐藏 */
  const effectiveAudit = computed(() => audit.value.filter((entry) => {
    if (entry.entityType === 'batch') return true
    return entry.rev === currentRev(entry)
  }))

  function deviceOf(record: InspectionRecord) {
    return devices.value.find((item) => item.id === record.deviceId)
  }
  function defectsOf(record: InspectionRecord) {
    return defects.value.filter((item) => item.recordId === record.id)
  }
  function releaseOf(record: InspectionRecord) {
    return record.releaseId ? releases.value.find((item) => item.id === record.releaseId) : undefined
  }

  // ---- 审计 ----------------------------------------------------------------

  let auditSeq = 0
  function addAudit(
    recordId: string,
    action: string,
    operator: string,
    detail: string,
    entityType: AuditEntry['entityType'] = 'record',
    rev = 0,
    createdAt?: string
  ) {
    auditSeq += 1
    audit.value.unshift({
      id: `${recordId}-${Date.now()}-${auditSeq}`,
      recordId,
      action,
      operator,
      detail,
      createdAt: createdAt ?? new Date().toISOString(),
      rev: rev || currentRev({ recordId, entityType }),
      entityType
    })
  }

  // ---- 检验记录 ------------------------------------------------------------

  function addRecord(draft: InspectionDraft) {
    const record = createOfflineInspection(draft)
    record.baselineVersion = 1
    let device = devices.value.find((item) => item.code === draft.deviceCode)
    if (!device) {
      device = {
        id: `DEV-${draft.deviceCode}`,
        code: draft.deviceCode,
        name: draft.deviceName,
        area: draft.area,
        openState: '开放',
        reopenLocked: false,
        openNote: '新建设备，待首检',
        rev: 1,
        baselineRev: 1,
        updatedAt: record.createdAt,
        recordIds: [record.id],
        defectIds: []
      }
      devices.value.push(device)
    } else {
      device.recordIds.push(record.id)
    }
    record.deviceId = device.id
    record.defectIds = []
    records.value.unshift(record)
    addAudit(record.id, '创建检验记录', draft.inspector, '新建设备班次检验任务', 'record', record.version)
    return record
  }

  function updateRecord(id: string, patch: Partial<InspectionRecord>, action = '保存检验记录', operator = '当前用户') {
    const record = records.value.find((item) => item.id === id)
    if (!record) return { ok: false as const, message: '记录不存在' }
    if (record.pendingBatchId) return { ok: false as const, message: `批次 ${record.pendingBatchId} 待值班长确认，记录暂不能修改` }
    Object.assign(record, patch, { version: record.version + 1, updatedAt: new Date().toISOString() })
    addAudit(id, action, operator, `记录更新至版本 V${record.version}`, 'record', record.version)
    return { ok: true as const, message: `已更新至 V${record.version}` }
  }

  function transition(id: string, next: InspectionStatus, detail: string) {
    const record = records.value.find((item) => item.id === id)
    if (!record) return { ok: false as const, message: '记录不存在' }
    if (record.pendingBatchId) return { ok: false as const, message: `批次 ${record.pendingBatchId} 待值班长确认，不能流转` }
    if (next === '已关闭' && record.items.some((item) => item.result === '异常')) {
      return { ok: false as const, message: '仍有异常项，不能关闭任务' }
    }
    if (next === '待复测' && !record.stopped && record.risk === '紧急') {
      return { ok: false as const, message: '紧急风险缺陷必须先执行停用' }
    }
    // 设备未开放或仍有未关闭缺陷时，检验记录不能直接闭环
    if (next === '已关闭') {
      const device = deviceOf(record)
      if (device && device.openState !== '开放') return { ok: false as const, message: '设备尚未恢复开放，不能关闭检验记录' }
      if (defectsOf(record).some((item) => item.status !== '已关闭')) {
        return { ok: false as const, message: '仍有缺陷未复测关闭，不能关闭检验记录' }
      }
    }
    record.status = next
    record.version += 1
    record.updatedAt = new Date().toISOString()
    addAudit(id, `状态流转：${next}`, '当前用户', detail, 'record', record.version)
    return { ok: true as const, message: `已流转至${next}` }
  }

  // ---- 缺陷：复测通过才可关闭 ----------------------------------------------

  function submitRetest(defectId: string, result: RetestResult, note: string) {
    const defect = defects.value.find((item) => item.id === defectId)
    if (!defect) return { ok: false as const, message: '缺陷不存在' }
    if (defect.pendingBatchId) return { ok: false as const, message: `批次 ${defect.pendingBatchId} 待确认，暂不能录入复测` }
    defect.retestResult = result
    defect.retestNote = note
    defect.status = result === '复测通过' ? '复测通过' : '待复测'
    defect.rev += 1
    defect.updatedAt = new Date().toISOString()
    addAudit(defect.id, result === '复测通过' ? '复测通过' : '复测不通过', '当前用户', note || `复测结论：${result}`, 'defect', defect.rev)
    if (result !== '复测通过') {
      const device = devices.value.find((item) => item.id === defect.deviceId)
      if (device && device.openState === '开放') {
        device.openState = '停用'
        device.openNote = '复测不通过，重新停用'
        device.rev += 1
        addAudit(device.id, '设备停用', '系统', `缺陷 ${defect.id} 复测不通过，设备重新停用`, 'device', device.rev)
      }
    }
    return { ok: true as const, message: `复测结论：${result}` }
  }

  function closeDefect(defectId: string) {
    const defect = defects.value.find((item) => item.id === defectId)
    if (!defect) return { ok: false as const, message: '缺陷不存在' }
    if (defect.retestResult !== '复测通过') return { ok: false as const, message: '复测通过才可关闭缺陷' }
    defect.status = '已关闭'
    defect.closedAt = new Date().toISOString()
    defect.rev += 1
    addAudit(defect.id, '关闭缺陷', '当前用户', '复测通过，缺陷闭环', 'defect', defect.rev)
    return { ok: true as const, message: '缺陷已关闭' }
  }

  // ---- 设备：值班室操作 ----------------------------------------------------

  function setDeviceOpen(deviceId: string, open: boolean, note: string) {
    const device = devices.value.find((item) => item.id === deviceId)
    if (!device) return { ok: false as const, message: '设备不存在' }
    if (device.reopenLocked) return { ok: false as const, message: '补录批次待值班长确认，设备已锁定，值班室不能重开' }
    if (open) {
      const blocking = defects.value.filter((item) => item.deviceId === deviceId && item.status !== '已关闭')
      if (blocking.length) return { ok: false as const, message: `仍有 ${blocking.length} 项缺陷未关闭，不能重开` }
    }
    device.openState = open ? '开放' : '停用'
    device.openNote = note
    device.rev += 1
    device.updatedAt = new Date().toISOString()
    addAudit(device.id, open ? '值班室重开设备' : '值班室停用设备', '值班员', note, 'device', device.rev)
    return { ok: true as const, message: open ? '设备已重开' : '设备已停用' }
  }

  // ---- 断网补录批次 --------------------------------------------------------

  const specsById = new Map(scenarios.map((spec) => [spec.id, spec]))

  function stageBatch(specId: string): { ok: boolean; message: string; batchId?: string } {
    const spec = specsById.get(specId)
    if (!spec) return { ok: false, message: '未知场景' }
    // 同场景再次补传用后缀区分；若该场景已有未终态批次，先要求完成
    const active = batches.value.find((batch) => batch.id.startsWith(spec.id) && !['已放行', '已拦截'].includes(batch.status))
    if (active) return { ok: false, message: `${active.id} 尚未处理完成，不能再次补传` }
    const replayed = batches.value.some((batch) => batch.id.startsWith(spec.id))
    const suffix = replayed ? `-R${batches.value.filter((batch) => batch.id.startsWith(spec.id)).length + 1}` : ''
    const batch = buildOfflineBatch(spec, devices.value, records.value, defects.value, suffix)
    batches.value.unshift(batch)
    addAudit(batch.id, '断网补录已暂存', spec.inspector, `采集时刻 ${batch.collectedAt.replace('T', ' ').slice(0, 16)}，基线已随批次保存（回网前不合并）`, 'batch')
    return { ok: true, message: `${batch.id} 已暂存，等待回网补传`, batchId: batch.id }
  }

  /** 已确认/终态批次不能重放 */
  function replayBatch(batchId: string): { ok: boolean; message: string } {
    const batch = batches.value.find((item) => item.id === batchId)
    if (!batch) return { ok: false, message: '批次不存在' }
    if (batch.status !== '待合并') {
      batch.replayBlocked = true
      addAudit(batch.id, '拒绝批次重放', '系统', '已确认批次不能重放补传', 'batch')
      throw new ReplayDeniedError(batchId)
    }
    return { ok: true, message: '待合并批次可正常补传' }
  }

  /** 回网：先落值班室并发改动，再按基线做三方合并 */
  function uploadAndMerge(batchId: string): { ok: boolean; message: string; report?: string[] } {
    const batch = batches.value.find((item) => item.id === batchId)
    if (!batch) return { ok: false, message: '批次不存在' }
    if (batch.status !== '待合并') {
      batch.replayBlocked = true
      const error = new ReplayDeniedError(batchId)
      addAudit(batch.id, '拒绝批次重放', '系统', error.message, 'batch')
      return { ok: false, message: error.message }
    }
    const spec = scenarios.find((item) => batchId.startsWith(item.id)) as ScenarioSpec | undefined
    if (!spec) return { ok: false, message: '批次缺少场景定义' }

    // 1) 回网时才同步值班室断网期间的并发改动
    for (const edit of spec.dutyEdits) {
      const entity =
        edit.entityType === 'device' ? devices.value.find((item) => item.id === edit.entityId)
          : edit.entityType === 'record' ? records.value.find((item) => item.id === edit.entityId)
            : defects.value.find((item) => item.id === edit.entityId)
      if (!entity) continue
      applyFieldEdits(entity, edit.values)
      if ('rev' in entity && edit.entityType !== 'record') (entity as Device | Defect).rev += 1
      if (edit.entityType === 'record') (entity as InspectionRecord).version += 1
      addAudit(
        edit.entityId,
        edit.values.openState === '开放' ? '值班室重开设备'
          : edit.values.status === '已关闭' ? '值班室关闭缺陷'
            : '值班室并发修改',
        edit.operator,
        edit.note,
        edit.entityType === 'device' ? 'device' : edit.entityType === 'defect' ? 'defect' : 'record',
        edit.entityType === 'record' ? (entity as InspectionRecord).version : (entity as Device | Defect).rev,
        edit.at
      )
    }

    // 2) 三方合并
    const outcome = mergeBatch({ devices: devices.value, records: records.value, defects: defects.value }, batch, new Date().toISOString())
    batch.status = '待值班长确认'
    batch.mergedAt = new Date().toISOString()
    batch.conflicts = outcome.conflicts
    batch.mergeReport = outcome.report

    addAudit(batch.id, '回网三方合并', '系统',
      `${outcome.conflicts.length} 个字段两端都改过已并列保留；${outcome.closeRejected.length ? `关闭被拒：${outcome.closeRejected.join('、')}；` : ''}设备已锁定待值班长确认`, 'batch')
    for (const touched of outcome.touched) {
      const entity =
        touched.type === 'device' ? devices.value.find((item) => item.id === touched.id)
          : touched.type === 'record' ? records.value.find((item) => item.id === touched.id)
            : defects.value.find((item) => item.id === touched.id)
      addAudit(touched.id, '合并到当前版本', '系统', `批次 ${batch.id} 合并完成，等待值班长确认`,
        touched.type,
        touched.type === 'record' ? (entity as InspectionRecord).version : (entity as Device | Defect).rev)
    }
    return { ok: true, message: `合并完成：${outcome.conflicts.length} 处冲突待裁决，设备已锁定`, report: outcome.report }
  }

  /** 值班长确认：裁决冲突；复测通过才关缺陷、放设备 */
  function confirmBatch(
    batchId: string,
    resolutionList: Array<{ path: string; entityKey: string; resolution: NonNullable<ParallelField['resolution']> }>,
    chief = '值班长-郑涛'
  ): { ok: boolean; message: string } {
    const batch = batches.value.find((item) => item.id === batchId)
    if (!batch) return { ok: false, message: '批次不存在' }
    if (batch.status !== '待值班长确认') return { ok: false, message: '当前批次状态不能确认' }

    const result = confirmMerged(
      { devices: devices.value, records: records.value, defects: defects.value },
      batch,
      resolutionList,
      new Date().toISOString()
    )
    if (!result.ok) return result

    batch.confirmedBy = chief
    batch.confirmedAt = new Date().toISOString()

    for (const defectId of result.closedDefects) {
      const defect = defects.value.find((item) => item.id === defectId)
      if (defect) addAudit(defect.id, '复测通过关闭缺陷', chief, '值班长确认合并批次，复测通过，缺陷关闭', 'defect', defect.rev)
    }

    if (result.releasableDevices.length === 0) {
      // 复测未通过：不予放行，设备继续停用
      batch.status = '已拦截'
      for (const blocked of result.blockedDevices) {
        const device = devices.value.find((item) => item.id === blocked.deviceId)
        if (device) addAudit(device.id, '拒绝恢复开放', chief, blocked.reason, 'device', device.rev)
      }
      addAudit(batch.id, '批次确认（不予放行）', chief, result.message, 'batch')
      return { ok: true, message: result.message }
    }

    // 为每台可放行设备生成一条放行记录（按批写入；失败只重试这批）
    const newReleases: ReleaseRecord[] = result.releasableDevices.map((deviceId) => {
      const device = devices.value.find((item) => item.id === deviceId)!
      const relatedRecords = records.value.filter((record) => record.deviceId === deviceId)
      const relatedDefects = defects.value.filter((defect) => defect.deviceId === deviceId)
      return {
        id: `REL-${Date.now().toString().slice(-6)}-${device.code}`,
        batchId: batch.id,
        deviceId,
        deviceName: device.name,
        defectIds: relatedDefects.map((defect) => defect.id),
        operator: chief,
        state: '待写入' as const,
        attempts: 0,
        lastError: '',
        createdAt: new Date().toISOString(),
        rev: 1
      }
    })
    releases.value.unshift(...newReleases)
    batch.releaseIds.push(...newReleases.map((item) => item.id))
    batch.status = '已确认待写入'

    for (const record of records.value.filter((item) => result.releasableDevices.includes(item.deviceId))) {
      if (record.items.every((item) => item.result !== '异常') && defectsOf(record).every((item) => item.status === '已关闭')) {
        record.status = '已关闭'
        record.stopped = false
        record.releaseId = newReleases.find((item) => item.deviceId === record.deviceId)?.id
        addAudit(record.id, '检验记录闭环', chief, '复测通过、设备放行，检验记录关闭', 'record', record.version)
      }
    }
    for (const deviceId of result.releasableDevices) {
      const device = devices.value.find((item) => item.id === deviceId)!
      addAudit(device.id, '值班长确认恢复开放', chief, `批次 ${batch.id} 冲突裁决完成，复测全部通过`, 'device', device.rev)
    }
    addAudit(batch.id, '值班长确认批次', chief, result.message, 'batch')
    return { ok: true, message: result.message }
  }

  /** 放行写入：只写这批；失败只重试这批 */
  async function writeReleases(batchId: string): Promise<{ ok: boolean; message: string }> {
    const batch = batches.value.find((item) => item.id === batchId)
    if (!batch) return { ok: false, message: '批次不存在' }
    if (!['已确认待写入', '写入失败'].includes(batch.status)) return { ok: false, message: '当前批次没有待写入的放行' }

    const pending = releases.value.filter((item) => batch.releaseIds.includes(item.id) && item.state !== '写入成功')
    for (const release of pending) {
      release.attempts += 1
      try {
        await writeReleaseBatch()
        release.state = '写入成功'
        release.writtenAt = new Date().toISOString()
        addAudit(release.id, '放行记录写入成功', release.operator,
          `${release.deviceName} 放行（第 ${release.attempts} 次尝试）`, 'release', release.rev)
      } catch (error) {
        release.state = '写入失败'
        release.lastError = error instanceof Error ? error.message : '写入失败'
        batch.status = '写入失败'
        addAudit(release.id, '放行记录写入失败', '系统',
          `${release.deviceName}：${release.lastError}；仅本批可重试，其他批次不受影响`, 'release', release.rev)
        return { ok: false, message: `${release.deviceName} 放行写入失败：${release.lastError}（只重试这批）` }
      }
    }

    const allDone = batch.releaseIds.every((id) => releases.value.find((item) => item.id === id)?.state === '写入成功')
    if (allDone) {
      batch.status = '已放行'
      addAudit(batch.id, '批次放行完成', batch.confirmedBy ?? '值班长',
        `批次 ${batch.id} 全部放行写入成功，终态，不可重放`, 'batch')
      return { ok: true, message: '本批放行全部写入成功' }
    }
    batch.status = '写入失败'
    return { ok: false, message: '本批仍有放行未写入，可重试' }
  }

  /** 某批写入失败后只重试这批 */
  function retryFailedBatch(batchId: string) {
    const batch = batches.value.find((item) => item.id === batchId)
    if (!batch) return { ok: false as const, message: '批次不存在' }
    if (batch.status !== '写入失败') return { ok: false as const, message: '只有写入失败的批次可以重试' }
    addAudit(batch.id, '重试本批放行', '系统', '按批重试，不影响其他批次', 'batch')
    return { ok: true as const, message: '开始重试本批' }
  }

  // ---- 演示 ----------------------------------------------------------------

  function resetDemo() {
    const state = seedState()
    records.value = state.records
    devices.value = state.devices
    defects.value = state.defects
    releases.value = state.releases
    batches.value = state.batches
    audit.value = state.audit
  }

  watch([records, devices, defects, releases, batches, audit], () => {
    const state: PersistedState = {
      schema: 2,
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
    // state
    records, devices, defects, releases, batches, audit,
    keyword, status, area, liveMessage,
    // getters
    filtered, stats, pendingBatches, effectiveAudit,
    deviceOf, defectsOf, releaseOf, currentRev,
    // record
    addRecord, updateRecord, transition,
    // defect / device
    submitRetest, closeDefect, setDeviceOpen,
    // batch
    stageBatch, replayBatch, uploadAndMerge, confirmBatch, writeReleases, retryFailedBatch,
    resetDemo
  }
})

export type BatchStatusFilter = BatchStatus
