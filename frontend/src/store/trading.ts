import { defineStore } from 'pinia'
import { ref } from 'vue'
import axios from 'axios'
import type { Tick, OrderBook, GridConfig, GridResult } from '@/types'
export const useTradingStore = defineStore('trading', () => {
  const loading = ref(false)
  const ticks = ref<Tick[]>([])
  const orderBook = ref<OrderBook | null>(null)
  const gridResult = ref<GridResult | null>(null)
  const wsConnected = ref(false)
  const tickError = ref('')
  const config = ref<GridConfig>({ lowerPrice: 95, upperPrice: 115, gridCount: 20, capitalPerGrid: 1000, initialCapital: 100000 })

  let ws: WebSocket | null = null

  async function fetchTicks() {
    const { data } = await axios.get<{ ticks: Tick[] }>('/api/ticks')
    ticks.value = (data.ticks || []).slice(-60)
    tickError.value = ticks.value.length ? '' : '暂无行情数据'
    return ticks.value
  }

  function connectWS() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
    ws = new WebSocket(`ws://${location.hostname}:8000/ws`)
    ws.onopen = () => { wsConnected.value = true; tickError.value = '' }
    ws.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data)
        if (d.ticks) {
          ticks.value = d.ticks.slice(-60)
          if (ticks.value.length) tickError.value = ''
        }
        if (d.orderBook) orderBook.value = d.orderBook
      } catch { /* 忽略无法解析的推送帧 */ }
    }
    ws.onerror = () => { tickError.value = '行情连接异常' }
    ws.onclose = () => { wsConnected.value = false; if (ws) tickError.value = tickError.value || '行情连接已断开' }
  }

  // 重试：重新拉取一次行情并重建实时连接
  async function retryTicks() {
    tickError.value = ''
    try {
      await fetchTicks()
    } catch {
      tickError.value = '行情数据获取失败，请重试'
    }
    connectWS()
  }

  async function runBacktest() {
    loading.value = true
    try { const { data } = await axios.post('/api/backtest', config.value) ; gridResult.value = data }
    finally { loading.value = false }
  }

  function disconnectWS() { ws?.close(); ws = null; wsConnected.value = false }

  return { loading, ticks, orderBook, gridResult, wsConnected, tickError, config, fetchTicks, connectWS, retryTicks, runBacktest, disconnectWS }
})
