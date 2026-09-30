// 端到端验证：由 esbuild 临时打包后 node 执行（npm run verify）
import { setActivePinia, createPinia } from 'pinia'
import { useInspectionStore } from '../src/stores/inspection'
import { armNextWriteFailure } from '../src/services/sync'

// ---- localStorage shim ----
const memory = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => (memory.has(k) ? memory.get(k)! : null),
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
  clear: () => memory.clear()
}
;(globalThis as any).structuredClone = (v: unknown) => JSON.parse(JSON.stringify(v))

async function main() {
setActivePinia(createPinia())
const store = useInspectionStore()

let passed = 0
function check(name: string, cond: boolean, extra = '') {
  if (!cond) {
    console.error(`✗ ${name} ${extra}`)
    process.exit(1)
  }
  passed += 1
  console.log(`✓ ${name}`)
}

// ============ 1. 初始种子：设备/记录/缺陷/放行已接起来 ============
check('设备/记录/缺陷/放行已关联', store.devices.length === 4 && store.defects.length === 4 && store.releases.length === 1)
check('种子记录基线为 V1', store.records.every((r) => r.baselineVersion === 1))
check('种子实体基线已补齐', store.devices.every((d) => d.baselineRev === 1) && store.defects.every((d) => d.baselineRev === 1))

// ============ 2. 批次A：断网补录（采集时刻+基线），暂存不改实体 ============
let res = store.stageBatch('BATCH-AM014')
check('批次A可暂存', res.ok, res.message)
const batchAId = res.batchId!
const batchA0 = store.batches.find((b) => b.id === batchAId)!
check('批次带采集时刻', batchA0.collectedAt === '2026-09-30T07:42:00')
check('批次带回网时刻', batchA0.uploadedAt === '2026-09-30T09:18:00')
check('批次携带基线（设备/记录/2缺陷）', batchA0.baselines.length === 4)
check('暂存后实体未被改动（设备仍停用）', store.devices.find((d) => d.id === 'DEV-AM-014')!.openState === '停用')
check('暂存后检验记录版本未涨', store.records.find((r) => r.id === 'INS-240821-01')!.version === 3)

// ============ 3. 回网合并：值班室单边重开也要锁定；责任人两边都改并列保留 ============
res = store.uploadAndMerge(batchAId)
check('批次A合并成功', res.ok, res.message)
const deviceA = store.devices.find((d) => d.id === 'DEV-AM-014')!
check('值班室已重开但待确认 -> 重新锁定停用', deviceA.openState === '停用' && deviceA.reopenLocked === true)
const recordA = store.records.find((r) => r.id === 'INS-240821-01')!
check('同一字段两边都改 -> 冲突并列保留', recordA.parallelFields!.some((f) => f.path === 'assignedTo'))
check('文本字段立即并列写入实体', String(recordA.assignedTo).includes('[采集端@维修二组]') && String(recordA.assignedTo).includes('[值班室@维修一组（收尾）]'))
check('仅采集端改的检验项快进采用（磨损 3.6mm 正常）', recordA.items.find((i) => i.id === 'wear')!.reading === '3.6 mm' && recordA.items.find((i) => i.id === 'wear')!.result === '正常')
check('仅值班室改的 openNote 不产生冲突', !deviceA.parallelFields?.some((f) => f.path === 'openNote'))

// 值班长确认前：设备不能重开、记录不能改
check('确认前值班室不能重开设备', !store.setDeviceOpen('DEV-AM-014', true, '强行重开').ok)
check('确认前检验记录不能修改', !store.updateRecord('INS-240821-01', { dueDate: '2026-12-01' }).ok)
check('确认前检验记录不能流转关闭', !store.transition('INS-240821-01', '已关闭', '尝试').ok)

// ============ 4. 值班长确认（文本可并列）-> 复测通过关缺陷、设备开放、生成放行 ============
let confirmRes = store.confirmBatch(batchAId, [
  { path: 'assignedTo', entityKey: 'record:INS-240821-01', resolution: '并列保留' }
])
check('批次A值班长确认成功', confirmRes.ok, confirmRes.message)
check('复测通过 -> 两缺陷关闭', store.defects.filter((d) => d.deviceId === 'DEV-AM-014').every((d) => d.status === '已关闭'))
check('确认后设备恢复开放', deviceA.openState === '开放' && !deviceA.reopenLocked)
check('确认后基线推进到当前版本', deviceA.baselineRev === deviceA.rev && recordA.baselineVersion === recordA.version)
const batchA1 = store.batches.find((b) => b.id === batchAId)!
check('每台放行设备生成一条放行记录', batchA1.releaseIds.length === 1)
check('批次进入已确认待写入', batchA1.status === '已确认待写入')

// ============ 5. 已确认批次不能重放 ============
let threw = false
try { store.replayBatch(batchAId) } catch { threw = true }
check('已确认批次重放抛错并拦截', threw && store.batches.find((b) => b.id === batchAId)!.replayBlocked === true)
check('对已确认批次再次回网合并被拒', !store.uploadAndMerge(batchAId).ok)

// ============ 6. 放行写入失败：只重试这批，不影响批次B ============
const stageB = store.stageBatch('BATCH-RC007')
check('批次B可独立暂存', stageB.ok)

armNextWriteFailure()
let writeRes = await store.writeReleases(batchAId)
check('批次A放行写入失败被捕获并提示只重试这批', !writeRes.ok && writeRes.message.includes('只重试这批'))
check('批次A进入写入失败', store.batches.find((b) => b.id === batchAId)!.status === '写入失败')
const failedRel = store.releases.find((r) => batchA1.releaseIds.includes(r.id))!
check('放行记录登记尝试次数与错误', failedRel.state === '写入失败' && failedRel.attempts === 1 && failedRel.lastError.length > 0)

// 批次B不受批次A失败影响，正常合并
res = store.uploadAndMerge(stageB.batchId!)
check('批次A失败不影响批次B合并', res.ok, res.message)
const deviceB = store.devices.find((d) => d.id === 'DEV-RC-007')!
check('批次B：值班室重开 -> 待确认期间仍锁定停用', deviceB.openState === '停用' && deviceB.reopenLocked)
check('批次B：值班室关闭的 DEF-003 复测未通过 -> 关闭被拒退回待复测',
  store.defects.find((d) => d.id === 'DEF-003')!.status === '待复测' && store.defects.find((d) => d.id === 'DEF-003')!.closeRejected === true)
check('批次B：DEF-003 status 基线待复测/采集端整改中/值班室已关闭 -> 枚举双改冲突待裁决',
  store.defects.find((d) => d.id === 'DEF-003')!.parallelFields!.some((f) => f.path === 'status' && f.resolution === undefined))
check('批次B：责任人文本冲突默认并列',
  store.records.find((r) => r.id === 'INS-240821-02')!.parallelFields!.some((f) => f.path === 'assignedTo' && f.resolution === '并列保留'))

// 枚举冲突未裁决不能确认
const batchBId = stageB.batchId!
const batchB = store.batches.find((b) => b.id === batchBId)!
const textOnly = (batchB.conflicts ?? [])
  .filter((c) => c.path === 'assignedTo')
  .map((c) => ({ path: c.path, entityKey: batchB.changes.find((ch) => ch.path === c.path)!.entityType + ':' + batchB.changes.find((ch) => ch.path === c.path)!.entityId, resolution: '并列保留' as const }))
check('枚举冲突未裁决 -> 确认被拒', !store.confirmBatch(batchBId, textOnly).ok)

// 只重试失败的批次A
check('只有写入失败批次可重试', store.retryFailedBatch(batchAId).ok)
writeRes = await store.writeReleases(batchAId)
check('重试本批后放行成功（不触碰批次B）', writeRes.ok && store.batches.find((b) => b.id === batchBId)!.status === '待值班长确认')
const okRel = store.releases.find((r) => r.id === failedRel.id)!
check('批次A终态已放行，放行 attempts=2', store.batches.find((b) => b.id === batchAId)!.status === '已放行' && okRel.state === '写入成功' && okRel.attempts === 2)
check('已放行批次不能再次写入', !(await store.writeReleases(batchAId)).ok)

// ============ 7. 批次B确认：枚举采采集端，复测未通过 -> 拦截、不放行、设备继续停用 ============
const resolutionsB = (batchB.conflicts ?? []).map((c) => {
  const change = batchB.changes.find((ch) => ch.path === c.path)!
  return { path: c.path, entityKey: `${change.entityType}:${change.entityId}`, resolution: (c.path === 'assignedTo' ? '并列保留' : '采用采集端') as '并列保留' | '采用采集端' }
})
const confirmB = store.confirmBatch(batchBId, resolutionsB)
check('批次B确认流程完成', confirmB.ok)
check('批次B进入已拦截（不予放行）', store.batches.find((b) => b.id === batchBId)!.status === '已拦截')
check('DEF-004 复测通过可关闭', store.defects.find((d) => d.id === 'DEF-004')!.status === '已关闭')
check('DEF-003 复测不通过不能关闭', store.defects.find((d) => d.id === 'DEF-003')!.status !== '已关闭')
check('设备B继续停用', store.devices.find((d) => d.id === 'DEV-RC-007')!.openState === '停用')
check('拦截批次不生成放行', store.batches.find((b) => b.id === batchBId)!.releaseIds.length === 0)
check('设备停用且有缺陷未关 -> 检验记录不能关闭', !store.transition('INS-240821-02', '已关闭', '尝试关闭').ok)

// 后续复测通过、缺陷关闭后，设备可重开
store.submitRetest('DEF-003', '复测通过', '补焊后 4.4mm 合格')
check('复测通过后才能关闭缺陷', store.closeDefect('DEF-003').ok)
check('无未关闭缺陷后值班室可重开', store.setDeviceOpen('DEV-RC-007', true, '复测全通过').ok)

// ============ 8. 审计/待办只按当前有效版本 ============
check('有效审计少于全部历史（旧 rev 被过滤）', store.effectiveAudit.length < store.audit.length,
  `${store.effectiveAudit.length} < ${store.audit.length}`)
check('批次级审计始终保留在有效视图', store.effectiveAudit.some((a) => a.entityType === 'batch'))
check('待办统计：已关闭缺陷计数来自当前版本', store.stats.closed >= 3)

// ============ 9. 旧数据首次打开迁移：补基线、保留原结论 ============
;(globalThis as any).localStorage.clear()
;(globalThis as any).localStorage.setItem('gsb63:inspection-platform', JSON.stringify({
  records: [
    {
      id: 'OLD-1', deviceCode: 'XX-001', deviceName: '旧设备', area: '旧区', shift: '早班', inspector: '旧人',
      inspectedAt: '2026-09-20T08:00:00', status: '已关闭', risk: '中', stopped: false, assignedTo: '旧组', dueDate: '2026-09-21',
      items: [
        { id: 'wear', name: '结构磨损', result: '异常', reading: '9 mm', limit: '≤5', note: '旧异常' },
        { id: 'brake', name: '制动装置', result: '正常', reading: 'ok', limit: '可靠', note: '' }
      ],
      evidenceCount: 1, version: 2, createdAt: '2026-09-20T08:00:00', updatedAt: '2026-09-21T10:00:00'
    }
  ],
  audit: [
    { id: 'a1', recordId: 'OLD-1', action: '创建检验记录', operator: '旧人', detail: '旧审计', createdAt: '2026-09-20T08:00:00' }
  ]
}))
setActivePinia(createPinia())
const migrated = useInspectionStore()
const oldRecord = migrated.records.find((r) => r.id === 'OLD-1')!
check('迁移补齐基线 V1', oldRecord.baselineVersion === 1)
check('迁移派生设备并关联', oldRecord.deviceId === 'DEV-XX-001' && migrated.devices.some((d) => d.id === 'DEV-XX-001'))
check('迁移按异常项派生缺陷并挂回记录', migrated.defects.length === 1 && oldRecord.defectIds.includes('DEF-MIG-01-WEAR'))
check('迁移保留原结论：已闭环记录的缺陷视为复测通过并关闭', migrated.defects[0].status === '已关闭' && migrated.defects[0].retestResult === '复测通过')
check('迁移为已闭环记录补放行记录', migrated.releases.some((r) => r.deviceId === 'DEV-XX-001' && r.state === '写入成功'))
check('迁移审计带标记', migrated.audit.some((a) => a.migrated && a.action === '旧数据迁移'))
check('旧审计补齐 rev/实体类型后仍在当前有效视图', migrated.effectiveAudit.some((a) => a.id === 'a1' && a.entityType === 'record' && a.rev === 2))
const rawV2 = JSON.parse((globalThis as any).localStorage.getItem('gsb63:inspection-platform-v2'))
check('迁移结果落盘 v2，再次打开不重复迁移', rawV2.schema === 2 && rawV2.batches.length === 0)

console.log(`\n全部 ${passed} 项断言通过`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
