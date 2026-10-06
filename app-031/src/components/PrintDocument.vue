<script setup lang="ts">
import { computed } from 'vue'
import { printState } from '../lib/print'
import { getJob } from '../lib/store'
import SheetDiagram from './SheetDiagram.vue'
import { money, mm, areaM2, meters } from '../lib/format'
import {
  totalPieces,
  totalPartAreaMm2,
  totalEdgeMeters,
  hardwareRows,
  usableOffcuts,
  cabinetOrderGroups,
  GLUE_GRAM_PER_EDGE_METER
} from '../lib/stats'

const job = computed(() => (printState.jobId ? getJob(printState.jobId) : undefined))
const sections = computed(() => new Set(printState.sections))
const now = computed(() => new Date().toLocaleString('zh-CN'))

const result = computed(() => job.value?.result)

// 标签：每块就位零件一张，件数与统计页/下料单完全一致
const allInstances = computed(() => result.value?.sheets.flatMap((s) => s.placements) ?? [])

// 下料单零件明细：按柜体分组、柜内按件号并数量（分组口径见 stats.ts 注释，全应用唯一）
const cabinetGroups = computed(() => cabinetOrderGroups(result.value))
const pieces = computed(() => totalPieces(result.value))
const partAreaMm2 = computed(() => totalPartAreaMm2(result.value))
const edge = computed(() => totalEdgeMeters(result.value))
const hardware = computed(() => hardwareRows(result.value))
const usable = computed(() => usableOffcuts(result.value))

const grainText = (g: string): string =>
  g === 'length' ? '竖纹' : g === 'width' ? '横纹' : '无要求'

const boardByName = (name: string) =>
  result.value?.sheets.find((x) => x.boardName === name)
</script>

