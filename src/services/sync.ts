import type {
  AuditEntry, Defect, Device, FieldConflict, InspectionItem, InspectionRecord,
  PersistedState, ReleaseRecord, SyncBatch
} from '../types'
import { seedAudit, seedDefects, seedDevices, seedRecords, seedReleases } from '../data/seed'

export const SCHEMA_VERSION = 2

export const SCALAR_FIELDS = [
  { field: 'assignedTo', label: '整改责任人' },
  { field: 'risk', label: '风险等级' },
  { field: 'dueDate', label: '整改截止日' },
  { field: 'stopped', label: '设备停用状态' }
] as const

/** 参与三路合并的平铺字段中文说明 */
export const FIELD_LABELS: Record<string, string> = Object.fromEntries(SCALAR_FIELDS.map((item) => [item.field, item.label]))

/** 把一条检验记录拍平成可合并的字段映射（含每个检验项的结果/读数/备注） */
export function flattenRecord(record: InspectionRecord): Record<string, string> {
  const flat: Record<string, string> = {
    assignedTo: record.assignedTo,
    risk: record.risk,
    dueDate: record.dueDate,
    stopped: String(record.stopped)
  }
  for (const item of record.items) {
    flat[`item:${item.id}.result`] = item.result
    flat[`item:${item.id}.reading`] = item.reading
    flat[`item:${item.id}.note`] = item.note
  }
  return flat
}

function fieldLabel(field: string): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field]
  const itemMatch = field.match(/^item:([^.]+)\.(result|reading|note)$/)
  if (itemMatch) return `${itemMatch[1] === 'result' ? '检验结果' : itemMatch[1] === 'reading' ? '实测读数' : '备注'}`
  return field
}

function itemNameLabel(items: InspectionItem[], field: string): string {
  const match = field.match(/^item:([^.]+)\.(result|reading|note)$/)
  if (!match) return fieldLabel(field)
  const item = items.find((candidate) => candidate.id === match[1])
  const part = match[2] === 'result' ? '结果' : match[2] === 'reading' ? '读数' : '备注'
  return `${item?.name ?? match[1]}·${part}`
}

export interface MergeOutcome {
  record: InspectionRecord
  conflicts: FieldConflict[]
  /** 复测判定：缺陷 id -> 是否通过（相关检验项全部不再异常即通过） */
  retestResults: Record<string, boolean>
  changedFields: string[]
}

/**
 * 字段级三路合并：
 * - 仅离线端相对基线改过：取离线值（补录内容生效）；
 * - 仅值班室（当前在线版本）相对基线改过：保留在线值（值班室处置不被覆盖）；
 * - 两边都相对基线改过且值不同：并列保留为字段冲突，挂待办，等待值班长裁决，设备保持锁定。
 */
