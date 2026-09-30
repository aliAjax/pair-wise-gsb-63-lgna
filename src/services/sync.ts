import type {
  BatchChange,
  Defect,
  Device,
  EntityType,
  InspectionRecord,
  ParallelField
} from '../types'

// ---------------------------------------------------------------------------
// 字段路径与快照：三方合并以批次携带的基线快照作为共同祖先
// ---------------------------------------------------------------------------

const RECORD_FIELDS: Array<{ path: string; label: string }> = [
  { path: 'assignedTo', label: '整改责任人' },
  { path: 'risk', label: '风险等级' },
  { path: 'dueDate', label: '截止日期' },
  { path: 'status', label: '流转状态' }
]

const DEVICE_FIELDS: Array<{ path: string; label: string }> = [
  { path: 'openState', label: '开放状态' },
  { path: 'openNote', label: '值班室备注' }
]

const DEFECT_FIELDS: Array<{ path: string; label: string }> = [
  { path: 'status', label: '缺陷状态' },
  { path: 'retestResult', label: '复测结果' },
  { path: 'retestNote', label: '复测说明' },
  { path: 'assignee', label: '处置责任人' }
]

export const FIELD_LABELS: Record<EntityType, Record<string, string>> = {
  device: Object.fromEntries(DEVICE_FIELDS.map((item) => [item.path, item.label])),
  record: Object.fromEntries(RECORD_FIELDS.map((item) => [item.path, item.label])),
  defect: Object.fromEntries(DEFECT_FIELDS.map((item) => [item.path, item.label]))
}

/** 自由文本字段允许“并列保留”，枚举字段必须二选一 */
const TEXT_FIELDS = new Set(['assignedTo', 'openNote', 'retestNote', 'assignee'])

/** 检验项路径：items.<itemId>.<field> */
function isItemPath(path: string) {
  return path.startsWith('items.')
}

function itemPathParts(path: string): [string, string] {
  const parts = path.split('.')
  return [parts[1], parts[2]]
}

export function fieldLabel(entityType: EntityType, path: string): string {
  if (isItemPath(path)) {
    const [itemId, field] = itemPathParts(path)
    const itemName: Record<string, string> = {
      wear: '结构磨损', noise: '运行异响', brake: '制动装置', lock: '锁止机构', safety: '安全装置'
    }
    const fieldName: Record<string, string> = { result: '结果', reading: '实测值', note: '备注' }
    return `${itemName[itemId] ?? itemId}·${fieldName[field] ?? field}`
  }
  return FIELD_LABELS[entityType][path] ?? path
}

export function isTextField(path: string) {
  return TEXT_FIELDS.has(path.split('.').pop() ?? '')
}

export function getPath(entity: Record<string, unknown>, path: string): string {
  if (isItemPath(path)) {
    const [itemId, field] = itemPathParts(path)
    const items = (entity.items as Array<Record<string, unknown>>) ?? []
    const item = items.find((candidate) => candidate.id === itemId)
    return item ? String(item[field] ?? '') : ''
  }
  return String(entity[path] ?? '')
}

function setPath(entity: Record<string, unknown>, path: string, value: string) {
  if (isItemPath(path)) {
    const [itemId, field] = itemPathParts(path)
    const items = (entity.items as Array<Record<string, unknown>>) ?? []
    const item = items.find((candidate) => candidate.id === itemId)
    if (item) item[field] = value
    return
  }
  entity[path] = value
}

/** 值班室并发改动按字段路径落盘（枚举/文本/检验项通用） */
export function applyFieldEdits(entity: Device | InspectionRecord | Defect, values: Record<string, string>) {
  const target = entity as unknown as Record<string, unknown>
  for (const [path, value] of Object.entries(values)) setPath(target, path, value)
}

