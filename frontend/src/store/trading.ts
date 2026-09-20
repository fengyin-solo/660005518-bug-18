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
  const config = ref<GridConfig>({ lowerPrice: 95, upperPrice: 115, gridCount: 20, capitalPerGrid: 1000, initialCapital: 100000 })

  let ws: WebSocket | null = null
  function connectWS() {
    // 重试或页面重新激活时可能再次进入，先清掉旧连接，避免多个 socket 并存
    if (ws) { try { ws.close() } catch {} ws = null }
    wsConnected.value = false
    const sock = new WebSocket(`ws://${location.hostname}:8000/ws`)
    ws = sock
    sock.onopen = () => { if (ws === sock) wsConnected.value = true }
    sock.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data)
        if (d.ticks) ticks.value = d.ticks.slice(-60)
        if (d.orderBook) orderBook.value = d.orderBook
      } catch {}
    }
    sock.onclose = () => { if (ws === sock) { wsConnected.value = false; ws = null } }
  }

  async function runBacktest() {
    loading.value = true
    try { const { data } = await axios.post('/api/backtest', config.value) ; gridResult.value = data }
    finally { loading.value = false }
  }

  function disconnectWS() { ws?.close(); ws = null; wsConnected.value = false }

  return { loading, ticks, orderBook, gridResult, wsConnected, config, connectWS, runBacktest, disconnectWS }
})