export function threeWayMerge(record: InspectionRecord, batch: SyncBatch): MergeOutcome {
  const merged: InspectionRecord = structuredClone(record)
  const current = flattenRecord(record)
  const base = batch.baseline
  // 复测结果是权威的新观测：即使恰好等于基线值，也视为离线侧对该字段的取值参与三方比对
  const retestAsChanges: Record<string, string> = {}
  if (batch.retest) {
    for (const [itemId, result] of Object.entries(batch.retest)) {
      retestAsChanges[`item:${itemId}.result`] = result
    }
  }
  const offlineEdits: Record<string, string> = { ...retestAsChanges, ...batch.changes }
  const offline = { ...base, ...offlineEdits }
  const conflicts: FieldConflict[] = []
  const changedFields: string[] = []
  const retestItemIds = new Set(batch.retest ? Object.keys(batch.retest).map((id) => `item:${id}.result`) : [])

  const applyScalar = (field: string, value: string) => {
    if (field === 'stopped') merged.stopped = value === 'true'
    else if (field === 'risk') merged.risk = value as InspectionRecord['risk']
    else if (field === 'assignedTo') merged.assignedTo = value
    else if (field === 'dueDate') merged.dueDate = value
  }

  for (const field of Object.keys(offlineEdits)) {
    const baseValue = base[field] ?? ''
    const offlineValue = offline[field] ?? ''
    const onlineValue = current[field] ?? ''
    // 复测字段视为权威观测必算改动；普通 changes 仍按相对基线是否变化判定
    const offlineChanged = retestItemIds.has(field) || offlineValue !== baseValue
    const onlineChanged = onlineValue !== baseValue

    if (field.startsWith('item:')) {
      const match = field.match(/^item:([^.]+)\.(result|reading|note)$/)
      const target = merged.items.find((item) => item.id === match?.[1])
      if (!target) continue
      const part = match![2] as 'result' | 'reading' | 'note'

      if (offlineChanged && onlineChanged && offlineValue !== onlineValue) {
        conflicts.push({ field, fieldLabel: itemNameLabel(record.items, field), offlineValue, onlineValue, collectedAt: batch.collectedAt })
      } else if (offlineChanged) {
        if (part === 'result') target.result = offlineValue as InspectionItem['result']
        else if (part === 'reading') target.reading = offlineValue
        else target.note = offlineValue
        changedFields.push(field)
      }
      continue
    }

    if (offlineChanged && onlineChanged && offlineValue !== onlineValue) {
      conflicts.push({ field, fieldLabel: itemNameLabel(record.items, field), offlineValue, onlineValue, collectedAt: batch.collectedAt })
    } else if (offlineChanged) {
      applyScalar(field, offlineValue)
      changedFields.push(field)
    }
  }

  // 复测判定：最终检验项无异常、且不存在“任一侧仍报异常”的未裁决结果冲突，才算整体通过
  const retestResults: Record<string, boolean> = {}
  if (batch.retest) {
    const abnormalIds = new Set(merged.items.filter((item) => item.result === '异常').map((item) => item.id))
    merged.conflicts
      .filter((conflict) => conflict.field.startsWith('item:') && conflict.field.endsWith('.result'))
      .forEach((conflict) => {
        const itemId = conflict.field.split(':')[1].split('.')[0]
        if (conflict.offlineValue === '异常' || conflict.onlineValue === '异常') abnormalIds.add(itemId)
      })
    retestResults.__all__ = abnormalIds.size === 0
  }

  if (conflicts.length) {
    // 同类未解决冲突去重后并入，等待值班长在确认页逐条裁决
    const known = new Set(merged.conflicts.filter((item) => !item.resolved).map((item) => item.field))
    for (const conflict of conflicts) {
      if (!known.has(conflict.field)) merged.conflicts.push(conflict)
    }
  }

  merged.version = record.version + 1
  merged.baselineVersion = record.version
  merged.lastBatchId = batch.id
  merged.updatedAt = new Date().toISOString()
  return { record: merged, conflicts, retestResults, changedFields }
}

/** 裁决字段冲突后把选定值写回记录 */
export function resolveConflictValue(record: InspectionRecord, field: string, resolution: 'offline' | 'online'): InspectionRecord {
  const next = structuredClone(record)
  const conflict = next.conflicts.find((item) => item.field === field && !item.resolved)
  if (!conflict) return next
  const value = resolution === 'offline' ? conflict.offlineValue : conflict.onlineValue
  if (field.startsWith('item:')) {
    const match = field.match(/^item:([^.]+)\.(result|reading|note)$/)
    const target = next.items.find((item) => item.id === match?.[1])
    if (target) {
      if (match![2] === 'result') target.result = value as InspectionItem['result']
      else if (match![2] === 'reading') target.reading = value
      else target.note = value
    }
  } else if (field === 'stopped') {
    next.stopped = value === 'true'
  } else if (field === 'risk') {
    next.risk = value as InspectionRecord['risk']
  } else if (field === 'assignedTo') {
    next.assignedTo = value
  } else if (field === 'dueDate') {
    next.dueDate = value
  }
  conflict.resolved = true
  conflict.resolution = resolution
  conflict.resolvedAt = new Date().toISOString()
  next.version += 1
  next.updatedAt = conflict.resolvedAt
  return next
}

/** 一个批次是否还允许值班长确认：所有并列冲突必须裁决完毕 */
export function batchConfirmable(record: InspectionRecord | undefined, batch: SyncBatch): boolean {
  if (batch.status !== '已合并') return false
  if (!record) return false
  return batch.conflictFields.every((field) => {
    const conflict = record.conflicts.find((item) => item.field === field)
    return conflict?.resolved === true
  })
}