export function snapshotEntity(type: EntityType, entity: Device | InspectionRecord | Defect): Record<string, unknown> {
  const source = entity as unknown as Record<string, unknown>
  const snapshot: Record<string, unknown> = {}
  const paths =
    type === 'device'
      ? DEVICE_FIELDS.map((item) => item.path)
      : type === 'defect'
        ? DEFECT_FIELDS.map((item) => item.path)
        : [
            ...RECORD_FIELDS.map((item) => item.path),
            ...((entity as InspectionRecord).items ?? []).flatMap((item) =>
              ['result', 'reading', 'note'].map((field) => `items.${item.id}.${field}`))
          ]
  for (const path of paths) snapshot[path] = getPath(source, path)
  return snapshot
}

// ---------------------------------------------------------------------------
// 三方合并
// ---------------------------------------------------------------------------

export interface MergeContext {
  devices: Device[]
  records: InspectionRecord[]
  defects: Defect[]
}

export interface MergeOutcome {
  conflicts: ParallelField[]
  touched: Array<{ type: EntityType; id: string }>
  /** 复测已通过的缺陷（值班长确认后可关闭并放行） */
  retestPassed: string[]
  /** 值班室已关缺陷但复测未通过，确认时必须拒绝关闭 */
  closeRejected: string[]
  report: string[]
}

interface BaselineGroup {
  type: EntityType
  id: string
  base: Record<string, unknown>
  changes: BatchChange[]
}

function findEntity(context: MergeContext, type: EntityType, id: string) {
  if (type === 'device') return context.devices.find((item) => item.id === id)
  if (type === 'record') return context.records.find((item) => item.id === id)
  return context.defects.find((item) => item.id === id)
}

/**
 * 回网合并：以批次基线为共同祖先。
 * - 仅一端改动：快进采用；
 * - 两端都改：同一字段并列保留（文本字段直接并列写入，枚举字段挂起待值班长二选一）。
 * 合并后实体挂起批次、设备锁定，值班长确认前不能恢复开放。
 */
