// ============================================================
// 定位可信度子系统（纯函数，Worker / 主线程 / Vitest 共用）：
//   多源定位证据抽取 -> 逐点可信度评估 -> 证据交叉匹配
//   -> 漂移段切分 -> 区间位置校正（保留校正依据与不可校正范围）
//   -> 独立疑点 / 行程异常 / 报修联动 -> 定位单独触发告警的降权与复核队列。
// 原始 GPS 坐标始终保留在 LocationEvidence.location，任何环节都不回写原始记录。
// ============================================================

import { contentId } from './crypto';
import type {
  Alert,
  AlertGeoAdjustment,
  DriftSegment,
  LocationAnomaly,
  LocationEvidence,
  LocationTrust,
  PatrolSector,
  RawRecord,
  ReviewItem,
  RuleDef,
  Severity,
  TrustFactor,
  TrustLevel,
} from './types';

const EARTH_R_M = 6371000;
const MATCH_WINDOW_MIN = 15; // 交叉匹配时间窗：业务时间 ±15 分钟
const CLAMP = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** haversine 大圆距离（米） */
export function haversineM(
  a: { lng: number; lat: number },
  b: { lng: number; lat: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.sqrt(s));
}

/** 两点间连续行程速度（km/h），时间倒序或同刻返回 null */
export function speedKmh(
  a: { at: string; location: { lng: number; lat: number } },
  b: { at: string; location: { lng: number; lat: number } },
): number | null {
  const hours = (new Date(b.at).getTime() - new Date(a.at).getTime()) / 3600_000;
  if (hours <= 0) return null;
  return haversineM(a.location, b.location) / 1000 / hours;
}

export function sectorAt(sectors: PatrolSector[], p: { lng: number; lat: number }): PatrolSector | null {
  return (
    sectors.find(
      (s) =>
        p.lng >= s.bbox.lngMin &&
        p.lng <= s.bbox.lngMax &&
        p.lat >= s.bbox.latMin &&
        p.lat <= s.bbox.latMax,
    ) ?? null
  );
}

const KIND_REF: Record<string, string> = {
  photo: '照片',
  scan: '扫码',
  repair: '报修',
  gps: 'GPS',
};

// ---------------- 多源定位证据抽取 ----------------
export function extractLocationEvidence(
  raw: RawRecord[],
  sectors: PatrolSector[],
): LocationEvidence[] {
  const out: LocationEvidence[] = [];
  for (const r of raw) {
    if (r.kind === 'trajectory' || r.kind === 'photo' || r.kind === 'scan' || r.kind === 'repair') {
      const lng = Number(r.payload.lng);
      const lat = Number(r.payload.lat);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      const sector = sectorAt(sectors, { lng, lat });
      const boundSector =
        r.payload.sectorId != null ? String(r.payload.sectorId) : sector?.id ?? null;
      out.push({
        id: `LOC:${r.id}`,
        rawId: r.id,
        signature: r.signature,
        kind: r.kind === 'trajectory' ? 'gps' : (r.kind as 'photo' | 'scan' | 'repair'),
        inspector: String(r.payload.inspector ?? '未标注'),
        at: r.sampledAt,
        location: { lng, lat },
        sectorId: sector?.id ?? null,
        sourceSectorId: r.kind === 'scan' || r.kind === 'repair' ? boundSector : null,
        deviceId: r.payload.deviceId != null ? String(r.payload.deviceId) : null,
        ref: String(
          r.payload.photoId ?? r.payload.scanPointId ?? r.payload.repairId ?? r.sourceId,
        ),
        accuracyM:
          r.payload.accuracyM != null ? Number(r.payload.accuracyM) : undefined,
      });
    }
  }
  return out.sort(
    (a, b) =>
      new Date(a.at).getTime() - new Date(b.at).getTime() || a.id.localeCompare(b.id),
  );
}

// ---------------- 逐点可信度评估 ----------------
interface TrustParams {
  jumpM: number;
  speedLimitKmh: number;
}

