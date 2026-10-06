// 共享统计口径：统计页、下料单（打印导出）、标签、排样页总览全部从这里取数，
// 不许各页面自己各算一套（改一处别处必须跟着刷新；余料、封边、胶量、件数/面积
// 在统计页与下料单上必须完全一致）。
//
// 所有函数对「早先版本存到本机、缺字段」的排样结果做默认值兼容（见 store.migrateJob）：
// 缺 offcuts / adjusted / edgeBandM 时按默认值接着算，不抛错、不把页面留空。
import type {
  EdgeSide,
  GrainDemand,
  NestResult,
  OffcutInfo,
  Placement,
  SheetResult
} from '../types'
import boardsData from '../data/boards.json'

/** 可用余料门槛（mm）：两边都 ≥ 该值才登记；与排样内核共用同一份配置。 */
export const OFFCUT_MIN_MM: number = boardsData.defaults.offcutMinMm ?? 300

/** 封边热熔胶折算系数（克/米封边）：统计页、下料单、标签只准用这一个系数。 */
export const GLUE_GRAM_PER_EDGE_METER: number = boardsData.hardware.glueGramPerEdgeMeter

export function sheetsOf(r?: NestResult | null): SheetResult[] {
  return r?.sheets ?? []
}

export function placementsOf(r?: NestResult | null): Placement[] {
  return sheetsOf(r).flatMap((s) => s.placements ?? [])
}

/**
 * 封边米数：按零件开料后的实际净尺寸逐边累加（毫米换米），见光件 / 非见光件分列。
 * 排样内核（packing.ts）也调用本函数，保证单据与内核同一口径。
 */
export function edgeMetersOf(placements: Placement[]): { exposed: number; normal: number } {
  let exposedMm = 0
  let normalMm = 0
  for (const pl of placements) {
    const lenMm =
      (pl.edgeBands.includes('top') ? 1 : 0) + (pl.edgeBands.includes('bottom') ? 1 : 0)
    const widMm =
      (pl.edgeBands.includes('left') ? 1 : 0) + (pl.edgeBands.includes('right') ? 1 : 0)
    const mm = pl.origLen * lenMm + pl.origWid * widMm
    if (pl.exposed) exposedMm += mm
    else normalMm += mm
  }
  const round2 = (v: number): number => Math.round(v / 10) / 100 // mm 求和后 /1000，再保留 2 位
  return { exposed: round2(exposedMm), normal: round2(normalMm) }
}

/** 封边合计米数（见光 + 非见光，2 位小数）。 */
export function totalEdgeMeters(r?: NestResult | null): { exposed: number; normal: number; total: number } {
  const m = edgeMetersOf(placementsOf(r))
  return { ...m, total: Math.round((m.exposed + m.normal) * 100) / 100 }
}

/** 封边热熔胶用量（kg）＝封边合计米数 × 系数(克/米) ÷ 1000，与所印封边米数同源。 */
export function glueWeightKg(r?: NestResult | null): number {
  return (totalEdgeMeters(r).total * GLUE_GRAM_PER_EDGE_METER) / 1000
}

/** 同一批零件的件数（= 各板就位零件数 = 标签张数 = 下料明细并组后的数量合计）。 */
export function totalPieces(r?: NestResult | null): number {
  return placementsOf(r).length
}

/** 同一批零件的净面积（mm²，按件实际净尺寸，不含锯路）。 */
export function totalPartAreaMm2(r?: NestResult | null): number {
  return placementsOf(r).reduce((a, p) => a + p.origLen * p.origWid, 0)
}

/** 综合利用率：Σ零件净面积 / Σ板面积（分子不含锯路）。 */
export function overallUtilization(r?: NestResult | null): number {
  const sheets = sheetsOf(r)
  const total = sheets.reduce((a, s) => a + s.boardAreaMm2, 0)
  if (total <= 0) return 0
  return sheets.reduce((a, s) => a + s.usedAreaMm2, 0) / total
}

export function utilizationRange(r?: NestResult | null): { min: number; max: number } {
  const us = sheetsOf(r).map((s) => s.utilization ?? 0)
  if (us.length === 0) return { min: 0, max: 0 }
  return { min: Math.min(...us), max: Math.max(...us) }
}

