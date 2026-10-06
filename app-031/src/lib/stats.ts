// 统计口径（唯一来源）：统计页、下料单、标签、排样页全部从这里取数，
// 不允许各页面各算各的，杜绝「统计页按全部板汇总、下料单只写第一张板」之类不一致。
//
// 统一口径：
// - 件数：所有板 placements 展开后的零件实例数（同一件号多件 = 多行实例，
//   下料单再按柜体+件号合并显示数量，但合计件数与实例数一致）。
// - 面积：零件面积一律按净尺寸 mm²（origLen × origWid）累计，展示时再折 m²。
// - 可再利用余料：遍历「每一张板」的 offcuts，只收 usable（两边 ≥ OFFCUT_MIN_MM）
//   的块，块数与合计面积都来自同一汇总。
// - 封边米数：按零件开料后的实际净尺寸逐边累计（顶/底用长、左/右用宽），
//   mm 求和后 ÷1000 折米，四舍五入保留 2 位。
// - 封边热熔胶：胶量 = 封边总米数 × GLUE_GRAM_PER_EDGE_M，克再 ÷1000 折千克，
//   系数全应用唯一一份（boards.json 的 glueGramPerEdgeMeter），
//   统计页 / 下料单 / 标签不许一处一套。
import type { NestResult, Placement, SheetResult } from '../types'
import boardsData from '../data/boards.json'
import { rebuildFromPlacements } from './cuts'

/** 余料两边达到该边长（mm）才算可再利用；与 boards.json defaults.offcutMinMm 同源。 */
export const OFFCUT_MIN_MM: number = boardsData.defaults.offcutMinMm ?? 300

/** 封边热熔胶用量系数：每米封边耗胶克数（全应用唯一一份）。 */
export const GLUE_GRAM_PER_EDGE_M: number = boardsData.hardware.glueGramPerEdgeMeter

export function allPlacements(result: NestResult | undefined): Placement[] {
  return result ? result.sheets.flatMap((s) => s.placements) : []
}

/** 同批零件总件数 = 各板实例数之和。 */
export function totalPiecesOf(result: NestResult | undefined): number {
  return result ? result.sheets.reduce((a, s) => a + s.placements.length, 0) : 0
}

/** 同批零件净面积合计（mm²）。 */
export function totalUsedAreaMm2(result: NestResult | undefined): number {
  return result ? result.sheets.reduce((a, s) => a + s.usedAreaMm2, 0) : 0
}

/** 综合利用率：Σ零件净面积 / Σ板面积。 */
export function overallUtilization(result: NestResult | undefined): number {
  if (!result || result.sheets.length === 0) return 0
  const total = result.sheets.reduce((a, s) => a + s.boardAreaMm2, 0)
  return total > 0 ? totalUsedAreaMm2(result) / total : 0
}

/**
 * 封边米数（mm 逐边累计后折米，四舍五入 2 位）。
 * 排样内核用同一函数写入 result.edgeBandM，页面只读取，保证米数一致。
 */
export function edgeBandMeters(placements: Placement[]): { exposed: number; normal: number } {
  let exposedMm = 0
  let normalMm = 0
  for (const p of placements) {
    const lenMm =
      p.origLen *
      ((p.edgeBands.includes('top') ? 1 : 0) + (p.edgeBands.includes('bottom') ? 1 : 0))
    const widMm =
      p.origWid *
      ((p.edgeBands.includes('left') ? 1 : 0) + (p.edgeBands.includes('right') ? 1 : 0))
    if (p.exposed) exposedMm += lenMm + widMm
    else normalMm += lenMm + widMm
  }
  const round2 = (mm: number): number => Math.round(mm / 1000 * 100) / 100
  return { exposed: round2(exposedMm), normal: round2(normalMm) }
}

/** 封边总米数（见光 + 非见光）。 */
export function totalEdgeM(result: NestResult | undefined): number {
  if (!result) return 0
  return result.edgeBandM.exposed + result.edgeBandM.normal
}