function withinWindow(a: string, b: string, min: number): boolean {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) <= min * 60_000;
}

function nearby(
  ev: LocationEvidence,
  all: LocationEvidence[],
  kind: LocationEvidence['kind'],
): LocationEvidence[] {
  return all.filter(
    (e) => e.kind === kind && e.id !== ev.id && withinWindow(e.at, ev.at, MATCH_WINDOW_MIN),
  );
}

function scoreNonGps(ev: LocationEvidence): LocationTrust {
  const factors: TrustFactor[] = [];
  let score = 80; // 业务证据（照片/扫码/报修）基线可信度高于 GPS
  if (ev.sectorId) {
    factors.push({ code: 'fence', delta: 10, note: `定位落在指定片区 ${ev.sectorId} 围栏内` });
    score += 10;
  } else {
    factors.push({ code: 'fence', delta: -10, note: '定位落在全部片区围栏之外' });
    score -= 10;
  }
  if (ev.kind === 'scan' && ev.sourceSectorId && ev.sourceSectorId !== ev.sectorId) {
    factors.push({
      code: 'scan_confirm',
      delta: -15,
      note: `扫码绑定片区 ${ev.sourceSectorId} 与坐标片区 ${ev.sectorId ?? '围栏外'} 不一致`,
    });
    score -= 15;
  }
  score = CLAMP(score, 0, 100);
  return {
    evidenceId: ev.id,
    score,
    level: score >= 65 ? 'trusted' : score >= 40 ? 'suspect' : 'drift',
    factors,
    matchedEvidenceIds: [],
    contradictEvidenceIds: [],
    speedKmh: null,
    jumpM: null,
  };
}

