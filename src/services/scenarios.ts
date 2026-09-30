import type { BatchChange, Defect, Device, InspectionRecord, SyncBatch } from '../types'
import { fieldLabel, snapshotEntity } from './sync'

// ---------------------------------------------------------------------------
// 演示场景：检验员断网补录 -> 回网合并。
// 基线在“断网开始时”从当前实体抓取；值班室并发改动在回网时才落盘，
// 这样同一设备/检验记录/缺陷上才能真实复现两边都改过的冲突。
// ---------------------------------------------------------------------------

export interface ScenarioSpec {
  id: string
  title: string
  description: string
  collectedAt: string
  uploadedAt: string
  inspector: string
  deviceId: string
  recordId: string
  /** 批次作用域内、即使采集端未修改也要随批携带基线并参与合并锁定的实体 */
  scope: Array<{ entityType: 'device' | 'record' | 'defect'; entityId: string }>
  /** 断网期间采集端的改动（label 仅用于场景说明，落批次时自动生成） */
  offline: BatchChange[]
  /** 回网时得知值班室在断网期间做过的并发改动（重开设备/关闭缺陷等） */
  dutyEdits: Array<{
    entityType: 'device' | 'record' | 'defect'
    entityId: string
    values: Record<string, string>
    operator: string
    note: string
    at: string
  }>
}

export const scenarios: ScenarioSpec[] = [
  {
    id: 'BATCH-AM014',
    title: '批次A · 高空飞翔 · 复测全通过',
    description: '周宁在 A区北侧断网巡检，补录两项缺陷复测通过、磨损与锁止恢复正常；值班室已提前重开设备并调整责任人。',
    collectedAt: '2026-09-30T07:42:00',
    uploadedAt: '2026-09-30T09:18:00',
    inspector: '周宁',
    deviceId: 'DEV-AM-014',
    recordId: 'INS-240821-01',
    scope: [
      { entityType: 'device', entityId: 'DEV-AM-014' },
      { entityType: 'record', entityId: 'INS-240821-01' }
    ],
    offline: [
      { entityType: 'defect', entityId: 'DEF-001', path: 'retestResult', label: '复测结果', value: '复测通过' },
      { entityType: 'defect', entityId: 'DEF-001', path: 'retestNote', label: '复测说明', value: '复检磨损 3.6 mm，负荷试验合格' },
      { entityType: 'defect', entityId: 'DEF-002', path: 'retestResult', label: '复测结果', value: '复测通过' },
      { entityType: 'defect', entityId: 'DEF-002', path: 'retestNote', label: '复测说明', value: '压杠锁止连续 30 次无回弹' },
      { entityType: 'record', entityId: 'INS-240821-01', path: 'items.wear.reading', label: '结构磨损·实测值', value: '3.6 mm' },
      { entityType: 'record', entityId: 'INS-240821-01', path: 'items.wear.result', label: '结构磨损·结果', value: '正常' },
      { entityType: 'record', entityId: 'INS-240821-01', path: 'items.wear.note', label: '结构磨损·备注', value: '更换衬板后复测正常' },
      { entityType: 'record', entityId: 'INS-240821-01', path: 'items.lock.reading', label: '锁止机构·实测值', value: '闭合到位' },
      { entityType: 'record', entityId: 'INS-240821-01', path: 'items.lock.result', label: '锁止机构·结果', value: '正常' },
      { entityType: 'record', entityId: 'INS-240821-01', path: 'items.lock.note', label: '锁止机构·备注', value: '更换锁舌，回弹消除' },
      { entityType: 'record', entityId: 'INS-240821-01', path: 'assignedTo', label: '整改责任人', value: '维修二组' }
      // 检验员不自行重开设备：开放须由值班长确认合并后决定
    ],
    dutyEdits: [
      {
        entityType: 'device', entityId: 'DEV-AM-014', at: '2026-09-30T08:30:00', operator: '值班员-陈牧',
        values: { openState: '开放', openNote: '早高峰前口头确认维修完成，值班室先行重开' },
        note: '值班室重开设备（未经值班长确认合并）'
      },
      {
        entityType: 'record', entityId: 'INS-240821-01', at: '2026-09-30T08:35:00', operator: '值班员-陈牧',
        values: { assignedTo: '维修一组（收尾）' },
        note: '值班室把整改责任人改为维修一组收尾'
      }
    ]
  },
  {
    id: 'BATCH-RC007',
    title: '批次B · 家庭过山车 · 一项复测未通过',
    description: '李琪早班断网补录：联锁复测通过、接缝磨损仍超差；值班室却已关闭接缝缺陷并重开设备，合并时关闭被拒、设备须继续停用。',
    collectedAt: '2026-09-30T08:05:00',
    uploadedAt: '2026-09-30T09:31:00',
    inspector: '李琪',
    deviceId: 'DEV-RC-007',
    recordId: 'INS-240821-02',
    scope: [
      { entityType: 'device', entityId: 'DEV-RC-007' },
      { entityType: 'record', entityId: 'INS-240821-02' }
    ],
    offline: [
      { entityType: 'defect', entityId: 'DEF-003', path: 'status', label: '缺陷状态', value: '整改中' },
      { entityType: 'defect', entityId: 'DEF-003', path: 'retestResult', label: '复测结果', value: '复测不通过' },
      { entityType: 'defect', entityId: 'DEF-003', path: 'retestNote', label: '复测说明', value: '接缝磨损复测 5.6 mm，仍超 5.0 mm 限值' },
      { entityType: 'defect', entityId: 'DEF-004', path: 'retestResult', label: '复测结果', value: '复测通过' },
      { entityType: 'defect', entityId: 'DEF-004', path: 'retestNote', label: '复测说明', value: '联锁响应 0.4s，恢复正常' },
      { entityType: 'record', entityId: 'INS-240821-02', path: 'items.wear.reading', label: '结构磨损·实测值', value: '5.6 mm' },
      { entityType: 'record', entityId: 'INS-240821-02', path: 'assignedTo', label: '整改责任人', value: '轨道抢修组' },
      { entityType: 'device', entityId: 'DEV-RC-007', path: 'openState', label: '开放状态', value: '停用' }
    ],
    dutyEdits: [
      {
        entityType: 'defect', entityId: 'DEF-003', at: '2026-09-30T08:50:00', operator: '值班员-陈牧',
        values: { status: '已关闭' },
        note: '值班室在复测结论回传前关闭了接缝磨损缺陷'
      },
      {
        entityType: 'device', entityId: 'DEV-RC-007', at: '2026-09-30T08:52:00', operator: '值班员-陈牧',
        values: { openState: '开放', openNote: '缺陷已关闭，恢复开放' },
        note: '值班室随缺陷关闭重开设备'
      },
      {
        entityType: 'record', entityId: 'INS-240821-02', at: '2026-09-30T08:55:00', operator: '值班员-陈牧',
        values: { assignedTo: '电气班组（值守）' },
        note: '值班室把责任人改为电气班组值守'
      }
    ]
  }
]