/**
 * 旧数据首次打开迁移：
 * - 补 schemaVersion、设备实体、缺陷实体、放行/批次空表；
 * - 老检验记录补齐 baselineVersion=1 与 conflicts，保留原结论（状态/版本/读数不变）；
 * - 老审计条目标记为当前有效版本，不产生“结论变更”。
 */
export function migratePersisted(raw: unknown): { state: PersistedState; migrated: boolean } {
  const parsed = (raw ?? {}) as Record<string, unknown>
  const legacyRecords = Array.isArray(parsed.records) ? parsed.records as InspectionRecord[] : null

  // 已经是新结构
  if (typeof parsed.schemaVersion === 'number' && Array.isArray(parsed.devices)) {
    return {
      state: {
        schemaVersion: parsed.schemaVersion as number,
        records: parsed.records as InspectionRecord[],
        devices: parsed.devices as Device[],
        defects: (parsed.defects as Defect[]) ?? [],
        releases: (parsed.releases as ReleaseRecord[]) ?? [],
        batches: (parsed.batches as SyncBatch[]) ?? [],
        audit: parsed.audit as AuditEntry[]
      },
      migrated: false
    }
  }

  // 全新用户（无任何记录）
  if (!legacyRecords) {
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

  // 旧版本数据：补齐基线与关联实体，原结论原样保留
  const records: InspectionRecord[] = legacyRecords.map((record) => ({
    ...record,
    baselineVersion: 1,
    conflicts: record.conflicts ?? []
  }))

  const knownDeviceCodes = new Set<string>()
  const devices: Device[] = []
  for (const record of records) {
    if (knownDeviceCodes.has(record.deviceCode)) continue
    knownDeviceCodes.add(record.deviceCode)
    devices.push({
      code: record.deviceCode,
      name: record.deviceName,
      area: record.area,
      open: !record.stopped,
      operatedFromVersion: record.version,
      mergeLocked: false,
      lastDutyAction: '旧数据迁移：按原停用结论恢复设备状态',
      updatedAt: record.updatedAt
    })
  }

  // 旧版本数据：为保留原结论，按记录最终状态补缺陷；仅已关闭结论补“已关闭”缺陷，
  // 避免给正常项凭空新增缺陷；异常项按当前处置状态补开放缺陷
  const defects: Defect[] = []
  for (const record of records) {
    const abnormalItems = record.items.filter((item) => item.result === '异常')
    for (const item of abnormalItems) {
      defects.push({
        id: `DEF-MIG-${record.id}-${item.id}`,
        recordId: record.id,
        deviceCode: record.deviceCode,
        itemId: item.id,
        title: `${item.name}：${item.note || '检验异常'}`,
        risk: record.risk,
        status: record.status === '已关闭' ? '已关闭' : record.status === '待复测' ? '待复测' : '开放',
        retestPassed: record.status === '已关闭',
        retestRecordId: record.status === '已关闭' ? record.id : undefined,
        active: true,
        openedAt: record.createdAt,
        closedAt: record.status === '已关闭' ? record.updatedAt : undefined
      })
    }
  }

  const audit: AuditEntry[] = ((Array.isArray(parsed.audit) ? parsed.audit as AuditEntry[] : [])).map((entry) => ({
    ...entry,
    version: entry.version ?? records.find((record) => record.id === entry.recordId)?.version ?? 1,
    active: true,
    category: entry.category ?? '检验'
  }))
  const migrationStamp = new Date().toISOString()
  audit.unshift({
    id: `MIGRATION-${migrationStamp}`,
    recordId: '*',
    action: '旧数据迁移',
    operator: '系统',
    detail: `首次打开新结构：为 ${records.length} 条检验记录补齐基线版本 V1 与设备/缺陷档案，原检验结论保持不变`,
    createdAt: migrationStamp,
    version: 1,
    active: true,
    category: '迁移'
  })

  return {
    state: {
      schemaVersion: SCHEMA_VERSION,
      records,
      devices,
      defects,
      releases: [],
      batches: [],
      audit
    },
    migrated: true
  }
}