export function evaluateTrust(
  evidence: LocationEvidence[],
  params: TrustParams,
): LocationTrust[] {
  const gps = evidence.filter((e) => e.kind === 'gps');
  const result = new Map<string, LocationTrust>();
  for (const ev of evidence) if (ev.kind !== 'gps') result.set(ev.id, scoreNonGps(ev));

  for (let i = 0; i < gps.length; i++) {
    const ev = gps[i];
    const prev = gps[i - 1];
    const factors: TrustFactor[] = [];
    const matched: string[] = [];
    const contradict: string[] = [];
    let score = 70;

    // 精度因子
    const acc = ev.accuracyM;
    if (acc != null) {
      if (acc <= 15) {
        factors.push({ code: 'accuracy', delta: 15, note: `标称精度 ${acc}m，高精度` });
        score += 15;
      } else if (acc <= 50) {
        factors.push({ code: 'accuracy', delta: 5, note: `标称精度 ${acc}m` });
        score += 5;
      } else if (acc >= 500) {
        factors.push({ code: 'accuracy', delta: -30, note: `标称精度 ${acc}m，粗差定位` });
        score -= 30;
      } else if (acc >= 200) {
        factors.push({ code: 'accuracy', delta: -20, note: `标称精度 ${acc}m，精度劣化` });
        score -= 20;
      }
    }

    // 连续速度 / 瞬时跳变：以“连续速度越过可达上限”为硬判据，
    // 速度可达时，采样间隔造成的远距离跳变视为稀疏采样可解释，只轻微扣分。
    let speed: number | null = null;
    let jump: number | null = null;
    let hardViolation = false;
    if (prev) {
      speed = speedKmh(
        { at: prev.at, location: prev.location },
        { at: ev.at, location: ev.location },
      );
      jump = haversineM(prev.location, ev.location);
      const overSpeed = speed != null && speed > params.speedLimitKmh;
      if (overSpeed) {
        hardViolation = true;
        factors.push({
          code: 'speed',
          delta: -25,
          note: `连续速度 ${speed!.toFixed(1)} km/h 越过可达上限 ${params.speedLimitKmh} km/h`,
        });
        score -= 25;
      } else if (speed != null && speed > params.speedLimitKmh / 2) {
        factors.push({
          code: 'speed',
          delta: -8,
          note: `连续速度 ${speed!.toFixed(1)} km/h 偏高（上限 ${params.speedLimitKmh} km/h）`,
        });
        score -= 8;
      }
      if (jump > params.jumpM) {
        if (overSpeed) {
          const big = jump > params.jumpM * 3;
          factors.push({
            code: 'jump',
            delta: big ? -25 : -20,
            note: `${big ? '超大' : ''}瞬时跳变 ${Math.round(jump)}m 且连续速度超速，定位不可达`,
          });
          score += big ? -25 : -20;
        } else {
          factors.push({
            code: 'jump',
            delta: -5,
            note: `间隔跳变 ${Math.round(jump)}m，但连续速度 ${speed!.toFixed(1)} km/h 未超上限，稀疏采样可解释`,
          });
          score -= 5;
        }
      }
    }

    // 围栏因子
    if (ev.sectorId) {
      factors.push({ code: 'fence', delta: 10, note: `坐标位于片区 ${ev.sectorId} 围栏内` });
      score += 10;
    } else {
      factors.push({ code: 'fence', delta: -10, note: '坐标落在全部片区围栏之外（越界候选）' });
      score -= 10;
    }

    // 邻近轨迹密度
    const neighbor = gps.some(
      (g) => g.id !== ev.id && withinWindow(g.at, ev.at, 10),
    );
    if (neighbor) {
      factors.push({ code: 'trajectory_density', delta: 5, note: '10 分钟内存在相邻轨迹点，非孤立定位' });
      score += 5;
    } else {
      factors.push({ code: 'trajectory_density', delta: -5, note: '10 分钟内无相邻轨迹点，孤立定位' });
      score -= 5;
    }

    // 多源证据交叉匹配：照片 / 扫码 / 报修
    const cross = (kind: LocationEvidence['kind'], code: TrustFactor['code'], delta: number) => {
      for (const c of nearby(ev, evidence, kind)) {
        const cSector = c.sourceSectorId ?? c.sectorId;
        const consistent = cSector != null && cSector === ev.sectorId;
        if (consistent) {
          matched.push(c.id);
          factors.push({
            code,
            delta,
            note: `${KIND_REF[kind]} ${c.ref} 同时段同片区（${cSector}）交叉印证`,
          });
          score += delta;
        } else {
          contradict.push(c.id);
          factors.push({
            code,
            delta: -10,
            note: `${KIND_REF[kind]} ${c.ref} 定位片区 ${cSector ?? '围栏外'} 与当前 GPS${
              ev.sectorId ? `（${ev.sectorId}）` : '（围栏外）'
            }矛盾`,
          });
          score -= 10;
        }
      }
    };
    cross('photo', 'photo_confirm', 12);
    cross('scan', 'scan_confirm', 10);
    cross('repair', 'repair_confirm', 8);

    score = CLAMP(score, 0, 100);
    let level: TrustLevel = score >= 65 ? 'trusted' : score >= 40 ? 'suspect' : 'drift';
    if (hardViolation) level = 'drift'; // 速度/跳变硬指标违例，直接判漂移
    result.set(ev.id, {
      evidenceId: ev.id,
      score,
      level,
      factors,
      matchedEvidenceIds: matched,
      contradictEvidenceIds: contradict,
      speedKmh: speed != null ? +speed.toFixed(1) : null,
      jumpM: jump != null ? Math.round(jump) : null,
    });
  }

  return evidence.map((e) => result.get(e.id)!);
}

