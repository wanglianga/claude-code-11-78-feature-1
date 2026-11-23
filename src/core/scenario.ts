// ============================================================
// 确定性场景生成器：三阶段样例
// 阶段一 08:00-12:00 网络漂移与施工扰动重叠（规则 RV-2026.1）
// 阶段二 12:00-16:00 规则换版 RV-2026.2，触发局部重算
// 阶段三 16:00-18:00 离线补传与同步冲突
// 所有数据固定生成，不使用随机数，保证两路线核验可复现。
// ============================================================

import type {
  ConstructionZone,
  DeviceLedger,
  PatrolSector,
  RawRecord,
  Rectification,
  RuleVersion,
  ScenarioManifest,
  SemanticMapping,
} from './types';

const DAY = '2026-11-23';
export const t = (h: number, m = 0) =>
  `${DAY}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`;
export const plusMin = (iso: string, min: number) => {
  const ms = new Date(iso).getTime() + min * 60_000;
  // 保留固定时区偏移 +08:00
  const d = new Date(ms + 8 * 3600_000);
  return d.toISOString().replace('Z', '+08:00');
};

let seq = 0;
const rid = (prefix: string) => `${prefix}-${String(++seq).padStart(4, '0')}`;

interface ReadingSpec {
  h: number;
  m: number;
  value: number;
  unit: string;
  status: 'open' | 'closed' | 'fault';
  delayMin?: number; // 到达延迟
  outOfOrder?: boolean; // 乱序到达
  missing?: boolean; // 缺测占位（不产生记录）
  backfilled?: boolean; // 离线补传
}

function readingRecord(
  alias: string,
  spec: ReadingSpec,
  coord: { lng: number; lat: number },
  batchId: string,
): RawRecord {
  const sampled = t(spec.h, spec.m);
  const arrived = plusMin(sampled, spec.delayMin ?? 1);
  return {
    id: rid('RAW'),
    sourceId: `SRC/${alias}/${spec.h}${String(spec.m).padStart(2, '0')}`,
    kind: 'valve_reading',
    payload: {
      deviceAlias: alias,
      value: spec.value,
      unit: spec.unit,
      status: spec.status,
      lng: coord.lng,
      lat: coord.lat,
      coordSystem: 'GCJ02',
    },
    sampledAt: sampled,
    arrivedAt: spec.outOfOrder ? plusMin(arrived, -6) : arrived,
    confidence: spec.delayMin && spec.delayMin >= 20 ? 'low' : spec.backfilled ? 'medium' : 'high',
    signature: '', // 装载器计算后回填
    batchId,
    backfilled: !!spec.backfilled,
  };
}

// ---------------- 设备台账（ledger-v3） ----------------
export function buildLedger(): DeviceLedger[] {
  return [
    {
      deviceId: 'VW-001',
      name: '1号阀井压力点',
      aliases: ['JING-01', 'VALVE-WELL-01', '井一号'],
      deviceType: 'valve_well',
      standardUnit: 'kPa',
      rangeMin: 0,
      rangeMax: 100,
      warnThreshold: 60,
      highThreshold: 80,
      expectedIntervalMin: 15,
      location: { lng: 116.4002, lat: 39.9002 },
      declaredStatus: 'closed',
      ledgerVersion: 'ledger-v3',
    },
    {
      deviceId: 'PS-002',
      name: '2号管网压力传感器',
      aliases: ['P-SENSOR-2', 'PS2'],
      deviceType: 'pressure_sensor',
      standardUnit: 'kPa',
      rangeMin: 0,
      rangeMax: 1600,
      warnThreshold: 1000,
      highThreshold: 1400,
      expectedIntervalMin: 10,
      location: { lng: 116.412, lat: 39.905 },
      declaredStatus: 'open',
      ledgerVersion: 'ledger-v3',
    },
    {
      deviceId: 'FS-003',
      name: '3号流量传感器',
      aliases: ['F-SENSOR-3', 'FS3'],
      deviceType: 'flow_sensor',
      standardUnit: 'm3/h',
      rangeMin: 0,
      rangeMax: 500,
      warnThreshold: 350,
      highThreshold: 450,
      expectedIntervalMin: 20,
      location: { lng: 116.39, lat: 39.91 },
      declaredStatus: 'open',
      ledgerVersion: 'ledger-v3',
    },
    {
      deviceId: 'VW-004',
      name: '4号阀井压力点（对照点）',
      aliases: ['JING-04'],
      deviceType: 'valve_well',
      standardUnit: 'kPa',
      rangeMin: 0,
      rangeMax: 100,
      warnThreshold: 60,
      highThreshold: 80,
      expectedIntervalMin: 15,
      location: { lng: 116.45, lat: 39.92 },
      declaredStatus: 'closed',
      ledgerVersion: 'ledger-v3',
    },
  ];
}

