import axios from 'axios'
import type { InspectionDraft, InspectionRecord } from '../types'

const client = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  timeout: 5000
})

export async function loadInspectionSnapshot(fallback: InspectionRecord[]): Promise<InspectionRecord[]> {
  if (!import.meta.env.VITE_API_BASE_URL) return fallback
  try {
    const response = await client.get<InspectionRecord[]>('/inspections')
    return response.data
  } catch {
    return fallback
  }
}

export function createOfflineInspection(draft: InspectionDraft): InspectionRecord {
  const now = new Date().toISOString()
  return {
    id: `INS-${Date.now().toString().slice(-10)}`,
    ...draft,
    inspectedAt: now,
    status: '待检验',
    stopped: false,
    items: [
      { id: 'wear', name: '结构磨损', result: '正常', reading: '待录入', limit: '≤ 5.0 mm', note: '' },
      { id: 'noise', name: '运行异响', result: '正常', reading: '待录入', limit: '≤ 75 dB', note: '' },
      { id: 'brake', name: '制动装置', result: '正常', reading: '待录入', limit: '制动可靠', note: '' },
      { id: 'lock', name: '锁止机构', result: '正常', reading: '待录入', limit: '无可见间隙', note: '' },
      { id: 'safety', name: '安全装置', result: '正常', reading: '待录入', limit: '动作可靠', note: '' }
    ],
    evidenceCount: 0,
    version: 1,
    createdAt: now,
    updatedAt: now
  }
}

export function connectLiveUpdates(onMessage: (message: string) => void): () => void {
  const endpoint = import.meta.env.VITE_WS_URL
  if (!endpoint) return () => undefined
  const socket = new WebSocket(endpoint)
  socket.addEventListener('message', (event) => onMessage(String(event.data)))
  return () => socket.close()
}