// ---------------- 漂移段切分 ----------------
export function segmentDrift(
  evidence: LocationEvidence[],
  trusts: LocationTrust[],
): DriftSegment[] {
  const trustById = new Map(trusts.map((t) => [t.evidenceId, t]));
  const gps = evidence.filter((e) => e.kind === 'gps');
  const segments: DriftSegment[] = [];
  let run: LocationEvidence[] = [];

  const flush = (exit: LocationEvidence | null) => {
    if (run.length === 0) return;
    const runStartMs = new Date(run[0].at).getTime();
    // 入口锚点：漂移段之前最近一个可信 GPS 点（缺失时退化为最近的前置 GPS 点）
    const before = gps.filter((g) => new Date(g.at).getTime() < runStartMs);
    const entry =
      [...before].reverse().find((g) => trustById.get(g.id)?.level === 'trusted') ??
      before[before.length - 1] ??
      null;
    const segTrusts = run.map((e) => trustById.get(e.id)!);
    const maxSpeed = Math.max(...segTrusts.map((t) => t.speedKmh ?? 0));
    const maxJump = Math.max(...segTrusts.map((t) => t.jumpM ?? 0));
    segments.push({
      id: `DRIFT-${String(segments.length + 1).padStart(3, '0')}`,
      evidenceIds: run.map((e) => e.id),
      startAt: run[0].at,
      endAt: run[run.length - 1].at,
      entryLocation: entry ? { ...entry.location } : { ...run[0].location },
      exitLocation: exit ? { ...exit.location } : { ...run[run.length - 1].location },
      entrySectorId: entry?.sectorId ?? null,
      exitSectorId: exit?.sectorId ?? null,
      maxJumpM: Math.round(maxJump),
      maxSpeedKmh: +maxSpeed.toFixed(1),
      status: 'none',
      correctedLocation: null,
      correctedSectorId: null,
      correctionBasis: [],
      uncorrectableReason: null,
      supportingEvidenceIds: [],
      contradictEvidenceIds: [],
    });
    run = [];
  };

  for (const g of gps) {
    if (trustById.get(g.id)!.level === 'trusted') {
      flush(g);
    } else {
      run.push(g);
    }
  }
  flush(null);
  return segments;
}

// ---------------- 区间位置校正（明确校验条件） ----------------
/**
 * 校正必须同时满足：
 * C1 漂移段两侧锚点均为可信点且属于同一片区；
 * C2 段内存在落在该同片区的照片/扫码业务证据（人员仍在片区的独立佐证）；
 * C3 段内不存在指向另一片区的矛盾证据；
 * C4 段内 GPS 点全部因速度/跳变/精度类因子判低可信（漂移仅来自定位源本身）。
 * 不满足时标记 uncorrectable，并给出不能校正的时间范围与原因。
 */
