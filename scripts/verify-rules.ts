import assert from 'node:assert/strict'
import {
  threeWayMerge, resolveConflictValue, batchConfirmable, migratePersisted, flattenRecord
} from '../src/services/sync'
import type { InspectionRecord, SyncBatch } from '../src/types'

function makeRecord(overrides: Partial<InspectionRecord> = {}): InspectionRecord {
  return {
    id: 'R1', deviceCode: 'D-1', deviceName: '测试设备', area: 'A区', shift: '早班', inspector: '甲',
    inspectedAt: '2026-09-30T08:00', status: '需整改', risk: '高', stopped: true, assignedTo: '一组',
    dueDate: '2026-10-01',
    items: [
      { id: 'wear', name: '磨损', result: '异常', reading: '6.8', limit: '≤5', note: '超限' },
      { id: 'lock', name: '锁止', result: '异常', reading: '间隙', limit: '无', note: '回弹' }
    ],
    evidenceCount: 0, version: 3, baselineVersion: 1, conflicts: [],
    createdAt: '2026-09-28T08:00', updatedAt: '2026-09-29T08:00', ...overrides
  }
}

function makeBatch(record: InspectionRecord, changes: Record<string, string>, retest?: SyncBatch['retest']): SyncBatch {
  return {
    id: 'B-1', deviceCode: record.deviceCode, inspector: '甲',
    collectedAt: '2026-09-30T07:30', uploadedAt: '', baselineVersion: record.version,
    baseline: flattenRecord(record), changes, retest, status: '待确认', conflictFields: []
  }
}

