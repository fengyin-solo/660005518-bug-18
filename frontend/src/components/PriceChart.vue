<template>
  <div class="panel" style="margin-top:12px">
    <h4>📈 实时价格 + K线</h4>
    <div class="chart-wrap">
      <div ref="chart" class="chart"></div>
      <div v-if="state !== 'ok'" class="chart-notice">
        <div class="notice-text">{{ notice }}</div>
        <el-button size="small" type="primary" :loading="retrying" @click="retry">🔄 重试</el-button>
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { ref, computed, watch, onMounted, onActivated, onUnmounted } from 'vue'
import * as echarts from 'echarts'
import { useTradingStore } from '../store/trading'
import type { Tick } from '../types'

const store = useTradingStore()
const chart = ref<HTMLDivElement>()
let inst: echarts.ECharts | null = null
const retrying = ref(false)

const MIN_POINTS = 3
const state = computed<'empty' | 'insufficient' | 'ok'>(() => {
  const n = store.ticks.length
  if (n === 0) return 'empty'
  if (n < MIN_POINTS) return 'insufficient'
  return 'ok'
})
const notice = computed(() => state.value === 'empty'
  ? '暂无行情数据：尚未收到行情推送，请检查连接后重试'
  : `行情数据不足：当前仅 ${store.ticks.length} 个点，至少需要 ${MIN_POINTS} 个点才能绘制折线`)

const SUB = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉']
function subNum(n: number) { return n >= 0 && n <= 9 ? SUB[n] : `(${n})` }

interface ChartView {
  cats: string[]                                   // 内部唯一类目，索引与 ticks 一一对应
  repSet: Set<number>                              // 区间合并后保留刻度的代表点
  labelById: Map<string, string>                   // 类目 -> 刻度文字（同刻加下标区分）
  dupOrd: number[]                                 // 同一时刻在整段序列中的序号
  dupCount: Map<string, number>                    // 同一时刻出现的总次数
}

// 刻度与提示标签的唯一数据源：传入同一份行情序列，一次派生全部展示信息
function buildView(ticks: Tick[], width: number): ChartView {
  const n = ticks.length
  // 1) 同一时刻出现多次：记录各自的序号与次数，供刻度文字与提示区分
  const seen = new Map<string, number>()
  const dupCount = new Map<string, number>()
  const dupOrd = ticks.map((t) => {
    const ord = seen.get(t.time) ?? 0
    seen.set(t.time, ord + 1)
    dupCount.set(t.time, ord + 1)
    return ord
  })
  const cats = ticks.map((t, i) => `${t.time}#${i}`)

  // 2) 刻度过多时按区间合并：根据面板宽度估算可容纳的标签数，等距选代表点
  const LABEL_W = 58 // fontSize:9 的 HH:MM:SS 标签加间隔约需的像素
  const maxLabels = Math.max(2, Math.floor(Math.max(width, 0) / LABEL_W))
  const repSet = new Set<number>()
  if (n > 0) {
    if (n <= maxLabels) ticks.forEach((_, i) => repSet.add(i))
    else for (let j = 0; j < maxLabels; j++) repSet.add(Math.round(j * (n - 1) / (maxLabels - 1)))
  }

  // 3) 仅代表点出文字；代表点中同一时刻仍重复的，追加下标序号区分
  const repTimeOrd = new Map<string, number>()
  const labelById = new Map<string, string>()
  repSet.forEach((i) => {
    const t = ticks[i]
    const ord = repTimeOrd.get(t.time) ?? 0
    repTimeOrd.set(t.time, ord + 1)
  })
  const repSeen = new Map<string, number>()
  repSet.forEach((i) => {
    const t = ticks[i]
    const ord = repSeen.get(t.time) ?? 0
    repSeen.set(t.time, ord + 1)
    const text = (repTimeOrd.get(t.time) ?? 1) > 1 ? `${t.time}${subNum(ord + 1)}` : t.time
    labelById.set(cats[i], text)
  })
  return { cats, repSet, labelById, dupOrd, dupCount }
}

let view = buildView([], 0)