export function mergeBatch(
  context: MergeContext,
  batch: {
    id: string
    baselines: Array<{ entityType: EntityType; entityId: string; snapshot: Record<string, unknown> }>
    changes: BatchChange[]
  },
  nowIso: string
): MergeOutcome {
  const outcome: MergeOutcome = { conflicts: [], touched: [], retestPassed: [], closeRejected: [], report: [] }
  const groups = new Map<string, BaselineGroup>()

  for (const baseline of batch.baselines) {
    groups.set(`${baseline.entityType}:${baseline.entityId}`, {
      type: baseline.entityType, id: baseline.entityId, base: baseline.snapshot, changes: []
    })
  }
  for (const change of batch.changes) {
    groups.get(`${change.entityType}:${change.entityId}`)?.changes.push(change)
  }

  for (const group of groups.values()) {
    const entity = findEntity(context, group.type, group.id)
    if (!entity) continue
    const target = entity as unknown as Record<string, unknown>
    const offlineByPath = new Map(group.changes.map((change) => [change.path, change.value]))
    const allPaths = new Set([...Object.keys(group.base), ...offlineByPath.keys()])
    const ownConflicts: ParallelField[] = []
    const kindName = group.type === 'device' ? '设备' : group.type === 'defect' ? '缺陷' : '记录'

    for (const path of allPaths) {
      const baseValue = String(group.base[path] ?? '')
      const offlineValue = offlineByPath.get(path)
      const dutyValue = getPath(target, path)
      const offlineChanged = offlineValue !== undefined && offlineValue !== baseValue
      const dutyChanged = dutyValue !== baseValue

      if (!offlineChanged && dutyChanged) {
        outcome.report.push(`${kindName} ${group.id} 的「${fieldLabel(group.type, path)}」仅值班室改动，保留值班室取值`)
        continue
      }
      if (offlineChanged && !dutyChanged) {
        if (offlineValue !== undefined) {
          setPath(target, path, offlineValue)
          outcome.report.push(`${kindName} ${group.id} 的「${fieldLabel(group.type, path)}」仅采集端改动，采用补传取值`)
        }
        continue
      }
      if (offlineChanged && dutyChanged && offlineValue !== dutyValue) {
        // 同一字段两边都改过：并列保留，交值班长裁决
        const conflict: ParallelField = {
          path,
          label: fieldLabel(group.type, path),
          offlineValue: offlineValue ?? '',
          dutyValue,
          baseValue,
          resolution: isTextField(path) ? '并列保留' : undefined
        }
        ownConflicts.push(conflict)
        outcome.conflicts.push(conflict)
        if (isTextField(path)) setPath(target, path, composeParallel(conflict))
        outcome.report.push(
          `${kindName} ${group.id} 的「${conflict.label}」两端都改过：采集端=${conflict.offlineValue}，值班室=${conflict.dutyValue}，已并列保留待裁决`
        )
      }
    }

    // 复测门禁：值班室在复测通过前关闭缺陷 -> 判定“关闭被拒”，退回待复测
    if (group.type === 'defect') {
      const defect = entity as Defect
      if (offlineByPath.get('retestResult') === '复测通过' || defect.retestResult === '复测通过') {
        outcome.retestPassed.push(defect.id)
      }
      if (defect.status === '已关闭' && defect.retestResult !== '复测通过') {
        defect.status = '待复测'
        defect.closeRejected = true
        outcome.closeRejected.push(defect.id)
        outcome.report.push(`缺陷 ${defect.id} 被值班室关闭但复测未通过，关闭被拒绝，退回待复测`)
      }
    }

    // 值班长确认前设备一律锁定：即使值班室已重开也不能恢复开放
    if (group.type === 'device') {
      const device = entity as Device
      const wasOpen = device.openState === '开放'
      device.openState = '停用'
      device.reopenLocked = true
      device.pendingBatchId = batch.id
      device.updatedAt = nowIso
      device.rev += 1
      if (wasOpen) outcome.report.push(`设备 ${device.code} 值班室已重开，但批次 ${batch.id} 待确认，已重新锁定为停用`)
    } else if (group.type === 'record') {
      const record = entity as InspectionRecord
      record.pendingBatchId = batch.id
      record.updatedAt = nowIso
      record.version += 1
    } else {
      const defect = entity as Defect
      defect.pendingBatchId = batch.id
      defect.updatedAt = nowIso
      defect.rev += 1
    }

    if (ownConflicts.length) {
      ;(entity as { parallelFields?: ParallelField[] }).parallelFields = ownConflicts
    }
    outcome.touched.push({ type: group.type, id: group.id })
  }

  return outcome
}

// ---------------------------------------------------------------------------
// 值班长确认：裁决冲突，复测通过才可关闭缺陷并放行；否则设备保持停用
// ---------------------------------------------------------------------------

export interface ConfirmResult {
  ok: boolean
  message: string
  /** 本次确认可放行的设备：其上所有缺陷均复测通过 */
  releasableDevices: string[]
  /** 仍有缺陷复测未通过、设备不能恢复开放 */
  blockedDevices: Array<{ deviceId: string; reason: string }>
  closedDefects: string[]
}

export function composeParallel(conflict: ParallelField): string {
  return `[采集端@${conflict.offlineValue}] / [值班室@${conflict.dutyValue}]`
}

