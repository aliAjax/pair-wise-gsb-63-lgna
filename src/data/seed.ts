import type { AuditEntry, Defect, Device, InspectionItem, InspectionRecord, ReleaseRecord } from '../types'

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
    items: standardItems(true), evidenceCount: 4, version: 3, baselineVersion: 1,
    createdAt: '2026-09-28T08:20:00', updatedAt: '2026-09-28T09:35:00',
    deviceId: 'DEV-AM-014', defectIds: ['DEF-001', 'DEF-002']
  },
  {
    id: 'INS-240821-02', deviceCode: 'RC-007', deviceName: '家庭过山车', area: 'B区', shift: '早班', inspector: '李琪',
    inspectedAt: '2026-09-28T09:05:00', status: '整改中', risk: '中', stopped: false, assignedTo: '电气班组', dueDate: '2026-09-30',
    items: standardItems(true), evidenceCount: 2, version: 2, baselineVersion: 1,
    createdAt: '2026-09-28T09:05:00', updatedAt: '2026-09-28T11:10:00',
    deviceId: 'DEV-RC-007', defectIds: ['DEF-003', 'DEF-004']
  },
  {
    id: 'INS-240821-03', deviceCode: 'CR-021', deviceName: '旋转木马', area: '亲子区', shift: '中班', inspector: '王璟',
    inspectedAt: '2026-09-27T15:40:00', status: '待复测', risk: '低', stopped: false, assignedTo: '检验二组', dueDate: '2026-09-29',
    items: standardItems(), evidenceCount: 3, version: 4, baselineVersion: 1,
    createdAt: '2026-09-27T15:40:00', updatedAt: '2026-09-28T10:25:00',
    deviceId: 'DEV-CR-021', defectIds: []
  },
  {
    id: 'INS-240821-04', deviceCode: 'WF-003', deviceName: '摩天轮', area: '湖景区', shift: '早班', inspector: '赵帆',
    inspectedAt: '2026-09-27T07:55:00', status: '已关闭', risk: '低', stopped: false, assignedTo: '维修二组', dueDate: '2026-09-28',
    items: standardItems(), evidenceCount: 5, version: 5, baselineVersion: 1,
    createdAt: '2026-09-27T07:55:00', updatedAt: '2026-09-28T16:20:00',
    deviceId: 'DEV-WF-003', defectIds: [], releaseId: 'REL-001'
  }
]

export const seedDevices: Device[] = [
  {
    id: 'DEV-AM-014', code: 'AM-014', name: '高空飞翔', area: 'A区北侧',
    openState: '停用', reopenLocked: false, openNote: '磨损超限，已挂停用牌',
    rev: 2, baselineRev: 1, updatedAt: '2026-09-28T09:35:00',
    recordIds: ['INS-240821-01'], defectIds: ['DEF-001', 'DEF-002']
  },
  {
    id: 'DEV-RC-007', code: 'RC-007', name: '家庭过山车', area: 'B区',
    openState: '开放', reopenLocked: false, openNote: '中风险，限载观察运行',
    rev: 1, baselineRev: 1, updatedAt: '2026-09-28T11:10:00',
    recordIds: ['INS-240821-02'], defectIds: ['DEF-003', 'DEF-004']
  },
  {
    id: 'DEV-CR-021', code: 'CR-021', name: '旋转木马', area: '亲子区',
    openState: '开放', reopenLocked: false, openNote: '待复测，暂缓高峰投放',
    rev: 1, baselineRev: 1, updatedAt: '2026-09-28T10:25:00',
    recordIds: ['INS-240821-03'], defectIds: []
  },
  {
    id: 'DEV-WF-003', code: 'WF-003', name: '摩天轮', area: '湖景区',
    openState: '开放', reopenLocked: false, openNote: '复测通过，正常开放',
    rev: 3, baselineRev: 1, updatedAt: '2026-09-28T16:20:00',
    recordIds: ['INS-240821-04'], defectIds: []
  }
]

export const seedDefects: Defect[] = [
  {
    id: 'DEF-001', deviceId: 'DEV-AM-014', recordId: 'INS-240821-01', title: '主支撑连接处结构磨损超限',
    itemId: 'wear', risk: '高', status: '整改中', retestResult: '未复测', retestNote: '', assignee: '维修一组',
    rev: 2, baselineRev: 1, createdAt: '2026-09-28T08:20:00', updatedAt: '2026-09-28T09:35:00'
  },
  {
    id: 'DEF-002', deviceId: 'DEV-AM-014', recordId: 'INS-240821-01', title: '安全压杠锁止回弹',
    itemId: 'lock', risk: '紧急', status: '整改中', retestResult: '未复测', retestNote: '', assignee: '维修一组',
    rev: 2, baselineRev: 1, createdAt: '2026-09-28T08:20:00', updatedAt: '2026-09-28T09:35:00'
  },
  {
    id: 'DEF-003', deviceId: 'DEV-RC-007', recordId: 'INS-240821-02', title: '轨道接缝磨损接近限值',
    itemId: 'wear', risk: '中', status: '待复测', retestResult: '未复测', retestNote: '', assignee: '电气班组',
    rev: 1, baselineRev: 1, createdAt: '2026-09-28T09:05:00', updatedAt: '2026-09-28T11:10:00'
  },
  {
    id: 'DEF-004', deviceId: 'DEV-RC-007', recordId: 'INS-240821-02', title: '站房安全门联锁响应偏慢',
    itemId: 'lock', risk: '低', status: '整改中', retestResult: '未复测', retestNote: '', assignee: '电气班组',
    rev: 1, baselineRev: 1, createdAt: '2026-09-28T09:05:00', updatedAt: '2026-09-28T11:10:00'
  }
]

export const seedReleases: ReleaseRecord[] = [
  {
    id: 'REL-001', batchId: 'BATCH-SEED-01', deviceId: 'DEV-WF-003', deviceName: '摩天轮',
    defectIds: [], operator: '值班长-郑涛', state: '写入成功', attempts: 1, lastError: '',
    createdAt: '2026-09-28T16:20:00', writtenAt: '2026-09-28T16:20:00', rev: 1
  }
]

export const seedAudit: AuditEntry[] = seedRecords.flatMap((record) => [
  {
    id: `${record.id}-A1`, recordId: record.id, action: '创建检验记录', operator: record.inspector,
    detail: `${record.deviceName}完成班前检验`, createdAt: record.createdAt, rev: 1,
    entityType: 'record' as const
  },
  ...(record.version > 1 ? [{
    id: `${record.id}-A${record.version}`, recordId: record.id, action: record.status, operator: '系统流转',
    detail: `记录更新至版本 V${record.version}`, createdAt: record.updatedAt, rev: record.version,
    entityType: 'record' as const
  }] : [])
])