export function buildMapping(): SemanticMapping {
  return {
    version: 'map-v2',
    aliasMap: {
      'JING-01': 'VW-001',
      'VALVE-WELL-01': 'VW-001',
      井一号: 'VW-001',
      'P-SENSOR-2': 'PS-002',
      PS2: 'PS-002',
      'F-SENSOR-3': 'FS-003',
      FS3: 'FS-003',
      'JING-04': 'VW-004',
    },
    unitConversions: {
      bar: { factor: 100, offset: 0 }, // bar -> kPa
      'L/s': { factor: 3.6, offset: 0 }, // L/s -> m3/h
      kPa: { factor: 1, offset: 0 },
      'm3/h': { factor: 1, offset: 0 },
    },
    coordSystem: 'GCJ02',
    coordOffset: { dLng: -0.0012, dLat: -0.0008 }, // GCJ02 -> WGS84 修正
    updatedAt: t(7, 30),
  };
}

export function buildZones(): ConstructionZone[] {
  return [
    {
      id: 'CZ-01',
      name: '朝阳路市政施工段',
      bbox: { lngMin: 116.398, lngMax: 116.403, latMin: 39.898, latMax: 39.903 },
      affectedDevices: ['VW-001'],
      startAt: t(9, 0),
      endAt: t(11, 0),
      graceIntervalMin: 40,
      suppressKinds: ['jump'],
    },
  ];
}

// ---------------- 巡检片区（定位围栏与人员应在范围） ----------------
export function buildSectors(): PatrolSector[] {
  return [
    {
      id: 'PS-A',
      name: '朝阳路一线巡检片区',
      bbox: { lngMin: 116.397, lngMax: 116.404, latMin: 39.897, latMax: 39.904 },
      anchorLocation: { lng: 116.4002, lat: 39.9002 },
      deviceIds: ['VW-001'],
    },
    {
      id: 'PS-B',
      name: '河东加压片区',
      bbox: { lngMin: 116.409, lngMax: 116.415, latMin: 39.902, latMax: 39.908 },
      anchorLocation: { lng: 116.412, lat: 39.905 },
      deviceIds: ['PS-002'],
    },
    {
      id: 'PS-C',
      name: '北环流量片区',
      bbox: { lngMin: 116.387, lngMax: 116.393, latMin: 39.907, latMax: 39.913 },
      anchorLocation: { lng: 116.39, lat: 39.91 },
      deviceIds: ['FS-003'],
    },
    {
      id: 'PS-D',
      name: '东郊对照片区',
      bbox: { lngMin: 116.447, lngMax: 116.453, latMin: 39.917, latMax: 39.923 },
      anchorLocation: { lng: 116.45, lat: 39.92 },
      deviceIds: ['VW-004'],
    },
  ];
}