let passed = 0
function test(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

console.log('1) 三路合并：仅离线改过 → 取离线值')
{
  const record = makeRecord()
  const batch = makeBatch(record, { assignedTo: '二组（离线改派）' })
  const { record: merged, conflicts, changedFields } = threeWayMerge(record, batch)
  test('离线改动生效', () => assert.equal(merged.assignedTo, '二组（离线改派）'))
  test('无冲突', () => assert.equal(conflicts.length, 0))
  test('版本前进、基线指向旧版本', () => {
    assert.equal(merged.version, 4)
    assert.equal(merged.baselineVersion, 3)
  })
  test('changedFields 记录采纳字段', () => assert.deepEqual(changedFields, ['assignedTo']))
}

console.log('2) 三路合并：仅值班室改过 → 保留在线值，离线不覆盖')
{
  const online = makeRecord({ version: 4, assignedTo: '值班室改派-电气班' })
  // 离线基线是 V3：责任人“一组”，离线没改责任人，只改了截止日
  const baseV3 = makeRecord()
  const batch = makeBatch(baseV3, { dueDate: '2026-10-05' })
  batch.baselineVersion = 3
  const { record: merged } = threeWayMerge(online, batch)
  test('值班室责任人保留', () => assert.equal(merged.assignedTo, '值班室改派-电气班'))
  test('离线截止日生效', () => assert.equal(merged.dueDate, '2026-10-05'))
}

console.log('3) 同一字段两边都改 → 并列保留为冲突')
{
  const online = makeRecord({ version: 4, assignedTo: '值班室-电气班' })
  const baseV3 = makeRecord()
  const batch = makeBatch(baseV3, { assignedTo: '离线-维修二组' })
  const { record: merged, conflicts } = threeWayMerge(online, batch)
  test('产生 1 个冲突', () => assert.equal(conflicts.length, 1))
  test('字段未被任一方直接覆盖', () => assert.equal(merged.assignedTo, '值班室-电气班'))
  test('两个值并列保留', () => {
    const conflict = merged.conflicts[0]
    assert.equal(conflict.offlineValue, '离线-维修二组')
    assert.equal(conflict.onlineValue, '值班室-电气班')
    assert.equal(conflict.resolved, undefined)
    assert.equal(conflict.collectedAt, '2026-09-30T07:30')
  })
}

console.log('4) 检验项级别的冲突 + 复测判定')
{
  // 值班室 V4 复测认为 wear 仍异常（在线侧），离线现场复测判正常 → 两边取值冲突
  const online = makeRecord({ version: 4 })
  const batch = makeBatch(makeRecord(), {}, { wear: '正常', lock: '正常' })
  // 在线 V4 与基线 V3 的 wear 取值一致（异常），离线复测改为正常：仅离线改 → 直接采纳
  const { record: merged, conflicts, retestResults } = threeWayMerge(online, batch)
  test('仅离线复测改动时 wear 采纳为正常', () => assert.equal(merged.items.find((i) => i.id === 'wear')!.result, '正常'))
  test('lock 复测离线合格生效', () => assert.equal(merged.items.find((i) => i.id === 'lock')!.result, '正常'))
  test('无冲突，复测整体通过', () => {
    assert.equal(conflicts.length, 0)
    assert.equal(retestResults.__all__, true)
  })

  // 冲突场景：值班室在 V4 把 wear 判为异常（与基线相同但有独立在线结论），
  // 用在线版本构造一次“值班室改判”：基线正常 → 在线异常、离线复测正常
  const baseNormal = makeRecord()
  baseNormal.items[0].result = '正常'
  const onlineAbn = makeRecord({ version: 4 })
  onlineAbn.items[0].result = '异常'
  const batch2 = makeBatch(baseNormal, {}, { wear: '正常' })
  const outcome2 = threeWayMerge(onlineAbn, batch2)
  test('在线异常 / 离线正常时 wear 结果并列冲突', () => assert.equal(outcome2.conflicts.some((c) => c.field === 'item:wear.result'), true))
  test('存在未裁决的异常分歧时复测不通过', () => assert.equal(outcome2.retestResults.__all__, false))
  const offlineWins = resolveConflictValue(outcome2.record, 'item:wear.result', 'offline')
  test('裁决离线值后 wear 正常', () => assert.equal(offlineWins.items[0].result, '正常'))
  const onlineWins = resolveConflictValue(outcome2.record, 'item:wear.result', 'online')
  test('裁决在线值后 wear 异常且冲突已解', () => {
    assert.equal(onlineWins.items[0].result, '异常')
    assert.equal(onlineWins.conflicts[0].resolved, true)
  })
}

console.log('5) 全部复测合格（无冲突）→ 复测通过')
{
  const online = makeRecord()
  const batch = makeBatch(online, {}, { wear: '正常', lock: '正常' })
  const { retestResults, conflicts } = threeWayMerge(online, batch)
  test('无冲突且复测通过', () => {
    assert.equal(conflicts.length, 0)
    assert.equal(retestResults.__all__, true)
  })
}

console.log('6) batchConfirmable：冲突裁尽才可确认')
{
  const online = makeRecord({ version: 4, assignedTo: '在线' })
  const batch = makeBatch(makeRecord(), { assignedTo: '离线' })
  const { record: merged } = threeWayMerge(online, batch)
  batch.status = '已合并'
  batch.conflictFields = ['assignedTo']
  test('有未裁决冲突不可确认', () => assert.equal(batchConfirmable(merged, batch), false))
  const resolved = resolveConflictValue(merged, 'assignedTo', 'offline')
  test('裁决后可确认', () => assert.equal(batchConfirmable(resolved, batch), true))
  const confirmedBatch = { ...batch, status: '已确认' as const }
  test('已确认批次不再 confirmable（防重放前置条件）', () => assert.equal(batchConfirmable(resolved, confirmedBatch), false))
}

console.log('7) 旧数据首次迁移：补齐基线、保留原结论')
{
  const legacy = {
    records: [makeRecord({ conflicts: undefined as unknown as never[] })],
    audit: [{ id: 'old-a1', recordId: 'R1', action: '创建检验记录', operator: '甲', detail: '老数据', createdAt: '2026-09-28T08:00' }]
  }
  const { state, migrated } = migratePersisted(legacy)
  test('识别为需要迁移', () => assert.equal(migrated, true))
  test('schemaVersion=2', () => assert.equal(state.schemaVersion, 2))
  test('老记录补 baselineVersion=1 且原状态/版本不变', () => {
    assert.equal(state.records[0].baselineVersion, 1)
    assert.equal(state.records[0].status, '需整改')
    assert.equal(state.records[0].version, 3)
    assert.deepEqual(state.records[0].conflicts, [])
  })
  test('补出设备实体并按原 stopped 结论恢复', () => {
    assert.equal(state.devices.length, 1)
    assert.equal(state.devices[0].open, false)
  })
  test('异常项补出缺陷，已关闭结论保留', () => {
    assert.equal(state.defects.length, 2)
    assert.equal(state.defects.every((d) => d.active), true)
  })
  test('老审计保留并标记当前有效，新增迁移审计', () => {
    const old = state.audit.find((a) => a.id === 'old-a1')!
    assert.equal(old.active, true)
    assert.equal(old.version, 3)
    assert.ok(state.audit.some((a) => a.category === '迁移'))
  })
}

console.log('8) 已关闭记录迁移后原结论保留（不重新打开）')
{
  const closed = makeRecord({
    status: '已关闭',
    stopped: false,
    items: [
      { id: 'wear', name: '磨损', result: '正常', reading: '2.1', limit: '≤5', note: '' },
      { id: 'lock', name: '锁止', result: '正常', reading: '可靠', limit: '无', note: '' }
    ]
  })
  const { state } = migratePersisted({ records: [closed], audit: [] })
  test('全部检验项正常则不补缺陷', () => assert.equal(state.defects.length, 0))
  test('设备按原结论开放', () => assert.equal(state.devices[0].open, true))
  test('记录原已关闭结论保留', () => assert.equal(state.records[0].status, '已关闭'))
}

console.log(`\n全部 ${passed} 个用例通过`)
