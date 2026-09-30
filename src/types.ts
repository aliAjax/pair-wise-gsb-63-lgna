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
  /** 当前有效版本号（乐观锁），每次落库修改 +1 */
  version: number
  /** 补录批次合并所依据的基线版本，老数据迁移时补齐 */
  baselineVersion: number
  createdAt: string
  updatedAt: string
  /** 关联实体 id，用于把设备、缺陷、放行串起来 */
  deviceId: string
  defectIds: string[]
  releaseId?: string
  /** 断网补录后与值班室改动冲突、并列保留的字段：字段路径 -> 双端取值 */
  parallelFields?: ParallelField[]
  /** 挂起的合并批次，值班长确认前记录处于待裁决状态 */
  pendingBatchId?: string
}

export interface AuditEntry {
  id: string
  recordId: string
  action: string
  operator: string
  detail: string
  createdAt: string
  /** 该次操作作用于哪个版本；实体当前版本与之不符即非当前有效版本 */
  rev: number
  /** 关联实体类型，审计只按当前有效版本过滤 */
  entityType: 'record' | 'device' | 'defect' | 'release' | 'batch'
  /** 迁移产生的审计条目标记，不影响“只按当前有效版本统计”的口径 */
  migrated?: boolean
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

// ---------------------------------------------------------------------------
// 断网补录 / 回网合并 领域模型
// ---------------------------------------------------------------------------

export type EntityType = 'device' | 'record' | 'defect'

export type DeviceOpenState = '开放' | '停用'

export interface Device {
  id: string
  code: string
  name: string
  area: string
  openState: DeviceOpenState
  /** 值班室重开后、等待值班长确认合并批次期间锁定为 true */
  reopenLocked: boolean
  openNote: string
  rev: number
  baselineRev: number
  updatedAt: string
  recordIds: string[]
  defectIds: string[]
  pendingBatchId?: string
  parallelFields?: ParallelField[]
}

export type DefectStatus = '待处理' | '整改中' | '待复测' | '复测通过' | '已关闭'
export type RetestResult = '未复测' | '复测通过' | '复测不通过'

export interface Defect {
  id: string
  deviceId: string
  recordId: string
  title: string
  itemId: string
  risk: RiskLevel
  status: DefectStatus
  retestResult: RetestResult
  retestNote: string
  assignee: string
  /** 值班室曾关闭过该缺陷（合并时若复测未通过则判定为“关闭被拒”） */
  closeRejected?: boolean
  rev: number
  baselineRev: number
  createdAt: string
  updatedAt: string
  closedAt?: string
  parallelFields?: ParallelField[]
  pendingBatchId?: string
}

export type ReleaseState = '待写入' | '写入成功' | '写入失败'

export interface ReleaseRecord {
  id: string
  batchId: string
  deviceId: string
  deviceName: string
  /** 放行只针对复测通过、已关闭的缺陷 */
  defectIds: string[]
  operator: string
  state: ReleaseState
  attempts: number
  lastError: string
  createdAt: string
  writtenAt?: string
  rev: number
}

export interface ParallelField {
  /** 字段路径，如 assignedTo / items.wear.reading / openNote */
  path: string
  label: string
  /** 采集端（断网补录）的值 */
  offlineValue: string
  /** 值班室（在线并发改动）的值 */
  dutyValue: string
  /** 基线值，三方合并的共同祖先 */
  baseValue: string
  /** 值班长确认时选择保留方式 */
  resolution?: '并列保留' | '采用采集端' | '采用值班室'
  confirmedValue?: string
}

export type BatchStatus =
  | '待合并'       // 已回网，尚未执行三方合并
  | '待值班长确认' // 合并完成，设备保持锁定
  | '已确认待写入' // 值班长已确认，等待放行写入
  | '写入失败'     // 有放行写入失败，只能重试本批
  | '已拦截'       // 复测未通过，确认后设备继续停用、不予放行（终态）
  | '已放行'       // 本批放行全部写入成功，终态

export type FieldSource = 'offline' | 'duty'

export interface BatchChange {
  entityType: EntityType
  entityId: string
  /** 点分路径；检验项使用 items.<itemId>.<field> */
  path: string
  value: string
  /** 字段中文名，仅用于场景说明/界面展示 */
  label?: string
}

export interface SyncBatch {
  id: string
  inspector: string
  /** 采集时刻（断网现场实际采集，不是回网时间） */
  collectedAt: string
  /** 回网补传时刻 */
  uploadedAt: string
  status: BatchStatus
  /** 批次内每个实体的基线快照（三方合并的共同祖先） */
  baselines: Array<{ entityType: EntityType; entityId: string; rev: number; snapshot: Record<string, unknown> }>
  changes: BatchChange[]
  /** 合并产物 */
  conflicts?: ParallelField[]
  mergedAt?: string
  mergeReport?: string[]
  /** 值班长确认 */
  confirmedBy?: string
  confirmedAt?: string
  /** 放行记录 id（一批一组放行） */
  releaseIds: string[]
  /** 已确认批次重放时直接拒绝 */
  replayBlocked?: boolean
}