export function confirmMerged(
  context: MergeContext,
  batch: {
    id: string
    baselines: Array<{ entityType: EntityType; entityId: string }>
  },
  resolutions: Array<{ path: string; entityKey: string; resolution: NonNullable<ParallelField['resolution']> }>,
  nowIso: string
): ConfirmResult {
  const resolutionByKey = new Map(resolutions.map((item) => [`${item.entityKey}:${item.path}`, item.resolution]))

  // 1) 逐实体应用裁决
  for (const ref of batch.baselines) {
    const entity = findEntity(context, ref.entityType, ref.entityId)
    if (!entity || (entity as { pendingBatchId?: string }).pendingBatchId !== batch.id) continue
    const entityKey = `${ref.entityType}:${ref.entityId}`
    const conflicts = (entity as { parallelFields?: ParallelField[] }).parallelFields ?? []

    for (const conflict of conflicts) {
      const decision = resolutionByKey.get(`${entityKey}:${conflict.path}`) ?? conflict.resolution
      if (!decision) {
        return { ok: false, message: `「${conflict.label}」尚未裁决，不能确认`, releasableDevices: [], blockedDevices: [], closedDefects: [] }
      }
      conflict.resolution = decision
      conflict.confirmedValue =
        decision === '并列保留' ? composeParallel(conflict) : decision === '采用采集端' ? conflict.offlineValue : conflict.dutyValue
      setPath(entity as unknown as Record<string, unknown>, conflict.path, conflict.confirmedValue)
    }

    // 复测通过才可关闭缺陷
    if (ref.entityType === 'defect') {
      const defect = entity as Defect
      if (defect.retestResult === '复测通过') {
        defect.status = '已关闭'
        defect.closedAt = nowIso
      }
      defect.pendingBatchId = undefined
      defect.updatedAt = nowIso
      defect.baselineRev = defect.rev + 1
      defect.rev += 1
    } else if (ref.entityType === 'record') {
      const record = entity as InspectionRecord
      record.pendingBatchId = undefined
      record.updatedAt = nowIso
      record.baselineVersion = record.version + 1
      record.version += 1
    }
  }

  const closedDefects = batch.baselines
    .filter((ref) => ref.entityType === 'defect')
    .map((ref) => context.defects.find((item) => item.id === ref.entityId))
    .filter((defect): defect is Defect => !!defect && defect.status === '已关闭')
    .map((defect) => defect.id)

  // 2) 设备门禁：同设备全部缺陷复测通过才允许恢复开放并放行
  const releasableDevices: string[] = []
  const blockedDevices: Array<{ deviceId: string; reason: string }> = []
  const deviceIds = new Set(batch.baselines.filter((item) => item.entityType === 'device').map((item) => item.entityId))
  for (const deviceId of deviceIds) {
    const device = context.devices.find((item) => item.id === deviceId)
    if (!device) continue
    const blocking = context.defects.filter((item) => item.deviceId === deviceId && item.retestResult !== '复测通过')
    device.pendingBatchId = undefined
    device.reopenLocked = false
    device.baselineRev = device.rev + 1
    device.rev += 1
    device.updatedAt = nowIso
    if (blocking.length === 0) {
      device.openState = '开放'
      device.openNote = `${device.openNote}｜值班长确认合并，复测通过，恢复开放`
      releasableDevices.push(deviceId)
    } else {
      // 仍有未通过复测的缺陷：设备不能恢复开放
      device.openState = '停用'
      device.openNote = `${device.openNote}｜值班长确认：复测未通过，继续停用`
      blockedDevices.push({ deviceId, reason: `缺陷 ${blocking.map((item) => item.id).join('、')} 复测未通过，设备继续停用` })
    }
  }

  return {
    ok: true,
    message: blockedDevices.length
      ? `已确认 ${closedDefects.length} 项缺陷关闭；${blockedDevices.length} 台设备复测未通过，继续停用`
      : `批次确认完成，${releasableDevices.length} 台设备复测通过，可写入放行`,
    releasableDevices,
    blockedDevices,
    closedDefects
  }
}

// ---------------------------------------------------------------------------
// 放行写入：按批写入，失败只重试这一批；已确认批次不能重放
// ---------------------------------------------------------------------------

export class ReplayDeniedError extends Error {
  constructor(batchId: string) {
    super(`批次 ${batchId} 已确认，不能重放补传`)
    this.name = 'ReplayDeniedError'
  }
}

/** 演示用写入通道：可注入下一批失败一次，模拟“某批放行写入失败” */
let writeGate: () => boolean = () => true

export function armNextWriteFailure(): string {
  writeGate = () => {
    writeGate = () => true
    return false
  }
  return '已安排下一批放行写入失败一次，可验证“只重试这批”'
}

export function writeReleaseBatch(): Promise<void> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (writeGate()) resolve()
      else reject(new Error('放行台账写入超时（模拟网络抖动）'))
    }, 600)
  })
}