export function correctSegments(
  segments: DriftSegment[],
  evidence: LocationEvidence[],
  trusts: LocationTrust[],
  sectors: PatrolSector[],
): DriftSegment[] {
  const trustById = new Map(trusts.map((t) => [t.evidenceId, t]));
  return segments.map((seg) => {
    const startMs = new Date(seg.startAt).getTime();
    const endMs = new Date(seg.endAt).getTime();
    const inWindow = evidence.filter(
      (e) =>
        e.kind !== 'gps' &&
        new Date(e.at).getTime() >= startMs &&
        new Date(e.at).getTime() <= endMs,
    );
    const sameSector = seg.entrySectorId && seg.entrySectorId === seg.exitSectorId;
    const supporting = inWindow.filter(
      (e) => (e.sourceSectorId ?? e.sectorId) === seg.entrySectorId,
    );
    const contradicting = inWindow.filter(
      (e) => {
        const sid = e.sourceSectorId ?? e.sectorId;
        return sid != null && sid !== seg.entrySectorId;
      },
    );

    const c1 = !!sameSector && !!seg.entrySectorId;
    const c2 = supporting.length > 0;
    const c3 = contradicting.length === 0;
    const c4 = seg.evidenceIds.every((id) => {
      const t = trustById.get(id);
      return !!t && t.factors.some((f) => f.code === 'speed' || f.code === 'jump' || f.code === 'accuracy');
    });

    const basis: string[] = [];
    if (c1)
      basis.push(
        `C1 漂移段两侧可信锚点同属片区 ${seg.entrySectorId}（${seg.startAt.slice(11, 16)} 前 / ${seg.endAt.slice(11, 16)} 后）`,
      );
    if (c2)
      basis.push(
        `C2 段内业务证据 ${supporting.map((e) => `${KIND_REF[e.kind]}${e.ref}`).join('、')} 落在同片区，独立佐证人员未离开`,
      );
    if (c3) basis.push('C3 段内无指向另一片区的矛盾证据');
    if (c4)
      basis.push(
        `C4 段内 ${seg.evidenceIds.length} 个 GPS 点均因速度/跳变/精度因子判低可信，漂移仅来自定位源`,
      );

    if (c1 && c2 && c3 && c4) {
      const sector = sectors.find((s) => s.id === seg.entrySectorId)!;
      return {
        ...seg,
        status: 'corrected',
        correctedLocation: { ...sector.anchorLocation },
        correctedSectorId: sector.id,
        correctionBasis: basis,
        supportingEvidenceIds: supporting.map((e) => e.id),
        contradictEvidenceIds: [],
      };
    }

    const badTimes = contradicting.map((e) => e.at.slice(11, 16)).sort();
    const range = badTimes.length ? `${badTimes[0]}–${badTimes[badTimes.length - 1]}` : `${seg.startAt.slice(11, 16)}–${seg.endAt.slice(11, 16)}`;
    const failed = [
      c1 ? null : 'C1 两侧锚点缺失或分属不同片区，无法确定唯一归属区间',
      c2 ? null : 'C2 段内缺少同片区照片/扫码佐证',
      c3 ? null : `C3 存在跨片区矛盾证据 ${contradicting.map((e) => `${KIND_REF[e.kind]}${e.ref}→${e.sourceSectorId ?? e.sectorId}`).join('、')}`,
      c4 ? null : 'C4 段内存在非定位源原因的低可信点',
    ].filter(Boolean) as string[];
    return {
      ...seg,
      status: 'uncorrectable',
      correctedLocation: null,
      correctedSectorId: null,
      correctionBasis: basis,
      uncorrectableReason: `不能校正的时间范围 ${range}：${failed.join('；')}。原始坐标保留，需人工复核是否真实跨片区行程。`,
      supportingEvidenceIds: supporting.map((e) => e.id),
      contradictEvidenceIds: contradicting.map((e) => e.id),
    };
  });
}