/** 封边热熔胶用量（kg）= 封边总米数 × 每米克数 ÷ 1000，保留 2 位。 */
export function glueKg(result: NestResult | undefined): number {
  const kg = (totalEdgeM(result) * GLUE_GRAM_PER_EDGE_M) / 1000
  return Math.round(kg * 100) / 100
}

export interface HardwareRow {
  name: string
  value: number
  unit: string
}

/** 五金与胶量：按同一批零件总件数估算，胶量按封边米数折算，统计页与下料单共用。 */
export function hardwareRows(result: NestResult | undefined): HardwareRow[] {
  const h = boardsData.hardware
  const n = totalPiecesOf(result)
  return [
    { name: h.connectorName, value: n * h.connectorPerPart, unit: '套' },
    { name: h.dowelName, value: n * h.dowelPerPart, unit: '个' },
    { name: h.screwName, value: n * h.screwPerPart, unit: '颗' },
    // 封边热熔胶这一行不能丢：没胶封不了边
    { name: h.glueName, value: glueKg(result), unit: 'kg' }
  ]
}

export interface UsableOffcutRow {
  sheet: number // 所在板（1 起，展示为「第 N 张」）
  x: number
  y: number
  wMm: number
  hMm: number
  areaMm2: number
}

/**
 * 可再利用余料：把「每张板」上 usable 的余料都收进来再汇总，
 * 不能只看第一张板。返回明细（带所在板号）与块数、合计面积（mm²）。
 */
export function usableOffcuts(result: NestResult | undefined): {
  list: UsableOffcutRow[]
  count: number
  areaMm2: number
} {
  const list: UsableOffcutRow[] = []
  for (const s of result?.sheets ?? []) {
    for (const o of s.offcuts ?? []) {
      if (o.usable) {
        list.push({
          sheet: s.index + 1,
          x: o.x,
          y: o.y,
          wMm: o.wMm,
          hMm: o.hMm,
          areaMm2: o.areaMm2
        })
      }
    }
  }
  return {
    list,
    count: list.length,
    areaMm2: list.reduce((a, o) => a + o.areaMm2, 0)
  }
}

// ── 下料单零件明细分组 ─────────────────────────────────────────────────────
// 选定的分组路线（两条只能选一条）：
//   A. 按柜体分组，柜内再按件号合并数量 —— 本应用采用此方案。
//   B. 整份单按件号并成一行，柜体只作附注 —— 不采用。
// 选 A 的取舍：师傅按柜体领料时，在该柜分组内就能把同一柜的件一次拿齐，
// 不用跨组核对；代价是同一个件号若出现在多个柜体下，会在单上重复出现多行，
// 单的总行数变多。B 的单子更短、总点数更快，但分拣时要在几个柜体之间来回找，
// 一旦发错版（按 A 发出后改 B，或反之），已发出的下料单与照单贴的标签都要
// 作废重发——换来的只是分拣省事或单子更短，故固定采用 A。

export interface OrderRow {
  code: string
  name: string
  origLen: number
  origWid: number
  qty: number // 该柜内同件号合并后的数量
  grain: Placement['grain']
  edgeBands: Placement['edgeBands']
  exposed: boolean
}

export interface CabinetGroup {
  cabinet: string
  rows: OrderRow[]
  qty: number // 该柜合计件数
}

/**
 * 下料单明细：按柜体分组，柜内同件号（编号+尺寸+纹理+封边+见光一致）
 * 合并为一行并累加数量；合计件数与排样实例数一致。
 */
export function orderGroups(placements: Placement[]): CabinetGroup[] {
  const order = new Map<string, number>() // cabinet -> 首次出现顺序
  const groups = new Map<string, Map<string, OrderRow>>()
  for (const p of placements) {
    const cab = p.cabinet || '未分组'
    if (!order.has(cab)) {
      order.set(cab, order.size)
      groups.set(cab, new Map())
    }
    const key = [
      p.code,
      p.origLen,
      p.origWid,
      p.grain,
      [...p.edgeBands].join('.'),
      p.exposed ? 1 : 0
    ].join('|')
    const rows = groups.get(cab)!
    const exist = rows.get(key)
    if (exist) exist.qty += 1
    else {
      rows.set(key, {
        code: p.code,
        name: p.name,
        origLen: p.origLen,
        origWid: p.origWid,
        qty: 1,
        grain: p.grain,
        edgeBands: [...p.edgeBands],
        exposed: p.exposed
      })
    }
  }
  return [...order.keys()]
    .sort((a, b) => order.get(a)! - order.get(b)!)
    .map((cabinet) => {
      const rows = [...(groups.get(cabinet)?.values() ?? [])]
      return { cabinet, rows, qty: rows.reduce((a, r) => a + r.qty, 0) }
    })
}