export function buildRectifications(): Rectification[] {
  return [
    {
      id: 'RC-001',
      alertSourceId: null, // 上游告警 ID 缺失，只能靠设备/时间证据关联
      deviceId: 'VW-001',
      dueAt: t(10, 0),
      closedAt: null,
      status: 'pending',
      note: '阀井状态矛盾整改，截止 10:00，现场未反馈',
      arrivedAt: t(8, 10),
    },
    {
      id: 'RC-002',
      alertSourceId: 'SRC/PS-002/JUMP-0930',
      deviceId: 'PS-002',
      dueAt: t(14, 0),
      closedAt: t(13, 50),
      status: 'done',
      note: '压力跳变已复核为用水高峰，准时关闭',
      arrivedAt: t(9, 45),
    },
    {
      id: 'RC-003',
      alertSourceId: 'SRC/FS-003/MISS-1600',
      deviceId: 'FS-003',
      dueAt: t(15, 0),
      closedAt: t(15, 40),
      status: 'done',
      note: '流量缺测整改回执延迟 40 分钟提交：v1 宽限 60 分钟不判逾期，换版 v2（30 分钟）后判逾期',
      arrivedAt: t(16, 25),
    },
  ];
}

// ---------------- 规则版本 ----------------
export function buildRuleVersions(): RuleVersion[] {
  return [
    {
      id: 'RV-2026.1',
      publishedAt: t(7, 0),
      active: true,
      changelog: '基线版本：缺测间隔 30 分钟、跳变量程比 0.40、逾期宽限 60 分钟',
      rules: [
        {
          id: 'R-MISSING',
          kind: 'missing',
          name: '采样缺测',
          enabled: true,
          params: { missingGapMin: 30 },
          baseSeverity: 'major',
          constructionGrace: true,
        },
        {
          id: 'R-JUMP',
          kind: 'jump',
          name: '读数跳变',
          enabled: true,
          params: { jumpRangeRatio: 0.4 },
          baseSeverity: 'major',
          constructionGrace: true,
        },
        {
          id: 'R-CONTRA',
          kind: 'contradiction',
          name: '状态矛盾',
          enabled: true,
          params: { contradictionTol: 10 },
          baseSeverity: 'major',
          constructionGrace: false,
        },
        {
          id: 'R-OVERDUE',
          kind: 'overdue',
          name: '处置逾期',
          enabled: true,
          params: { overdueMin: 60 },
          baseSeverity: 'minor',
          constructionGrace: false,
        },
        {
          id: 'R-GEO',
          kind: 'geo_breach',
          name: '定位越界（可信度门限）',
          enabled: true,
          params: { geoJumpM: 500, geoSpeedLimitKmh: 60, geoTrustFloor: 45 },
          baseSeverity: 'major',
          constructionGrace: false,
        },
      ],
    },
    {
      id: 'RV-2026.2',
      publishedAt: t(12, 0),
      active: false,
      changelog:
        '收紧阈值：缺测 30→20 分钟、跳变比 0.40→0.25 且升为 critical、矛盾容忍 10→5 并升为 critical、逾期宽限 60→30 分钟；定位越界升 critical 并启用多源证据降权门限',
      rules: [
        {
          id: 'R-MISSING',
          kind: 'missing',
          name: '采样缺测',
          enabled: true,
          params: { missingGapMin: 20 },
          baseSeverity: 'major',
          constructionGrace: true,
        },
        {
          id: 'R-JUMP',
          kind: 'jump',
          name: '读数跳变',
          enabled: true,
          params: { jumpRangeRatio: 0.25 },
          baseSeverity: 'critical',
          constructionGrace: true,
        },
        {
          id: 'R-CONTRA',
          kind: 'contradiction',
          name: '状态矛盾',
          enabled: true,
          params: { contradictionTol: 5 },
          baseSeverity: 'critical',
          constructionGrace: false,
        },
        {
          id: 'R-OVERDUE',
          kind: 'overdue',
          name: '处置逾期',
          enabled: true,
          params: { overdueMin: 30 },
          baseSeverity: 'major',
          constructionGrace: false,
        },
        {
          id: 'R-GEO',
          kind: 'geo_breach',
          name: '定位越界（可信度门限）',
          enabled: true,
          params: { geoJumpM: 500, geoSpeedLimitKmh: 60, geoTrustFloor: 45 },
          baseSeverity: 'critical',
          constructionGrace: false,
        },
      ],
    },
  ];
}

