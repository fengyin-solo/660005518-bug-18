<template>
  <div class="panel" style="margin-top:12px">
    <h4>📈 实时价格 + K线</h4>
    <div class="chart-wrap">
      <div ref="chart" class="chart" :class="{ dim: !ready }"></div>
      <div v-if="!ready" class="chart-empty">
        <div class="empty-text">{{ emptyText }}</div>
        <button class="retry-btn" @click="retry">重试</button>
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import * as echarts from 'echarts'
import { useTradingStore } from '../store/trading'
import type { Tick } from '../types'

const store = useTradingStore()
const chart = ref<HTMLDivElement>()
let inst: echarts.ECharts | null = null
let resizeObserver: ResizeObserver | null = null
let resizeQueued = false

const ready = ref(false)
const emptyText = ref('暂无行情数据')

// 一个图表点：key 是类目轴上的唯一键（毫秒时间戳），tick 保留原始行情
interface ChartPoint { key: string; ts: number; tick: Tick }

let legacySeq = 0
// 兼容旧推送（没有 ts 字段）：把 HH:MM:SS 换算成毫秒，同一秒内的多个点依次偏移以保证唯一
function resolveTs(t: Tick): number {
  if (typeof t.ts === 'number' && isFinite(t.ts)) return t.ts
  const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(t.time || '')
  if (m) {
    const base = (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000
    return base + (legacySeq++ % 1000)
  }
  return legacySeq++
}

// 坐标轴、折线、提示共用同一份派生序列
function buildSeries(ticks: Tick[]): ChartPoint[] {
  return ticks
    .map(t => ({ tick: t, ts: resolveTs(t) }))
    .filter(p => isFinite(p.ts) && isFinite(p.tick.price))
    .sort((a, b) => a.ts - b.ts)
    .map(p => ({ key: String(p.ts), ts: p.ts, tick: p.tick }))
}

// 标签允许的最小像素间距；小于该宽度时，多个时间点按时间区间合并成一个刻度
const MIN_LABEL_GAP_PX = 56
const NICE_STEPS_MS = [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 900000, 1800000, 3600000]

function pad2(n: number) { return String(n).padStart(2, '0') }
function formatLabel(ts: number, withSeconds: boolean) {
  const d = new Date(ts)
  return withSeconds
    ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
    : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
// 提示里的时间精确到毫秒，用于区分同一秒内的多次报价
function formatTipTime(p: ChartPoint) {
  const ms = String(p.ts % 1000).padStart(3, '0')
  return `${p.tick.time || formatLabel(p.ts, true)}.${ms}`
}

function buildOption(points: ChartPoint[], width: number): echarts.EChartsCoreOption {
  const keys = points.map(p => p.key)
  const byKey = new Map(points.map(p => [p.key, p]))

  // 根据面板宽度计算区间合并步长：刻度过多时按区间合并
  const span = points.length > 1 ? points[points.length - 1].ts - points[0].ts : 0
  const bucketCount = Math.max(1, Math.floor(width / MIN_LABEL_GAP_PX))
  const bucketSpan = span / bucketCount
  const step = NICE_STEPS_MS.find(s => s >= bucketSpan) ?? 3600000
  const withSeconds = step < 60000

  // 每个时间区间只保留第一个点的刻度标签
  let lastBucket = -1
  const labelVisible = (key: string) => {
    const p = byKey.get(key)
    if (!p) return false
    const bucket = Math.floor(p.ts / step)
    if (bucket === lastBucket) return false
    lastBucket = bucket
    return true
  }

  // y 轴范围由同一份序列的取值算出，缩放窗口后也不会与折线取值错位
  const prices = points.map(p => p.tick.price)
  let min = Math.min(...prices)
  let max = Math.max(...prices)
  if (min === max) { min -= 1; max += 1 }
  const pad = (max - min) * 0.1
  min = Math.round((min - pad) * 100) / 100
  max = Math.round((max + pad) * 100) / 100

  return {
    backgroundColor: 'transparent',
    grid: { left: 50, right: 15, top: 10, bottom: 25 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: 'rgba(79,195,247,0.4)' } },
      backgroundColor: 'rgba(15,21,53,0.92)',
      borderColor: '#1e2a5a',
      textStyle: { color: '#e0e0e0', fontSize: 11 },
      // 提示通过类目键回查同一份序列里的行情点，取值与折线点一一对应
      formatter: (raw: unknown) => {
        const param = (Array.isArray(raw) ? raw[0] : raw) as { name?: string }
        const p = param.name != null ? byKey.get(String(param.name)) : undefined
        if (!p) return ''
        const t = p.tick
        return `<div style="font-size:11px;line-height:1.7">
          <div style="color:#94a3b8">${formatTipTime(p)}</div>
          <div>价格 <b style="color:#4fc3f7">${t.price.toFixed(2)}</b></div>
          <div style="color:#94a3b8">买 ${t.bid.toFixed(2)} / 卖 ${t.ask.toFixed(2)}</div>
          <div style="color:#94a3b8">量 ${t.volume}</div>
        </div>`
      }
    },
    xAxis: {
      type: 'category',
      data: keys,
      axisLabel: {
        color: '#94a3b8',
        fontSize: 9,
        interval: (_index: number, value: string) => labelVisible(String(value)),
        formatter: (value: string) => {
          const p = byKey.get(String(value))
          return p ? formatLabel(p.ts, withSeconds) : ''
        }
      }
    },
    yAxis: {
      type: 'value',
      min,
      max,
      axisLabel: { color: '#94a3b8' }
    },
    series: [
      {
        type: 'line',
        // 与类目轴同一个 points 序列顺序映射，提示拿到的就是折线上该点的值
        data: points.map(p => p.tick.price),
        symbol: 'none',
        lineStyle: { color: '#4fc3f7', width: 1.5 },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(79,195,247,0.3)' }, { offset: 1, color: 'rgba(79,195,247,0)' }]) }
      }
    ],
    animation: false
  }
}

