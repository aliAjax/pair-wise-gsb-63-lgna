import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { seedAudit, seedRecords } from '../data/seed'
import { createOfflineInspection } from '../services/api'
import type { AuditEntry, InspectionDraft, InspectionRecord, InspectionStatus } from '../types'

const STORAGE_KEY = 'gsb63:inspection-platform'

interface PersistedState {
  records: InspectionRecord[]
  audit: AuditEntry[]
}

function readPersisted(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : { records: seedRecords, audit: seedAudit }
  } catch {
    return { records: seedRecords, audit: seedAudit }
  }
}

export const useInspectionStore = defineStore('inspection', () => {
  const initial = readPersisted()
  const records = ref<InspectionRecord[]>(initial.records)
  const audit = ref<AuditEntry[]>(initial.audit)
  const keyword = ref('')
  const status = ref<InspectionStatus | '全部'>('全部')
  const area = ref('全部')
  const liveMessage = ref('本地实时通道已就绪')

  const filtered = computed(() => records.value.filter((record) => {
    const haystack = `${record.id} ${record.deviceCode} ${record.deviceName} ${record.inspector} ${record.assignedTo}`.toLowerCase()
    return (!keyword.value || haystack.includes(keyword.value.toLowerCase()))
      && (status.value === '全部' || record.status === status.value)
      && (area.value === '全部' || record.area === area.value)
  }))

  const stats = computed(() => ({
    total: records.value.length,
    blocked: records.value.filter((item) => item.stopped).length,
    overdue: records.value.filter((item) => item.dueDate < '2026-09-29' && !['已关闭'].includes(item.status)).length,
    closed: records.value.filter((item) => item.status === '已关闭').length
  }))

  function addRecord(draft: InspectionDraft) {
    const record = createOfflineInspection(draft)
    records.value.unshift(record)
    addAudit(record.id, '创建检验记录', draft.inspector, '新建设备班次检验任务')
    return record
  }

  function updateRecord(id: string, patch: Partial<InspectionRecord>, action = '保存检验记录') {
    const record = records.value.find((item) => item.id === id)
    if (!record) return
    Object.assign(record, patch, { version: record.version + 1, updatedAt: new Date().toISOString() })
    addAudit(id, action, '当前用户', `记录更新至版本 V${record.version}`)
  }

  function transition(id: string, next: InspectionStatus, detail: string) {
    const record = records.value.find((item) => item.id === id)
    if (!record) return { ok: false, message: '记录不存在' }
    if (next === '已关闭' && record.items.some((item) => item.result === '异常')) {
      return { ok: false, message: '仍有异常项，不能关闭任务' }
    }
    if (next === '待复测' && !record.stopped && record.risk === '紧急') {
      return { ok: false, message: '紧急风险缺陷必须先执行停用' }
    }
    record.status = next
    record.version += 1
    record.updatedAt = new Date().toISOString()
    addAudit(id, `状态流转：${next}`, '当前用户', detail)
    return { ok: true, message: `已流转至${next}` }
  }

  function addAudit(recordId: string, action: string, operator: string, detail: string) {
    audit.value.unshift({
      id: `${recordId}-${Date.now()}`,
      recordId,
      action,
      operator,
      detail,
      createdAt: new Date().toISOString()
    })
  }

  function resetDemo() {
    records.value = structuredClone(seedRecords)
    audit.value = structuredClone(seedAudit)
  }

  watch([records, audit], () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ records: records.value, audit: audit.value }))
  }, { deep: true })

  return { records, audit, keyword, status, area, liveMessage, filtered, stats, addRecord, updateRecord, transition, resetDemo }
})