/** 断网开始时从当前实体抓取基线快照，构造待补传批次（不落库、不改动实体） */
export function buildOfflineBatch(
  spec: ScenarioSpec,
  devices: Device[],
  records: InspectionRecord[],
  defects: Defect[],
  suffix = ''
): SyncBatch {
  const find = <T extends { id: string }>(list: T[], id: string) => {
    const entity = list.find((item) => item.id === id)
    if (!entity) throw new Error(`场景缺少实体 ${id}`)
    return entity
  }
  const involved = new Map<string, { entityType: 'device' | 'record' | 'defect'; entityId: string }>()
  // 批次作用域实体（主设备/主记录）始终携带基线，即使采集端没有改动也要参与合并锁定
  for (const ref of spec.scope) involved.set(`${ref.entityType}:${ref.entityId}`, ref)
  for (const change of spec.offline) involved.set(`${change.entityType}:${change.entityId}`, change)

  const baselines = [...involved.values()].map((ref) => {
    const entity =
      ref.entityType === 'device' ? find(devices, ref.entityId)
        : ref.entityType === 'record' ? find(records, ref.entityId)
          : find(defects, ref.entityId)
    return {
      entityType: ref.entityType,
      entityId: ref.entityId,
      rev: ref.entityType === 'record'
        ? (entity as InspectionRecord).version
        : (entity as Device | Defect).rev,
      snapshot: snapshotEntity(ref.entityType, entity)
    }
  })

  return {
    id: `${spec.id}${suffix}`,
    inspector: spec.inspector,
    collectedAt: spec.collectedAt,
    uploadedAt: spec.uploadedAt,
    status: '待合并',
    baselines,
    changes: spec.offline.map((change) => ({
      ...change,
      label: change.label ?? fieldLabel(change.entityType, change.path)
    })),
    releaseIds: []
  }
}