// ── 旧结果兼容 ─────────────────────────────────────────────────────────────
// 早先排好样、存在本机 localStorage 的结果可能缺 offcuts（可用余料）或
// adjusted（已微调）等字段；打开统计页/打印时按默认值兼容地接着算，不能空掉。

/** 一张板缺 offcuts 时，按当前 placements 重算剩余矩形并标出可用余料。 */
function fallbackOffcuts(sheet: SheetResult, kerf: number, trim: number) {
  const rebuilt = rebuildFromPlacements(
    sheet.wMm,
    sheet.hMm,
    kerf,
    trim,
    sheet.index,
    sheet.placements
  )
  return (rebuilt?.leftovers ?? [])
    .filter((r) => r.w >= 2 && r.h >= 2)
    .map((r) => ({
      x: Math.round(r.x),
      y: Math.round(r.y),
      wMm: Math.round(r.w),
      hMm: Math.round(r.h),
      areaMm2: Math.round(r.w * r.h),
      usable: r.w >= OFFCUT_MIN_MM - 0.05 && r.h >= OFFCUT_MIN_MM - 0.05
    }))
    .sort((a, b) => b.areaMm2 - a.areaMm2)
}

/**
 * 就地规范化旧排样结果：补齐缺失字段的默认值。
 * 对缺 offcuts / adjusted / usedAreaMm2 等扩展字段的老数据按默认值兼容续算。
 */
export function normalizeResult(
  result: NestResult,
  opts: { kerfMm?: number; trimMm?: number } = {}
): NestResult {
  const kerf = opts.kerfMm ?? boardsData.defaults.kerfMm
  const trim = opts.trimMm ?? boardsData.defaults.trimMm
  for (const s of result.sheets) {
    if (!Array.isArray(s.offcuts)) s.offcuts = fallbackOffcuts(s, kerf, trim)
    if (s.adjusted === undefined) s.adjusted = false
    if (typeof s.usedAreaMm2 !== 'number' || !Number.isFinite(s.usedAreaMm2)) {
      s.usedAreaMm2 = s.placements.reduce((a, p) => a + p.origLen * p.origWid, 0)
    }
    if (typeof s.boardAreaMm2 !== 'number' || !Number.isFinite(s.boardAreaMm2)) {
      s.boardAreaMm2 = s.wMm * s.hMm
    }
    if (typeof s.utilization !== 'number' || !Number.isFinite(s.utilization)) {
      s.utilization = s.boardAreaMm2 > 0 ? s.usedAreaMm2 / s.boardAreaMm2 : 0
    }
    for (const p of s.placements) {
      if (p.adjusted === undefined) p.adjusted = false
      if (!Array.isArray(p.edgeBands)) p.edgeBands = []
      if (!p.cabinet) p.cabinet = '未分组'
    }
  }
  if (!result.edgeBandM || typeof result.edgeBandM.exposed !== 'number') {
    result.edgeBandM = edgeBandMeters(allPlacements(result))
  }
  result.unplaced ??= []
  result.stockShortage ??= []
  result.boardsUsed ??= result.sheets.length
  result.boardsByType ??= {}
  result.baselineBoards ??= result.sheets.length
  result.savedBoards ??= 0
  result.savedCents ??= 0
  result.totalCostCents ??= result.sheets.reduce((a, s) => a + (s.priceCents ?? 0), 0)
  result.elapsedMs ??= 0
  result.generatedAt ??= 0
  return result
}