// ---------------- 读数时间线 ----------------
function vw001Series(): ReadingSpec[] {
  const rows: ReadingSpec[] = [];
  // 08:00-09:15 每 15 分钟；08:30 起状态与台账“closed”矛盾
  rows.push({ h: 8, m: 0, value: 42, unit: 'kPa', status: 'closed' });
  rows.push({ h: 8, m: 15, value: 43, unit: 'kPa', status: 'closed' });
  rows.push({ h: 8, m: 30, value: 44, unit: 'kPa', status: 'open' });
  rows.push({ h: 8, m: 45, value: 45, unit: 'kPa', status: 'open' });
  rows.push({ h: 9, m: 0, value: 46, unit: 'kPa', status: 'open' });
  rows.push({ h: 9, m: 15, value: 47, unit: 'kPa', status: 'open', delayMin: 25 }); // 网络漂移迟到
  // 09:30、09:45 缺测
  rows.push({ h: 10, m: 0, value: 74, unit: 'kPa', status: 'open' }); // 60 分钟缺口；升幅 27（v2 判跳变）
  rows.push({ h: 10, m: 30, value: 74, unit: 'kPa', status: 'open', outOfOrder: true }); // 乱序
  rows.push({ h: 10, m: 15, value: 73, unit: 'kPa', status: 'open', delayMin: 18 });
  rows.push({ h: 10, m: 45, value: 75, unit: 'kPa', status: 'open' });
  rows.push({ h: 11, m: 0, value: 50, unit: 'kPa', status: 'open' }); // 施工窗口内回落，跳变应被抑制
  rows.push({ h: 11, m: 15, value: 49, unit: 'kPa', status: 'open' });
  rows.push({ h: 11, m: 30, value: 48, unit: 'kPa', status: 'closed' });
  rows.push({ h: 11, m: 45, value: 47, unit: 'kPa', status: 'closed' });
  // 12:00-17:45 每 15 分钟一个采样，13:30 缺测（13:15→13:45 间隔 30 分钟：v1 不告警，v2 告警）
  for (let m = 12 * 60; m <= 17 * 60 + 45; m += 15) {
    if (m === 13 * 60 + 30) continue;
    const hh = Math.floor(m / 60);
    const mm = m % 60;
    rows.push({ h: hh, m: mm, value: 45 + (m % 5), unit: 'kPa', status: 'closed' });
  }
  return rows;
}

function ps002Series(): ReadingSpec[] {
  const rows: ReadingSpec[] = [];
  for (let m = 0; m <= 18 * 60; m += 10) {
    if (m < 8 * 60) continue;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    let value = 8.0;
    let status: 'open' | 'closed' | 'fault' = 'open';
    let delay = 1;
    if (h === 9 && (mm === 30 || mm === 40)) value = mm === 30 ? 14.5 : 14.6; // 跳变高点
    if (h === 9 && mm === 50) value = 8.0; // 高位回落，二次跳变（两版均判）
    if (h === 13 && (mm === 0 || mm === 10)) value = 13.0; // v1 不判跳变（0.31<0.40）、v2 判跳变（>0.25）
    if (h === 13 && mm === 20) value = 8.1;
    if (h === 17 && mm === 10) delay = 35; // 网络漂移
    rows.push({ h, m: mm, value, unit: 'bar', status, delayMin: delay });
  }
  return rows;
}

function fs003Series(): ReadingSpec[] {
  const rows: ReadingSpec[] = [];
  for (let m = 8 * 60; m <= 18 * 60; m += 20) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    if (h === 16 && mm === 0) continue; // 16:00 永久缺测 -> 40 分钟缺口
    const backfilled = h === 16 && (mm === 20 || mm === 40);
    rows.push({
      h,
      m: mm,
      value: backfilled ? 21 : 20 + ((h + mm) % 3),
      unit: 'L/s',
      status: 'open',
      delayMin: backfilled ? 70 : 1,
      backfilled,
    });
  }
  return rows;
}

