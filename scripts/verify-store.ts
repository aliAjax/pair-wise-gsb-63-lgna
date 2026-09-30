import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'

// --- 最小浏览器环境桩 ---
const memory = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key)
}
;(globalThis as any).window = globalThis
;(globalThis as any).structuredClone = (value: unknown) => JSON.parse(JSON.stringify(value))

const { useInspectionStore } = await import('../src/stores/inspection')

let passed = 0
function test(name: string, fn: () => void) { fn(); passed += 1; console.log(`  ✓ ${name}`) }

setActivePinia(createPinia())
const store = useInspectionStore()

// 选取一个带开放缺陷、停用中的设备（高空飞翔 AM-014）
const recordId = 'INS-240821-01'
const deviceCode = 'AM-014'
const record0 = store.records.find((r) => r.id === recordId)!
const baselineVersion = record0.version
const openDefectCountBefore = store.defects.filter((d) => d.deviceCode === deviceCode && d.active && d.status !== '已关闭').length

console.log('A) 断网补录 → 回网合并 → 锁定 → 确认放行（全流程）')
{
  // 1. 断网补录：两个异常项复测合格，采集时刻早于回网
  const batch = store.queueBatch({
    recordId,
    inspector: '周宁',
    collectedAt: '2026-09-30T07:40',
    changes: {},
    retest: { wear: '正常', lock: '正常' }
  })
  test('补传批次带采集时刻与基线', () => {
    assert.equal(batch.collectedAt, '2026-09-30T07:40')
    assert.equal(batch.baselineVersion, baselineVersion)
    assert.equal(batch.status, '待确认')
  })

  // 2. 合并前设备已停用；尝试（模拟其他入口）确认应被拒
  test('合并前确认被拒', () => assert.equal(store.confirmBatch(batch.id).ok, false))

  // 3. 回网合并
  const merged = store.mergeBatch(batch.id)
  test('合并成功并版本前进', () => {
    assert.equal(merged.ok, true)
    assert.equal(store.records.find((r) => r.id === recordId)!.version, baselineVersion + 1)
  })
  test('合并后设备锁定', () => assert.equal(store.devices.find((d) => d.code === deviceCode)!.mergeLocked, true))
  test('值班长确认前恢复开放被拒绝', () => assert.equal(store.dutySetDeviceOpen(deviceCode, true).ok, false))
  test('锁定期间安全停用仍允许', () => assert.equal(store.dutySetDeviceOpen(deviceCode, false).ok, true))

  // 4. 无冲突直接确认放行
  const confirmed = store.confirmBatch(batch.id)
  test('复测通过 → 确认放行成功', () => assert.equal(confirmed.ok, true))
  test('确认后解除锁定并恢复开放', () => {
    const device = store.devices.find((d) => d.code === deviceCode)!
    assert.equal(device.mergeLocked, false)
    assert.equal(device.open, true)
  })
  test('放行单写入成功（幂等键=批次号）', () => {
    const release = store.releases.find((r) => r.idempotencyKey === batch.id)!
    assert.equal(release.status, '已放行')
  })
  test('关联缺陷复测通过后关闭并记录放行批次', () => {
    const linked = store.defects.filter((d) => d.deviceCode === deviceCode && d.active)
    assert.equal(linked.every((d) => d.status === '已关闭'), true)
    assert.equal(linked.every((d) => d.retestPassed), true)
    assert.equal(linked.every((d) => d.releasedByBatch === batch.id), true)
  })
  test('已确认批次不可重放（合并/确认都被拒）', () => {
    assert.equal(store.mergeBatch(batch.id).ok, false)
    assert.equal(store.confirmBatch(batch.id).ok, false)
    assert.equal(store.retryRelease(batch.id).ok, false)
  })
}

console.log('B) 同一字段两边都改 → 并列保留 → 未裁尽不能确认')
{
  const target = store.records.find((r) => r.id === 'INS-240821-02')!
  const code = target.deviceCode
  // 断网暂存：改派给离线班组
  const batch = store.queueBatch({
    recordId: target.id, inspector: '李琪', collectedAt: '2026-09-30T08:10',
    changes: { assignedTo: '离线补录-维修三组' }
  })
  // 回网前值班室在线改派给另一班组（产生同一字段双方修改）
  test('值班室在线改派成功', () => assert.equal(store.dutyAmend(target.id, { assignedTo: '值班室-电气班组' }).ok, true))

  const mergeResult = store.mergeBatch(batch.id)
  test('合并提示冲突并并列保留', () => {
    assert.equal(mergeResult.ok, true)
    const record = store.records.find((r) => r.id === target.id)!
    const conflict = record.conflicts.find((c) => c.field === 'assignedTo')!
    assert.equal(conflict.offlineValue, '离线补录-维修三组')
    assert.equal(conflict.onlineValue, '值班室-电气班组')
    assert.equal(conflict.resolved, undefined)
  })
  test('未裁决冲突时确认被拒、设备保持锁定', () => {
    assert.equal(store.confirmBatch(batch.id).ok, false)
    assert.equal(store.devices.find((d) => d.code === code)!.mergeLocked, true)
  })
  // 值班长裁决采用离线值
  const resolveResult = store.resolveConflict(target.id, 'assignedTo', 'offline')
  test('裁决后可确认', () => {
    assert.equal(resolveResult.ok, true)
    assert.equal(store.confirmBatch(batch.id).ok, true)
    assert.equal(store.records.find((r) => r.id === target.id)!.assignedTo, '离线补录-维修三组')
    assert.equal(store.devices.find((d) => d.code === code)!.mergeLocked, false)
  })
}