// ---------------- 异常检测：独立疑点 / 行程异常 / 报修联动 ----------------
export function detectAnomalies(
  segments: DriftSegment[],
  evidence: LocationEvidence[],
  params: TrustParams,
): LocationAnomaly[] {
  const anomalies: LocationAnomaly[] = [];
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const segOf = (id: string) => segments.find((s) => s.evidenceIds.includes(id));
  let seq = 0;
  const nextId = () => `ANM-${String(++seq).padStart(3, '0')}`;
  const at = (ids: string[]) =>
    ids.map((id) => byId.get(id)!.at).sort()[0];

  // 1) 独立疑点：照片落在漂移段外（照片片区与同时段漂移 GPS 位置矛盾）
  for (const photo of evidence.filter((e) => e.kind === 'photo')) {
    const gpsNear = evidence
      .filter((e) => e.kind === 'gps' && withinWindow(e.at, photo.at, MATCH_WINDOW_MIN))
      .map((e) => ({ e, seg: segOf(e.id) }))
      .filter((x) => x.seg);
    const conflict = gpsNear.find(
      (x) => (x.e.sourceSectorId ?? x.e.sectorId) !== (photo.sourceSectorId ?? photo.sectorId),
    );
    if (conflict) {
      const dist = haversineM(photo.location, conflict.e.location);
      anomalies.push({
        id: nextId(),
        kind: 'independent_doubt',
        title: `照片 ${photo.ref} 落在漂移段外，定位与现场影像矛盾`,
        at: at([photo.id, conflict.e.id]),
        sectorId: photo.sectorId,
        deviceId: photo.deviceId,
        evidenceIds: [photo.id, conflict.e.id],
        driftSegmentId: conflict.seg!.id,
        detail: `照片定位 ${photo.location.lng.toFixed(4)},${photo.location.lat.toFixed(4)}（片区 ${photo.sectorId ?? '围栏外'}）与同时段 GPS 相距 ${Math.round(dist)}m；照片证明人员仍在指定片区，GPS 为独立疑点。`,
        verdict: 'open',
        severityScore: 72,
      });
    }
  }

  // 2) 行程异常：漂移段内连续速度越过可达上限
  for (const seg of segments) {
    if (seg.maxSpeedKmh > params.speedLimitKmh) {
      anomalies.push({
        id: nextId(),
        kind: 'trip_anomaly',
        title: `漂移段 ${seg.id} 连续速度越过可达上限`,
        at: seg.startAt,
        sectorId: seg.entrySectorId,
        deviceId: null,
        evidenceIds: seg.evidenceIds,
        driftSegmentId: seg.id,
        detail: `段内最大连续速度 ${seg.maxSpeedKmh} km/h，超过巡检可达上限 ${params.speedLimitKmh} km/h；最大瞬时跳变 ${seg.maxJumpM}m，步行/巡检车程均不可达，判定为定位漂移造成的行程异常。`,
        verdict: 'open',
        severityScore: 68,
      });
    }
  }

  // 3) 报修联动：扫码属另一片区，且同时段同设备/同片区报修单相互印证
  for (const scan of evidence.filter((e) => e.kind === 'scan')) {
    const seg = evidence
      .filter((e) => e.kind === 'gps' && withinWindow(e.at, scan.at, MATCH_WINDOW_MIN))
      .map((e) => segOf(e.id))
      .find(Boolean);
    const repair = evidence.find(
      (e) =>
        e.kind === 'repair' &&
        withinWindow(e.at, scan.at, MATCH_WINDOW_MIN) &&
        (e.deviceId === scan.deviceId ||
          (e.sourceSectorId ?? e.sectorId) === (scan.sourceSectorId ?? scan.sectorId)),
    );
    if (!repair) continue;
    const gpsSector = seg?.entrySectorId ?? null;
    const scanSector = scan.sourceSectorId ?? scan.sectorId;
    if (scanSector && scanSector !== gpsSector) {
      anomalies.push({
        id: nextId(),
        kind: 'repair_link',
        title: `扫码 ${scan.ref} 属另一片区并与报修单 ${repair.ref} 联动`,
        at: at([scan.id, repair.id]),
        sectorId: scanSector,
        deviceId: scan.deviceId,
        evidenceIds: [scan.id, repair.id, ...(seg ? seg.evidenceIds.slice(0, 2) : [])],
        driftSegmentId: seg?.id ?? null,
        detail: `扫码绑定片区 ${scanSectorIdText(scanSector)}，与漂移 GPS 暗示片区 ${gpsSector ?? '围栏外'} 不一致；同时段报修单 ${repair.ref}（设备 ${scan.deviceId ?? repair.deviceId}）相互印证，人员可能真实跨片区作业，该范围禁止自动校正。`,
        verdict: 'open',
        severityScore: 80,
      });
    }
  }

  return anomalies;
}

function scanSectorIdText(id: string | null): string {
  return id ?? '围栏外';
}

// ---------------- 定位越界告警 + 降权 + 复核队列 ----------------
const DOWNWEIGHT_MAP: Record<Severity, Severity> = {
  critical: 'minor',
  major: 'info',
  minor: 'info',
  info: 'info',
};

export interface GeoAnalysisInput {
  raw: RawRecord[];
  sectors: PatrolSector[];
  rule: RuleDef;
  ruleVersionId: string;
  mappingVersion: string;
  ledgerVersion: string;
  nowIso: string;
}

export interface GeoAnalysis {
  evidence: LocationEvidence[];
  trusts: LocationTrust[];
  segments: DriftSegment[];
  anomalies: LocationAnomaly[];
  alerts: Alert[];
  reviewItems: ReviewItem[];
}