function vw004Series(): ReadingSpec[] {
  const rows: ReadingSpec[] = [];
  for (let m = 8 * 60; m <= 18 * 60; m += 15) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    rows.push({ h, m: mm, value: 40 + (m % 4), unit: 'kPa', status: 'closed' });
  }
  return rows;
}

export function buildManifest(): ScenarioManifest {
  return {
    id: 'SCENARIO-2026-11-23',
    name: '网络漂移 × 施工扰动 × 规则换版 × 离线补传 × 定位漂移复核',
    description:
      '同日三阶段：上午施工与网络漂移重叠，中午规则换版收紧阈值，下午巡检端离线后补传并产生同步冲突；14:00-16:05 叠加 GPS 数公里漂移，由照片/扫码/报修多源证据完成可信度评估、漂移切分、区间校正与复核队列。',
    ledgerVersion: 'ledger-v3',
    mappingVersion: 'map-v2',
    initialRuleVersionId: 'RV-2026.1',
    targetRuleVersionId: 'RV-2026.2',
    phases: [
      {
        id: 'PH-1',
        name: '阶段一：网络漂移与施工扰动重叠',
        startAt: t(8, 0),
        endAt: t(12, 0),
        activeRuleVersionId: 'RV-2026.1',
        note: 'CZ-01 施工 09:00-11:00；VW-001 读数迟到/乱序/缺测；PS-002 在施工区外跳变不抑制',
      },
      {
        id: 'PH-2',
        name: '阶段二：规则换版与局部重算',
        startAt: t(12, 0),
        endAt: t(16, 0),
        activeRuleVersionId: 'RV-2026.2',
        note: '阈值收紧后对历史窗口局部重算，事件通过 parentEventId 串联重算链',
      },
      {
        id: 'PH-3',
        name: '阶段三：离线补传与同步冲突',
        startAt: t(16, 0),
        endAt: t(18, 0),
        activeRuleVersionId: 'RV-2026.2',
        note: '巡检端离线处置、17:30 批量补传，对照器展示本地/远端冲突',
      },
      {
        id: 'PH-4',
        name: '阶段四：定位漂移可信度与复核（14:00-16:05 与阶段三交叠）',
        startAt: t(14, 0),
        endAt: t(16, 5),
        activeRuleVersionId: 'RV-2026.2',
        note: 'GPS 跳到数公里外且连续超速；段一由片区内照片/扫码佐证可区间校正，段二跨片区扫码+报修联动不可校正，越界告警按可信度降权并进复核队列',
      },
    ],
  };
}

export interface ScenarioBundle {
  raw: RawRecord[];
  ledger: DeviceLedger[];
  zones: ConstructionZone[];
  sectors: PatrolSector[];
  rectifications: Rectification[];
  ruleVersions: RuleVersion[];
  mapping: SemanticMapping;
  manifest: ScenarioManifest;
}

// ---------------- 定位漂移多源证据样例（14:00-16:05） ----------------
// 段一 14:15-15:00：GPS 跳到数公里外且连续超速，同片区照片/扫码佐证人员未离开 -> 可校正
// 段二 15:35-16:05：漂移中出现另一片区扫码+报修单相互印证 -> 不可校正范围
interface GeoPoint {
  h: number;
  m: number;
  lng: number;
  lat: number;
  accuracyM?: number;
  deviceId?: string | null;
}

function geoRecord(
  kind: RawRecord['kind'],
  sourceId: string,
  h: number,
  m: number,
  payload: Record<string, unknown>,
  confidence: RawRecord['confidence'],
): RawRecord {
  return {
    id: rid('RAW'),
    sourceId,
    kind,
    payload,
    sampledAt: t(h, m),
    arrivedAt: plusMin(t(h, m), 1),
    confidence,
    signature: '',
    batchId: 'BATCH-GEO',
    backfilled: false,
  };
}