/** 旧结果里余料可能缺 usable/areaMm2：按门槛与尺寸补默认值。 */
export function normalizeOffcut(o: OffcutInfo | undefined | null): OffcutInfo | null {
  if (!o) return null
  const wMm = o.wMm
  const hMm = o.hMm
  if (!Number.isFinite(wMm) || !Number.isFinite(hMm) || wMm < 2 || hMm < 2) return null
  const usable = o.usable ?? (wMm >= OFFCUT_MIN_MM && hMm >= OFFCUT_MIN_MM)
  const areaMm2 = o.areaMm2 ?? Math.round(wMm * hMm)
  return { x: o.x ?? 0, y: o.y ?? 0, wMm, hMm, areaMm2, usable }
}

export interface UsableOffcutRow {
  sheet: number // 1 起，所在板序号
  wMm: number
  hMm: number
  areaMm2: number
}

/**
 * 可再利用余料：每张板上的都算（≥300×300mm），再汇总块数与合计面积。
 * 统计页与下料单共用，禁止只取第一张板。
 */
export function usableOffcuts(r?: NestResult | null): {
  list: UsableOffcutRow[]
  count: number
  areaMm2: number
} {
  const list: UsableOffcutRow[] = []
  for (const s of sheetsOf(r)) {
    for (const raw of s.offcuts ?? []) {
      const o = normalizeOffcut(raw)
      if (o?.usable) {
        list.push({ sheet: s.index + 1, wMm: o.wMm, hMm: o.hMm, areaMm2: o.areaMm2 })
      }
    }
  }
  return {
    list,
    count: list.length,
    areaMm2: list.reduce((a, o) => a + o.areaMm2, 0)
  }
}

export interface OrderRow {
  code: string
  name: string
  origLen: number
  origWid: number
  qty: number
  grain: GrainDemand
  edgeBands: EdgeSide[]
  exposed: boolean
}

export interface CabinetGroup {
  cabinet: string
  rows: OrderRow[]
  qty: number // 柜内各件号数量合计
}

/**
 * 下料单零件明细分组（路线 A）：
 * 先按柜体分组（师傅照单按柜领料，一个柜的料一次拿齐，不用在几个柜之间来回找），
 * 柜内再按件号(code)合并数量——二十块同样的层板只印一行、数量列写 20。
 * 代价：同一件号分布在多个柜体时会在不同柜组各占一行、单据行数变多
 * （路线 B「整份单按件号并一行、柜体仅附注」单子更短，但分拣要跨柜翻找，故不取）。
 *
 * 注意：分组只并数量，尺寸/纹理/封边/见光取该件号首件；若同件号这些字段不一致，
 * 视为清单录入异常（不同件被编了同一个号），仍按首件展示。
 */
export function cabinetOrderGroups(r?: NestResult | null): CabinetGroup[] {
  const groups = new Map<string, Map<string, OrderRow>>()
  const order: string[] = []
  for (const p of placementsOf(r)) {
    let byCode = groups.get(p.cabinet)
    if (!byCode) {
      byCode = new Map()
      groups.set(p.cabinet, byCode)
      order.push(p.cabinet)
    }
    const row = byCode.get(p.code)
    if (row) {
      row.qty += 1
    } else {
      byCode.set(p.code, {
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
  return order.map((cabinet) => {
    const rows = [...(groups.get(cabinet)?.values() ?? [])]
    return { cabinet, rows, qty: rows.reduce((a, row) => a + row.qty, 0) }
  })
}

export interface HardwareRow {
  name: string
  amount: number
  unit: string // 胶的单位已含在名称（kg），这里为空
  decimals: number
}

/** 五金与胶量行：数量按同一批零件件数折算，胶量按封边米数折算，统计页与下料单共用。 */
export function hardwareRows(r?: NestResult | null): HardwareRow[] {
  const h = boardsData.hardware
  const n = totalPieces(r)
  return [
    { name: h.connectorName, amount: n * h.connectorPerPart, unit: '套', decimals: 0 },
    { name: h.dowelName, amount: n * h.dowelPerPart, unit: '个', decimals: 0 },
    { name: h.screwName, amount: n * h.screwPerPart, unit: '颗', decimals: 0 },
    { name: h.glueName, amount: glueWeightKg(r), unit: '', decimals: 2 }
  ]
}