<template>
  <div v-if="job" class="print-doc print-only">
    <!-- 排样图 -->
    <div v-if="sections.has('nest')">
      <section
        v-for="s in job.result?.sheets ?? []"
        :key="'pn' + s.index"
        class="print-page"
      >
        <h2>排样图 · 第 {{ s.index + 1 }} 张 / 共 {{ job.result?.sheets.length }} 张</h2>
        <p class="doc-meta">
          {{ s.boardName }}（{{ s.material }} {{ s.thicknessMm }}mm） · 尺寸
          {{ s.wMm }}×{{ s.hMm }}mm · 利用率 {{ (s.utilization * 100).toFixed(1) }}% ·
          锯路 {{ job.kerfMm }}mm · 修边 {{ job.trimMm }}mm
        </p>
        <div class="print-sheet-wrap">
          <SheetDiagram :sheet="s" :show-cuts="false" print-mode />
        </div>
        <table class="pgrid">
          <thead>
            <tr>
              <th>序号</th><th>编号</th><th>名称</th><th>柜体</th>
              <th>尺寸(mm)</th><th>纹理</th><th>封边</th><th>见光</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in s.placements" :key="p.instanceId">
              <td>{{ p.seq }}</td>
              <td>{{ p.code }}</td>
              <td>{{ p.name }}</td>
              <td>{{ p.cabinet }}</td>
              <td>{{ mm(p.origLen) }}×{{ mm(p.origWid) }}</td>
              <td>{{ grainText(p.grain) }}</td>
              <td>{{ p.edgeBands.length }} 边</td>
              <td>{{ p.exposed ? '是' : '' }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>

    <!-- 裁切步骤表 -->
    <div v-if="sections.has('cut')">
      <section
        v-for="s in job.result?.sheets ?? []"
        :key="'pc' + s.index"
        class="print-page"
      >
        <h2>裁切步骤表 · 第 {{ s.index + 1 }} 张（{{ s.boardName }}）</h2>
        <p class="doc-meta">按顺序下锯；同向刀已连续排程（减少推台翻转）；修边刀可多板叠切。</p>
        <table class="pgrid">
          <thead>
            <tr><th>刀序</th><th>类型</th><th>方向</th><th>位置(mm)</th><th>贯通区间(mm)</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr v-for="st in s.steps" :key="st.order">
              <td>{{ st.order + 1 }}</td>
              <td>{{ st.kind === 'trim' ? '修边' : '裁切' }}</td>
              <td>{{ st.axis === 'v' ? '竖刀' : '横刀' }}</td>
              <td>{{ Math.round(st.at) }}</td>
              <td>{{ st.span[0] }} ~ {{ st.span[1] }}</td>
              <td>{{ st.label }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>

    <!-- 下料单 / 领料单 -->
    <div v-if="sections.has('order')">
      <section class="print-page">
        <h2>下料单 / 领料单</h2>
        <p class="doc-meta">项目：{{ job.name }} ｜ 打印时间：{{ now }}</p>

        <h3>一、板材领料</h3>
        <table class="pgrid">
          <thead>
            <tr><th>板材</th><th>规格(mm)</th><th>厚度</th><th>张数</th><th>单价</th><th>小计</th></tr>
          </thead>
          <tbody>
            <tr v-for="(n, name) in job.result?.boardsByType" :key="name">
              <td>{{ name }}</td>
              <td>{{ boardByName(String(name))?.wMm }}×{{ boardByName(String(name))?.hMm }}</td>
              <td>{{ boardByName(String(name))?.thicknessMm }}</td>
              <td>{{ n }}</td>
              <td>{{ money(boardByName(String(name))?.priceCents ?? 0) }}</td>
              <td>{{ money((boardByName(String(name))?.priceCents ?? 0) * Number(n)) }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td colspan="5">板材合计</td>
              <td>{{ money(job.result?.totalCostCents ?? 0) }}</td>
            </tr>
          </tfoot>
        </table>

        <h3>二、零件明细（按柜体分拣，柜内按件号并数量）</h3>
        <div v-for="g in cabinetGroups" :key="g.cabinet" class="avoid-break">
          <h4>柜体/房间：{{ g.cabinet }}（{{ g.qty }} 件）</h4>
          <table class="pgrid">
            <thead>
              <tr><th>编号</th><th>名称</th><th>尺寸(mm)</th><th>数量</th><th>纹理</th><th>封边</th><th>见光</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in g.rows" :key="g.cabinet + '|' + row.code">
                <td>{{ row.code }}</td>
                <td>{{ row.name }}</td>
                <td>{{ mm(row.origLen) }}×{{ mm(row.origWid) }}</td>
                <td>{{ row.qty }}</td>
                <td>{{ grainText(row.grain) }}</td>
                <td>{{ row.edgeBands.length }} 边</td>
                <td>{{ row.exposed ? '是' : '' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="doc-meta">
          合计 {{ pieces }} 件零件，净面积 {{ areaM2(partAreaMm2) }}
          （各柜件数之和 = 标签张数 = 排样就位件数）。
        </p>

        <h3>三、封边与五金辅料</h3>
        <table class="pgrid">
          <tbody>
            <tr><td>见光边封边</td><td>{{ meters(edge.exposed) }} m</td></tr>
            <tr><td>非见光边封边</td><td>{{ meters(edge.normal) }} m</td></tr>
            <tr><td>封边合计</td><td>{{ meters(edge.total) }} m</td></tr>
            <tr v-for="(h, i) in hardware" :key="i">
              <td>{{ h.name }}</td>
              <td>{{ h.amount.toFixed(h.decimals) }}{{ h.unit ? ' ' + h.unit : '' }}</td>
            </tr>
          </tbody>
        </table>
        <p class="doc-meta">
          封边热熔胶 ＝ 封边合计 {{ meters(edge.total) }}m × {{ GLUE_GRAM_PER_EDGE_METER }} 克/米 ÷ 1000
          （折算系数统计页、下料单、标签共用同一份）。
        </p>

        <h3>四、可再利用余料（≥300×300mm，每张板均计入）</h3>
        <table class="pgrid">
          <thead>
            <tr><th>所在板</th><th>尺寸(mm)</th><th>面积</th></tr>
          </thead>
          <tbody>
            <tr v-for="(o, i) in usable.list" :key="i">
              <td>第 {{ o.sheet }} 张</td>
              <td>{{ mm(o.wMm) }}×{{ mm(o.hMm) }}</td>
              <td>{{ areaM2(o.areaMm2) }}</td>
            </tr>
            <tr v-if="usable.list.length === 0">
              <td colspan="3">本批板没有 ≥300×300mm 的可用余料。</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td colspan="2">合计 {{ usable.count }} 块</td>
              <td>{{ areaM2(usable.areaMm2) }}</td>
            </tr>
          </tfoot>
        </table>
      </section>
    </div>

    <!-- 标签（A4 不干胶，每块一张） -->
    <div v-if="sections.has('labels')">
      <section class="print-page labels-page">
        <div
          v-for="(p, i) in allInstances"
          :key="'lb' + i"
          class="label-card avoid-break"
        >
          <div class="lb-code">{{ p.code }} <span class="lb-seq">#{{ p.seq }}</span></div>
          <div class="lb-name">{{ p.name }}</div>
          <div class="lb-dims">{{ mm(p.origLen) }} × {{ mm(p.origWid) }} mm</div>
          <div class="lb-meta">{{ p.cabinet }} ｜ {{ grainText(p.grain) }} ｜ 封边 {{ p.edgeBands.length }} 边{{ p.exposed ? ' ｜ 见光' : '' }}</div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.print-doc {
  color: #000;
  font-size: 12px;
}
.print-doc h2 {
  font-size: 17px;
  margin-bottom: 6px;
}
.print-doc h3 {
  font-size: 14px;
  margin: 14px 0 6px;
}
.print-doc h4 {
  font-size: 13px;
  margin: 10px 0 4px;
}
.doc-meta {
  color: #333;
  margin: 0 0 8px;
  font-size: 11px;
}
.print-sheet-wrap {
  border: 1px solid #888;
  padding: 6px;
  margin-bottom: 10px;
}
table.pgrid {
  width: 100%;
  border-collapse: collapse;
  font-size: 10.5px;
}
table.pgrid th,
table.pgrid td {
  border: 1px solid #555;
  padding: 2.5px 5px;
  text-align: left;
}
table.pgrid th {
  background: #eee;
}
.labels-page {
  display: grid;
  grid-template-columns: repeat(2, 94mm);
  gap: 4mm 6mm;
  justify-content: center;
}
.label-card {
  border: 1.5px solid #000;
  border-radius: 3px;
  padding: 3mm 3.5mm;
  height: 38mm;
  overflow: hidden;
}
.lb-code {
  font-size: 15px;
  font-weight: 700;
}
.lb-seq {
  font-weight: 400;
  font-size: 11px;
}
.lb-name {
  font-size: 12px;
  margin: 1mm 0;
}
.lb-dims {
  font-size: 18px;
  font-weight: 700;
  margin: 1mm 0;
}
.lb-meta {
  font-size: 10.5px;
}
</style>