/** 定位可信度样例：漂移轨迹、片区内照片、跨片区扫码、设备报修联动 */
export function buildGeoRaw(sectors: PatrolSector[]): RawRecord[] {
  const anchorA = sectors.find((s) => s.id === 'PS-A')!.anchorLocation;
  const anchorC = sectors.find((s) => s.id === 'PS-C')!.anchorLocation;
  const out: RawRecord[] = [];
  const inspector = '张巡检';

  // 漂移轨迹：14:00-16:05，两个漂移段；far 点均在数公里外、全部片区围栏之外
  const traj: GeoPoint[] = [
    { h: 14, m: 0, lng: anchorA.lng, lat: anchorA.lat, accuracyM: 10, deviceId: 'VW-001' },
    { h: 14, m: 10, lng: +(anchorA.lng + 0.0004).toFixed(6), lat: +(anchorA.lat - 0.0003).toFixed(6), accuracyM: 12, deviceId: 'VW-001' },
    { h: 14, m: 15, lng: anchorA.lng, lat: anchorA.lat, accuracyM: 10, deviceId: 'VW-001' }, // 段一入口锚点
    { h: 14, m: 20, lng: 116.485, lat: 39.945, accuracyM: 800, deviceId: 'VW-001' }, // 跳到 ~8.8km 外，5 分钟 => ~106 km/h
    { h: 14, m: 30, lng: 116.33, lat: 39.86, accuracyM: 900, deviceId: 'VW-001' }, // 10 分钟移动 ~16km => ~97 km/h
    { h: 14, m: 40, lng: 116.49, lat: 39.95, accuracyM: 700, deviceId: 'VW-001' },
    { h: 14, m: 50, lng: anchorA.lng, lat: anchorA.lat, accuracyM: 12, deviceId: 'VW-001' }, // 跳回（大跳变，仍判漂移）
    { h: 15, m: 0, lng: anchorA.lng, lat: anchorA.lat, accuracyM: 10, deviceId: 'VW-001' }, // 段一出口锚点（可信）
    { h: 15, m: 10, lng: anchorA.lng, lat: anchorA.lat, accuracyM: 11, deviceId: 'VW-001' },
    { h: 15, m: 30, lng: anchorA.lng, lat: anchorA.lat, accuracyM: 10, deviceId: 'VW-001' }, // 段二入口锚点
    { h: 15, m: 35, lng: 116.48, lat: 39.94, accuracyM: 850, deviceId: 'VW-001' },
    { h: 15, m: 45, lng: 116.34, lat: 39.87, accuracyM: 800, deviceId: 'VW-001' }, // 15:40 跨片区扫码、15:42 报修
    { h: 15, m: 55, lng: anchorA.lng, lat: anchorA.lat, accuracyM: 12, deviceId: 'VW-001' },
    { h: 16, m: 5, lng: anchorA.lng, lat: anchorA.lat, accuracyM: 10, deviceId: 'VW-001' }, // 段二出口锚点（可信）
  ];
  for (const p of traj) {
    out.push(
      geoRecord('trajectory', `TRAJ/GEO/${p.h}${String(p.m).padStart(2, '0')}`, p.h, p.m, {
        deviceId: p.deviceId ?? null,
        lng: p.lng,
        lat: p.lat,
        coordSystem: 'WGS84',
        inspector,
        accuracyM: p.accuracyM,
      }, p.accuracyM && p.accuracyM >= 200 ? 'low' : 'high'),
    );
  }

  // 现场照片：漂移段一时间窗内，照片定位始终在 PS-A 片区（独立疑点 + 校正佐证 C2）
  const photos: Array<[number, number, string]> = [
    [14, 25, 'IMG-9001'],
    [14, 45, 'IMG-9002'],
  ];
  for (const [h, m, photoId] of photos) {
    out.push(
      geoRecord('photo', `PHOTO/${photoId}`, h, m, {
        photoId,
        deviceId: 'VW-001',
        lng: anchorA.lng,
        lat: anchorA.lat,
        inspector,
      }, 'high'),
    );
  }

  // 扫码：段一同片区扫码（校正佐证 C2）+ 段二内跨片区扫码（与报修联动，禁止校正）
  out.push(
    geoRecord('scan', 'SCAN/SC-A-07', 14, 35, {
      scanPointId: 'SC-A-07',
      deviceId: 'VW-001',
      sectorId: 'PS-A',
      lng: anchorA.lng,
      lat: anchorA.lat,
      inspector,
    }, 'high'),
    geoRecord('scan', 'SCAN/SC-C-11', 15, 40, {
      scanPointId: 'SC-C-11',
      deviceId: 'FS-003',
      sectorId: 'PS-C',
      lng: anchorC.lng,
      lat: anchorC.lat,
      inspector,
    }, 'high'),
  );

  // 设备报修单：与段二跨片区扫码同时段、同设备/同片区相互印证（报修联动，不可自动校正）
  out.push(
    geoRecord('repair', 'REPAIR/RP-2026-11-23-09', 15, 42, {
      repairId: 'RP-2026-11-23-09',
      deviceId: 'FS-003',
      sectorId: 'PS-C',
      lng: anchorC.lng,
      lat: anchorC.lat,
      inspector,
      fault: '流量传感器零漂，现场报修',
    }, 'high'),
  );

  return out;
}