export async function analyzeLocation(input: GeoAnalysisInput): Promise<GeoAnalysis> {
  const jumpM = input.rule.params.geoJumpM ?? 500;
  const speedLimit = input.rule.params.geoSpeedLimitKmh ?? 60;
  const trustFloor = input.rule.params.geoTrustFloor ?? 45;

  const evidence = extractLocationEvidence(input.raw, input.sectors);
  const trusts = evaluateTrust(evidence, { jumpM, speedLimitKmh: speedLimit });
  let segments = segmentDrift(evidence, trusts);
  segments = correctSegments(segments, evidence, trusts, input.sectors);
  const anomalies = detectAnomalies(segments, evidence, { jumpM, speedLimitKmh: speedLimit });

  const trustById = new Map(trusts.map((t) => [t.evidenceId, t]));
  const segByEvidence = new Map<string, DriftSegment>();
  for (const s of segments) for (const id of s.evidenceIds) segByEvidence.set(id, s);
  // 复核引用优先用原始记录签名；签名缺失（未走装载器的纯函数调用）时回退证据 ID，保证引用非空
  const sigOf = (id: string) => evidence.find((e) => e.id === id)?.signature || id;

  const alerts: Alert[] = [];
  const reviewItems: ReviewItem[] = [];
  let reviewSeq = 0;
  const sectorDevice = (sectorId: string | null) =>
    input.sectors.find((s) => s.id === sectorId)?.deviceIds[0] ?? null;

  for (const ev of evidence.filter((e) => e.kind === 'gps')) {
    if (ev.sectorId) continue; // 围栏内不产生越界告警
    const trust = trustById.get(ev.id)!;
    const seg = segByEvidence.get(ev.id) ?? null;
    const expectedSector = seg?.entrySectorId ?? null;
    const deviceId = sectorDevice(expectedSector) ?? ev.deviceId ?? 'UNKNOWN';
    const crossRefs = [
      ...trust.matchedEvidenceIds,
      ...trust.contradictEvidenceIds,
    ].map(sigOf);

    const originalSeverity = input.rule.baseSeverity;
    const basis: string[] = [
      `定位可信度 ${trust.score} 分（${trust.level}），门限 ${trustFloor}`,
      ...trust.factors.map((f) => `${f.note}（${f.delta >= 0 ? '+' : ''}${f.delta}）`),
    ];
    let adjustedSeverity = originalSeverity;
    let downweighted = false;
    if (seg?.status === 'corrected' && trust.score < trustFloor + 30) {
      adjustedSeverity = DOWNWEIGHT_MAP[originalSeverity];
      downweighted = true;
      basis.push(`漂移段 ${seg.id} 满足全部校正条件，多源证据确认人员未离开 ${seg.correctedSectorId}，定位单独触发风险降权`);
    } else if (seg?.status === 'uncorrectable') {
      basis.push(`漂移段 ${seg.id} 不可校正：${seg.uncorrectableReason}；维持原严重度，不降权，转人工复核`);
    }

    const reviewItemId = `REV-GEO-${String(++reviewSeq).padStart(3, '0')}`;
    const geoAdjustment: AlertGeoAdjustment = {
      originalSeverity,
      adjustedSeverity,
      trustLevel: trust.level,
      driftSegmentId: seg?.id ?? null,
      correctedLocation: seg?.correctedLocation ?? null,
      basis,
      downweighted,
      reviewItemId,
    };

    const seed = {
      ruleId: input.rule.id,
      ruleVersionId: input.ruleVersionId,
      ledgerVersion: input.ledgerVersion,
      mappingVersion: input.mappingVersion,
      deviceId,
      kind: 'geo_breach' as const,
      observedAt: ev.at,
      windowStart: seg?.startAt ?? ev.at,
      windowEnd: seg?.endAt ?? ev.at,
      evidenceRefs: [ev.signature || ev.id, ...crossRefs],
      detail: `GPS 点 ${ev.ref} 于 ${ev.at.slice(11, 16)} 落在全部片区围栏外（${ev.location.lng.toFixed(4)}, ${ev.location.lat.toFixed(4)}）；可信度 ${trust.score}/${trust.level}${
        seg ? `；归属漂移段 ${seg.id}（${seg.status === 'corrected' ? '已校正为区间位置' : seg.status === 'uncorrectable' ? '不可校正范围' : '待判'}）` : ''
      }`,
    };
    const id = await contentId(seed);
    alerts.push({
      id,
      ruleId: input.rule.id,
      ruleVersionId: input.ruleVersionId,
      ledgerVersion: input.ledgerVersion,
      mappingVersion: input.mappingVersion,
      deviceId,
      kind: 'geo_breach',
      severity: adjustedSeverity,
      observedAt: ev.at,
      windowStart: seed.windowStart,
      windowEnd: seed.windowEnd,
      evidenceRefs: seed.evidenceRefs,
      detail: seed.detail,
      recommendation: downweighted
        ? '定位漂移已由照片/扫码交叉印证并降权：按校正区间位置归档，无需现场派单'
        : '保留原始坐标与原严重度：核验跨片区扫码/报修与现场影像后人工判定是否真实越界',
      contribution: {
        severityScore: downweighted ? 25 : 70,
        rationale: `原严重度 ${originalSeverity} → 调整后 ${adjustedSeverity}；${downweighted ? '多源证据降权' : '证据矛盾未降权'}，可信度 ${trust.score}`,
        recommendation: downweighted ? '贡献处置建议：区间校正归档' : '贡献处置建议：人工复核队列优先处理',
      },
      context: {
        inConstruction: false,
        constructionId: null,
        networkDrift: false,
        backfilled: false,
      },
      geoAdjustment,
    });

    reviewItems.push({
      id: reviewItemId,
      createdAt: input.nowIso,
      category: 'geo_alert',
      refId: id,
      title: `定位越界告警复核 · ${ev.at.slice(11, 16)} · ${downweighted ? '已降权' : '维持原级'}`,
      reason: basis.join('；'),
      severity: adjustedSeverity,
      status: 'queued',
      resolution: null,
      resolvedBy: null,
      resolvedAt: null,
      evidenceRefs: seed.evidenceRefs,
    });
  }

  for (const seg of segments) {
    reviewItems.push({
      id: `REV-SEG-${seg.id}`,
      createdAt: input.nowIso,
      category: 'drift_segment',
      refId: seg.id,
      title: `漂移段 ${seg.id}（${seg.startAt.slice(11, 16)}–${seg.endAt.slice(11, 16)}）${
        seg.status === 'corrected' ? '区间位置校正' : '不可校正范围'
      }`,
      reason:
        seg.status === 'corrected'
          ? seg.correctionBasis.join('；')
          : seg.uncorrectableReason ?? '存在未满足的校正条件',
      severity: seg.status === 'corrected' ? 'minor' : 'major',
      status: 'queued',
      resolution: null,
      resolvedBy: null,
      resolvedAt: null,
      evidenceRefs: evidence
        .filter((e) => seg.evidenceIds.includes(e.id) || seg.supportingEvidenceIds.includes(e.id) || seg.contradictEvidenceIds.includes(e.id))
        .map((e) => e.signature || e.id),
    });
  }

  for (const anm of anomalies) {
    reviewItems.push({
      id: `REV-ANM-${anm.id}`,
      createdAt: input.nowIso,
      category: 'anomaly',
      refId: anm.id,
      title: anm.title,
      reason: anm.detail,
      severity: anm.severityScore >= 75 ? 'major' : 'minor',
      status: 'queued',
      resolution: null,
      resolvedBy: null,
      resolvedAt: null,
      evidenceRefs: anm.evidenceIds.map(sigOf),
    });
  }

  return { evidence, trusts, segments, anomalies, alerts, reviewItems };
}
