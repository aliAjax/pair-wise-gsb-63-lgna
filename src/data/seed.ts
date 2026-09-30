import type { AuditEntry, Defect, Device, InspectionItem, InspectionRecord } from '../types'

const standardItems = (abnormal = false): InspectionItem[] => [
  { id: 'wear', name: '结构磨损', result: abnormal ? '异常' : '正常', reading: abnormal ? '6.8 mm' : '2.1 mm', limit: '≤ 5.0 mm', note: abnormal ? '主支撑连接处磨损超限' : '' },
  { id: 'noise', name: '运行异响', result: '正常', reading: '68 dB', limit: '≤ 75 dB', note: '' },
  { id: 'brake', name: '制动装置', result: '正常', reading: '制动距离 2.3 m', limit: '≤ 3.0 m', note: '' },
  { id: 'lock', name: '锁止机构', result: abnormal ? '异常' : '正常', reading: abnormal ? '存在间隙' : '闭合可靠', limit: '无可见间隙', note: abnormal ? '安全压杠锁止存在回弹' : '' },
  { id: 'safety', name: '安全装置', result: '正常', reading: '联锁有效', limit: '动作可靠', note: '' }
]

export const seedRecords: InspectionRecord[] = [
  {
    id: 'INS-240821-01', deviceCode: 'AM-014', deviceName: '高空飞翔', area: 'A区北侧', shift: '早班', inspector: '周宁',
    inspectedAt: '2026-09-28T08:20:00', status: '需整改', risk: '高', stopped: true, assignedTo: '维修一组', dueDate: '2026-09-29',
    items: standardItems(true), evidenceCount: 4, version: 3, baselineVersion: 1, conflicts: [],
    createdAt: '2026-09-28T08:20:00', updatedAt: '2026-09-28T09:35:00'
  },
  {
    id: 'INS-240821-02', deviceCode: 'RC-007', deviceName: '家庭过山车', area: 'B区', shift: '早班', inspector: '李琪',
    inspectedAt: '2026-09-28T09:05:00', status: '整改中', risk: '中', stopped: false, assignedTo: '电气班组', dueDate: '2026-09-30',
    items: standardItems(true), evidenceCount: 2, version: 2, baselineVersion: 1, conflicts: [],
    createdAt: '2026-09-28T09:05:00', updatedAt: '2026-09-28T11:10:00'
  },
  {
    id: 'INS-240821-03', deviceCode: 'CR-021', deviceName: '旋转木马', area: '亲子区', shift: '中班', inspector: '王璟',
    inspectedAt: '2026-09-27T15:40:00', status: '待复测', risk: '低', stopped: false, assignedTo: '检验二组', dueDate: '2026-09-29',
    items: standardItems(), evidenceCount: 3, version: 4, baselineVersion: 1, conflicts: [],
    createdAt: '2026-09-27T15:40:00', updatedAt: '2026-09-28T10:25:00'
  },
  {
    id: 'INS-240821-04', deviceCode: 'WF-003', deviceName: '摩天轮', area: '湖景区', shift: '早班', inspector: '赵帆',
    inspectedAt: '2026-09-27T07:55:00', status: '已关闭', risk: '低', stopped: false, assignedTo: '维修二组', dueDate: '2026-09-28',
    items: standardItems(), evidenceCount: 5, version: 5, baselineVersion: 1, conflicts: [],
    createdAt: '2026-09-27T07:55:00', updatedAt: '2026-09-28T16:20:00'
  }
]

export const seedDevices: Device[] = seedRecords.map((record) => ({
  code: record.deviceCode,
  name: record.deviceName,
  area: record.area,
  open: !record.stopped,
  operatedFromVersion: record.version,
  mergeLocked: false,
  lastDutyAction: record.stopped ? '值班室执行停用隔离' : '值班室维持开放',
  updatedAt: record.updatedAt
}))

export const seedDefects: Defect[] = [
  { id: 'DEF-01-wear', recordId: 'INS-240821-01', deviceCode: 'AM-014', itemId: 'wear', title: '主支撑连接处磨损超限', risk: '高', status: '开放', retestPassed: false, active: true, openedAt: '2026-09-28T08:20:00' },
  { id: 'DEF-01-lock', recordId: 'INS-240821-01', deviceCode: 'AM-014', itemId: 'lock', title: '安全压杠锁止回弹', risk: '高', status: '开放', retestPassed: false, active: true, openedAt: '2026-09-28T08:20:00' },
  { id: 'DEF-02-wear', recordId: 'INS-240821-02', deviceCode: 'RC-007', itemId: 'wear', title: '结构磨损接近限值', risk: '中', status: '整改中', retestPassed: false, active: true, openedAt: '2026-09-28T09:05:00' },
  { id: 'DEF-02-lock', recordId: 'INS-240821-02', deviceCode: 'RC-007', itemId: 'lock', title: '锁止机构存在间隙', risk: '中', status: '整改中', retestPassed: false, active: true, openedAt: '2026-09-28T09:05:00' },
  { id: 'DEF-03-lock', recordId: 'INS-240821-03', deviceCode: 'CR-021', itemId: 'lock', title: '锁止润滑后待复测', risk: '低', status: '待复测', retestPassed: false, active: true, openedAt: '2026-09-27T15:40:00' },
  { id: 'DEF-04-wear', recordId: 'INS-240821-04', deviceCode: 'WF-003', itemId: 'wear', title: '磨损复测合格', risk: '低', status: '已关闭', retestPassed: true, retestRecordId: 'INS-240821-04', releasedByBatch: 'B-SEED-04', active: true, openedAt: '2026-09-27T07:55:00', closedAt: '2026-09-28T16:20:00' }
]

export const seedReleases = [
  { id: 'REL-SEED-04', batchId: 'B-SEED-04', deviceCode: 'WF-003', defectIds: ['DEF-04-wear'], retestRecordId: 'INS-240821-04', status: '已放行' as const, attempts: 1, releasedAt: '2026-09-28T16:20:00', idempotencyKey: 'B-SEED-04' }
]

export const seedAudit: AuditEntry[] = seedRecords.flatMap((record) => [
  { id: `${record.id}-A1`, recordId: record.id, action: '创建检验记录', operator: record.inspector, detail: `${record.deviceName}完成班前检验`, createdAt: record.createdAt, version: 1, active: true, category: '检验' as const },
  ...(record.version > 1 ? [{ id: `${record.id}-A${record.version}`, recordId: record.id, action: record.status, operator: '系统流转', detail: `记录更新至版本 V${record.version}`, createdAt: record.updatedAt, version: record.version, active: true, category: '检验' as const }] : [])
])
