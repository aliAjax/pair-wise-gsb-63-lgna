export type InspectionStatus = '待检验' | '需整改' | '整改中' | '待复测' | '已关闭' | '停用'
export type RiskLevel = '低' | '中' | '高' | '紧急'
export type CheckResult = '正常' | '异常' | '不适用'

export interface InspectionItem {
  id: string
  name: string
  result: CheckResult
  reading: string
  limit: string
  note: string
}

/** 字段级冲突：离线补录与值班室在同一基线上改了同一字段，两个值并列保留，等待人工裁决 */
export interface FieldConflict {
  field: string
  fieldLabel: string
  /** 离线端（检验员断网补录）的值 */
  offlineValue: string
  /** 在线端（值班室已重开设备/关闭缺陷）的值 */
  onlineValue: string
  /** 现场采集时刻，用于审计溯源 */
  collectedAt: string
  resolved?: boolean
  /** 裁决取值：offline | online，未裁决为空 */
  resolution?: 'offline' | 'online'
  resolvedBy?: string
  resolvedAt?: string
}

export interface InspectionRecord {
  id: string
  deviceCode: string
  deviceName: string
  area: string
  shift: string
  inspector: string
  inspectedAt: string
  status: InspectionStatus
  risk: RiskLevel
  stopped: boolean
  assignedTo: string
  dueDate: string
  items: InspectionItem[]
  evidenceCount: number
  version: number
  /** 补录批次合并所依据的基线版本；旧数据迁移时补齐为 1 */
  baselineVersion: number
  /** 三路合并后尚未裁决的并列字段冲突 */
  conflicts: FieldConflict[]
  /** 最近一次并入的补传批次号 */
  lastBatchId?: string
  createdAt: string
  updatedAt: string
}

/** 设备实体：值班室可在检验员断网期间重开/停用设备，恢复开放受合并锁定约束 */
export interface Device {
  code: string
  name: string
  area: string
  /** 正常开放 | 停用隔离 */
  open: boolean
  /** 值班室操作设备时所依据的检验记录版本 */
  operatedFromVersion: number
  /** 存在待值班长确认的合并批次时锁定，锁定期间不能恢复开放 */
  mergeLocked: boolean
  /** 最近一次值班室操作说明 */
  lastDutyAction?: string
  updatedAt: string
}

export type DefectStatus = '开放' | '整改中' | '待复测' | '复测通过' | '已关闭'

export interface Defect {
  id: string
  recordId: string
  deviceCode: string
  itemId: string
  title: string
  risk: RiskLevel
  status: DefectStatus
  /** 关联的复测检验记录项；复测通过后才允许关闭 */
  retestRecordId?: string
  retestPassed: boolean
  /** 关闭缺陷所依据的放行批次 */
  releasedByBatch?: string
  openedAt: string
  closedAt?: string
  /** 有效版本标记：被后续合并取代的旧缺陷条目不参与统计与审计 */
  active: boolean
}

export type ReleaseStatus = '已放行' | '写入失败'
export type BatchStatus = '待确认' | '已合并' | '已确认'

/** 单批复测放行：写入失败只重试本批；放行成功才能关闭缺陷、解除设备锁定 */
export interface ReleaseRecord {
  id: string
  batchId: string
  deviceCode: string
  defectIds: string[]
  retestRecordId: string
  status: ReleaseStatus
  attempts: number
  releasedAt?: string
  /** 幂等键：已确认批次不可重放，同一批次只产生一条有效放行 */
  idempotencyKey: string
}

/** 断网补录的一个上传批次：带现场采集时刻与离线基线版本 */
export interface SyncBatch {
  id: string
  deviceCode: string
  inspector: string
  /** 现场实际采集时刻（断网期间发生） */
  collectedAt: string
  /** 回网上传时刻 */
  uploadedAt: string
  /** 离线开始编辑时所依据的检验记录版本，用于三路合并 */
  baselineVersion: number
  /** 基线时刻的字段快照，三路合并据此判断值班室是否也改过同一字段 */
  baseline: Record<string, string>
  /** 断网期间的字段改动（平铺字段与检验项读数） */
  changes: Record<string, string>
  /** 断网期间补录的复测结果（检验项 id -> 结果），合并触发复测判定 */
  retest?: Record<string, CheckResult>
  status: BatchStatus
  /** 合并出的字段冲突，供值班长确认页裁决 */
  conflictFields: string[]
  mergedAt?: string
  confirmedAt?: string
  confirmedBy?: string
  /** 关联的放行记录 */
  releaseId?: string
}

export interface AuditEntry {
  id: string
  recordId: string
  action: string
  operator: string
  detail: string
  createdAt: string
  /** 归属的检验记录版本；只统计当前有效版本的条目 */
  version: number
  /** 被后续合并/裁决取代后失效，不进入审计与待办统计 */
  active: boolean
  category?: '合并' | '放行' | '设备' | '缺陷' | '检验' | '迁移'
}

export interface InspectionDraft {
  deviceCode: string
  deviceName: string
  area: string
  shift: string
  inspector: string
  risk: RiskLevel
  assignedTo: string
  dueDate: string
}

/** localStorage 持久化结构，schemaVersion 用于旧数据首次打开迁移 */
export interface PersistedState {
  schemaVersion: number
  records: InspectionRecord[]
  devices: Device[]
  defects: Defect[]
  releases: ReleaseRecord[]
  batches: SyncBatch[]
  audit: AuditEntry[]
}