console.log('C) 放行写入失败 → 仅重试该批 → 成功；其他批次不受影响')
{
  const target = store.records.find((r) => r.id === 'INS-240821-03')!
  const code = target.deviceCode
  // 先把该记录的异常项清掉（种子为全正常，直接复测合格批次）
  const batchFail = store.queueBatch({
    recordId: target.id, inspector: '王璟', collectedAt: '2026-09-30T09:00',
    changes: {}, retest: { lock: '正常' }
  })
  const batchOther = store.queueBatch({
    recordId: 'INS-240821-04', inspector: '赵帆', collectedAt: '2026-09-30T09:05',
    changes: { assignedTo: '维修二组（复测确认）' }
  })
  store.mergeBatch(batchFail.id)
  store.forceNextReleaseFail = true
  const failedConfirm = store.confirmBatch(batchFail.id)
  test('放行写入失败时确认不成功、设备仍锁定', () => {
    assert.equal(failedConfirm.ok, false)
    const release = store.releases.find((r) => r.idempotencyKey === batchFail.id)!
    assert.equal(release.status, '写入失败')
    assert.equal(release.attempts, 1)
    assert.equal(store.devices.find((d) => d.code === code)!.mergeLocked, true)
  })
  test('失败批次统计=1，另一个未合并批次不受失败影响', () => {
    assert.equal(store.stats.failedReleases, 1)
    assert.equal(batchOther.status, '待确认')
  })
  // 只重试失败的这批
  const retry = store.retryRelease(batchFail.id)
  test('仅重试该批 → 第 2 次写入成功并解锁', () => {
    assert.equal(retry.ok, true)
    const release = store.releases.find((r) => r.idempotencyKey === batchFail.id)!
    assert.equal(release.status, '已放行')
    assert.equal(release.attempts, 2)
    assert.equal(store.devices.find((d) => d.code === code)!.mergeLocked, false)
  })
  // 另一批正常合并确认
  store.mergeBatch(batchOther.id)
  test('其他批次仍可独立合并确认（未被失败批次拖累）', () => {
    assert.equal(store.confirmBatch(batchOther.id).ok, true)
  })
}

console.log('D) 复测未通过 → 禁止关闭缺陷/不放行，设备维持停用')
{
  // 造一条带异常项的新记录
  const record = store.addRecord({
    deviceCode: 'XT-900', deviceName: '穿梭机', area: 'A区', shift: '晚班',
    inspector: '测试员', risk: '高', assignedTo: '维修一组', dueDate: '2026-10-02'
  })
  // 将一个检验项置为异常并建缺陷
  record.items[0].result = '异常'
  store.defects.push({
    id: 'DEF-XT-1', recordId: record.id, deviceCode: 'XT-900', itemId: record.items[0].id,
    title: '穿梭机结构异常', risk: '高', status: '开放', retestPassed: false, active: true, openedAt: new Date().toISOString()
  })
  store.dutySetDeviceOpen('XT-900', false)
  const batch = store.queueBatch({
    recordId: record.id, inspector: '测试员', collectedAt: '2026-09-30T10:00',
    changes: {}, retest: { wear: '异常' } // 复测仍异常
  })
  store.mergeBatch(batch.id)
  const result = store.confirmBatch(batch.id)
  test('复测未通过：确认合并但不放行', () => {
    assert.equal(result.ok, true)
    assert.match(result.message, /复测未通过/)
  })
  test('缺陷仍开放、设备维持停用、无放行单', () => {
    const defect = store.defects.find((d) => d.id === 'DEF-XT-1')!
    assert.notEqual(defect.status, '已关闭')
    assert.equal(store.devices.find((d) => d.code === 'XT-900')!.open, false)
    assert.equal(store.releases.some((r) => r.idempotencyKey === batch.id), false)
  })
  test('缺陷未复测时值班室关闭被拒', () => {
    assert.equal(store.dutyCloseDefect('DEF-XT-1').ok, false)
  })
}

console.log('E) 审计与待办只按当前有效版本')
{
  // 找一个经历过版本前进的记录，其早期版本审计不应出现在 effectiveAudit
  const record = store.records.find((r) => r.id === recordId)!
  const effectiveForRecord = store.effectiveAudit.filter((a) => a.recordId === record.id)
  test('有效审计只含当前版本号条目', () => {
    assert.ok(effectiveForRecord.length > 0)
    assert.equal(effectiveForRecord.every((a) => a.version === record.version), true)
  })
  test('全量审计中存在旧版本条目（可追溯但不计数）', () => {
    const all = store.audit.filter((a) => a.recordId === record.id)
    assert.ok(all.some((a) => a.version !== record.version))
  })
  test('待办统计口径不含已关闭缺陷', () => {
    const open = store.stats.openDefects
    const actualOpen = store.defects.filter((d) => d.active && d.status !== '已关闭').length
    assert.equal(open, actualOpen)
  })
}

console.log(`\n全部 ${passed} 个 store 流程用例通过`)