function update() {
  if (!inst) return
  const points = buildSeries(store.ticks)
  if (points.length < 3) {
    ready.value = false
    emptyText.value = points.length === 0
      ? (store.tickError || '暂无行情数据，等待行情推送…')
      : `行情点不足（当前 ${points.length} 个），至少需要 3 个点才能绘制折线`
    inst.clear()
    return
  }
  ready.value = true
  const width = inst.getWidth() || chart.value?.clientWidth || 0
  // notMerge 保证窗口缩放后坐标轴范围随序列整体重算，不残留旧范围
  inst.setOption(buildOption(points, width), { notMerge: true })
}

function scheduleResize() {
  if (resizeQueued) return
  resizeQueued = true
  requestAnimationFrame(() => {
    resizeQueued = false
    inst?.resize()
    update()
  })
}

// 切换浏览器标签页再返回时：重新取数并重算刻度
async function onVisible() {
  if (document.hidden || !inst) return
  try { await store.fetchTicks() } catch { store.tickError = '行情数据获取失败，请重试' }
  inst.resize()
  update()
}

async function retry() {
  await store.retryTicks()
  await Promise.resolve()
  update()
}

onMounted(async () => {
  if (!chart.value) return
  inst = echarts.init(chart.value)
  try { await store.fetchTicks() } catch { store.tickError = '行情数据获取失败，请重试' }
  update()
  window.addEventListener('resize', scheduleResize)
  document.addEventListener('visibilitychange', onVisible)
  resizeObserver = new ResizeObserver(scheduleResize)
  resizeObserver.observe(chart.value)
})
watch(() => store.ticks, update, { deep: true })
onUnmounted(() => {
  window.removeEventListener('resize', scheduleResize)
  document.removeEventListener('visibilitychange', onVisible)
  resizeObserver?.disconnect()
  inst?.dispose()
  inst = null
})
</script>
<style scoped>
.panel{background:#0f1535;border-radius:8px;padding:12px;border:1px solid #1e2a5a}
.panel h4{color:#4fc3f7;font-size:13px;margin-bottom:4px}
.chart-wrap{position:relative}
.chart{width:100%;height:300px}
.chart.dim{opacity:0.25}
.chart-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px}
.empty-text{color:#94a3b8;font-size:12px}
.retry-btn{margin-top:6px;padding:4px 18px;background:transparent;border:1px solid #4fc3f7;color:#4fc3f7;border-radius:4px;cursor:pointer;font-size:12px}
.retry-btn:hover{background:rgba(79,195,247,0.12)}
</style>
