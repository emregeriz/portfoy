import { useTable } from './useTable'
import type { TradeWithRefs } from '../types/db'

/** Alım/satım kayıtları hesap ve varlık bilgisiyle birlikte okunur */
export const TRADE_SELECT =
  '*, accounts:account_id (id, name, type), assets:asset_id (id, symbol, name, kind)'

/** Alım/satım defteri — tarihe göre yeniden eskiye */
export function useTrades(userId?: string | null) {
  return useTable<TradeWithRefs>('trades', {
    userId: userId ?? null,
    orderBy: 'trade_date',
    ascending: false,
    select: TRADE_SELECT,
  })
}
