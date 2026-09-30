<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import { NDialogProvider, NMessageProvider } from 'naive-ui'
import { useInspectionStore } from './stores/inspection'
import { connectLiveUpdates } from './services/api'

const route = useRoute()
const store = useInspectionStore()
let disconnect: () => void = () => undefined

const pageTitle = computed(() => {
  if (route.name === 'sync') return '断网补录与回网合并'
  if (route.name === 'defects') return '缺陷处置看板'
  if (route.name === 'audit') return '检验审计'
  if (route.name === 'record') return '检验任务详情'
  return '日常检验总览'
})

onMounted(() => {
  disconnect = connectLiveUpdates((message) => { store.liveMessage = message })
})
onUnmounted(() => disconnect())
</script>

<template>
  <NMessageProvider>
    <NDialogProvider>
      <div class="app-shell">
        <aside class="sidebar">
          <div class="brand">
            <span class="brand-mark">安</span>
            <div>
              <strong>游乐设施检验台</strong>
              <small>设备安全与缺陷闭环</small>
            </div>
          </div>
          <nav>
            <RouterLink to="/"><span>01</span>检验总览</RouterLink>
            <RouterLink to="/sync"><span>02</span>断网补录·合并</RouterLink>
            <RouterLink to="/defects"><span>03</span>缺陷处置</RouterLink>
            <RouterLink to="/audit"><span>04</span>操作审计</RouterLink>
          </nav>
          <div class="sidebar-status">
            <i />
            <div>
              <strong>{{ store.liveMessage }}</strong>
              <small>数据保存在本机浏览器</small>
            </div>
          </div>
        </aside>
        <main>
          <header class="topbar">
            <div>
              <p>设备安全运营中心 / 现场检验</p>
              <h1>{{ pageTitle }}</h1>
            </div>
            <div class="session">
              <span>值班检验员</span>
              <strong>周宁</strong>
            </div>
          </header>
          <RouterView />
        </main>
      </div>
    </NDialogProvider>
  </NMessageProvider>
</template>