export function buildScenario(): ScenarioBundle {
  seq = 0;
  const ledger = buildLedger();
  const mapping = buildMapping();
  const coordOf = (deviceId: string) =>
    ledger.find((d) => d.deviceId === deviceId)!.location;
  const gcj = (deviceId: string) => ({
    lng: coordOf(deviceId).lng - mapping.coordOffset.dLng,
    lat: coordOf(deviceId).lat - mapping.coordOffset.dLat,
  });

  const raw: RawRecord[] = [];
  const push = (alias: string, spec: ReadingSpec[], batch: string) => {
    for (const s of spec) raw.push(readingRecord(alias, s, gcj(mapping.aliasMap[alias]), batch));
  };
  push('JING-01', vw001Series(), 'BATCH-MORNING');
  push('P-SENSOR-2', ps002Series(), 'BATCH-MORNING');
  push('F-SENSOR-3', fs003Series(), 'BATCH-DAY');
  push('JING-04', vw004Series(), 'BATCH-DAY');
  // 巡检轨迹：施工区附近签到与离线巡检点
  const traj: Array<[number, number, string, number]> = [
    [8, 5, 'VW-001', 1],
    [9, 35, 'VW-001', 30],
    [13, 10, 'PS-002', 1],
    [16, 30, 'FS-003', 65],
  ];
  for (const [h, m, deviceId, delay] of traj) {
    const c = coordOf(deviceId);
    raw.push({
      id: rid('RAW'),
      sourceId: `TRAJ/${deviceId}/${h}${m}`,
      kind: 'trajectory',
      payload: { deviceId, lng: c.lng, lat: c.lat, coordSystem: 'WGS84', inspector: '张巡检' },
      sampledAt: t(h, m),
      arrivedAt: plusMin(t(h, m), delay),
      confidence: delay >= 20 ? 'low' : 'high',
      signature: '',
      batchId: delay >= 60 ? 'BATCH-BACKFILL' : 'BATCH-DAY',
      backfilled: delay >= 60,
    });
  }

  // 定位可信度样例：漂移轨迹 + 照片 + 扫码 + 报修（确定性坐标，覆盖校正/不可校正两段）
  const sectors = buildSectors();
  raw.push(...buildGeoRaw(sectors));

  return {
    raw,
    ledger,
    zones: buildZones(),
    sectors,
    rectifications: buildRectifications(),
    ruleVersions: buildRuleVersions(),
    mapping,
    manifest: buildManifest(),
  };
}