function update() {
  if (!inst || !chart.value) return
  inst.resize()
  if (state.value !== 'ok') { inst.clear(); return }

  // 刻度、坐标轴、提示全部基于同一份 ticks 重算
  const ticks = store.ticks
  view = buildView(ticks, chart.value.clientWidth)

  inst.setOption({
    backgroundColor: 'transparent',
    grid: { left: 50, right: 15, top: 10, bottom: 25 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(15,21,53,0.95)',
      borderColor: '#1e2a5a',
      textStyle: { color: '#e0e0e0', fontSize: 11 },
      axisPointer: { type: 'line', lineStyle: { color: 'rgba(79,195,247,0.35)', width: 1 } },
      // 直接用 dataIndex 回取同一份序列的取值，提示与折线上的点严格对应
      formatter: (raw: unknown) => {
        const list = Array.isArray(raw) ? raw : [raw]
        const p = list[0] as { dataIndex: number }
        const t = ticks[p.dataIndex]
        if (!t) return ''
        const multi = (view.dupCount.get(t.time) ?? 1) > 1
        const tm = multi ? `${t.time}${subNum(view.dupOrd[p.dataIndex] + 1)}` : t.time
        return `<div style="line-height:1.7">
          <div style="color:#4fc3f7;margin-bottom:2px">⏱ ${tm}</div>
          <div>价格 <b style="color:#4fc3f7">${t.price.toFixed(2)}</b></div>
          <div style="color:#94a3b8">买一 ${t.bid.toFixed(2)} / 卖一 ${t.ask.toFixed(2)}</div>
          <div style="color:#94a3b8">成交量 ${t.volume}</div>
        </div>`
      }
    },
    xAxis: {
      type: 'category',
      data: view.cats,
      axisLabel: {
        color: '#94a3b8', fontSize: 9, interval: 0,
        formatter: (val: string) => view.labelById.get(val) ?? ''
      },
      axisTick: { alignWithLabel: true, interval: (i: number) => view.repSet.has(i) }
    },
    yAxis: { type: 'value', scale: true, axisLabel: { color: '#94a3b8' } },
    series: [
      {
        type: 'line',
        data: ticks.map(t => t.price),
        symbol: 'none',
        lineStyle: { color: '#4fc3f7', width: 1.5 },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(79,195,247,0.3)' }, { offset: 1, color: 'rgba(79,195,247,0)' }]) }
      }
    ],
    animation: false
  }, true) // notMerge：长时间运行后避免历史类目残留造成挤压/错位
}

let ro: ResizeObserver | null = null
function onResize() { inst?.resize(); update() }
function onVisible() {
  if (document.hidden) return
  // 从其他页面/标签页返回：重新取数并按当前宽度重算刻度
  if (!store.wsConnected) store.connectWS()
  requestAnimationFrame(onResize)
}

let stopRetry: (() => void) | null = null
function retry() {
  if (retrying.value) return
  retrying.value = true
  store.connectWS()
  const stopWatch = watch(() => store.ticks.length, (len) => { if (len >= MIN_POINTS) finish() })
  const timer = setTimeout(finish, 8000)
  function finish() { stopWatch(); clearTimeout(timer); stopRetry = null; retrying.value = false }
  stopRetry = finish
}

onMounted(() => {
  if (chart.value) {
    inst = echarts.init(chart.value)
    update()
    ro = new ResizeObserver(onResize)
    ro.observe(chart.value)
  }
  window.addEventListener('resize', onResize)
  document.addEventListener('visibilitychange', onVisible)
})
// 兼容 keep-alive 式页面切换：返回时重新取数、重算刻度
onActivated(onVisible)
watch(() => store.ticks, update, { deep: true })
onUnmounted(() => {
  stopRetry?.()
  ro?.disconnect()
  window.removeEventListener('resize', onResize)
  document.removeEventListener('visibilitychange', onVisible)
  inst?.dispose()
  inst = null
})
</script>
<style scoped>
.panel{background:#0f1535;border-radius:8px;padding:12px;border:1px solid #1e2a5a}
.panel h4{color:#4fc3f7;font-size:13px;margin-bottom:4px}
.chart-wrap{position:relative}
.chart{width:100%;height:300px}
.chart-notice{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:rgba(10,14,39,0.72);border-radius:4px;color:#94a3b8;font-size:12px;text-align:center;padding:12px}
.notice-text{line-height:1.6}
</style>
