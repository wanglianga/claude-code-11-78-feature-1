// ============================================================
// 定位可信度子系统单测：
// 距离/速度、逐点可信度、漂移切分、C1-C4 区间校正、不可校正范围、
// 独立疑点/行程异常/报修联动、越界告警降权与复核队列。
// ============================================================

import { describe, expect, it } from 'vitest';
import { buildScenario, t } from './scenario';
import {
  analyzeLocation,
  evaluateTrust,
  extractLocationEvidence,
  haversineM,
  segmentDrift,
  correctSegments,
  speedKmh,
} from './geo';
import { signRecord } from './loader';
import type { RuleDef } from './types';

async function analyze() {
  const bundle = buildScenario();
  // 与真实管线一致：装载器先对原始记录固化签名，再进入定位分析
  const signedRaw = await Promise.all(
    bundle.raw.map(async (r) => ({ ...r, signature: await signRecord(r) })),
  );
  const rule = bundle.ruleVersions
    .find((r) => r.id === 'RV-2026.2')!
    .rules.find((r) => r.kind === 'geo_breach')! as RuleDef;
  const out = await analyzeLocation({
    raw: signedRaw,
    sectors: bundle.sectors,
    rule,
    ruleVersionId: 'RV-2026.2',
    mappingVersion: bundle.mapping.version,
    ledgerVersion: 'ledger-v3',
    nowIso: t(18, 0),
  });
  return { bundle, rule, out };
}

describe('地理计算', () => {
  it('haversine 与连续速度：1 度纬度约 111km，超速可识别', () => {
    const a = { lng: 116.4, lat: 39.9 };
    const b = { lng: 116.4, lat: 40.9 };
    const d = haversineM(a, b);
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
    // 10 分钟移动 111km => ~666 km/h
    const v = speedKmh(
      { at: t(14, 0), location: a },
      { at: t(14, 10), location: b },
    );
    expect(v).toBeGreaterThan(600);
    expect(
      speedKmh(
        { at: t(14, 10), location: a },
        { at: t(14, 0), location: b },
      ),
    ).toBeNull();
  });
});

describe('多源证据抽取与逐点可信度', () => {
  it('抽取 GPS/照片/扫码/报修四类证据并标注围栏片区', async () => {
    const { bundle } = await analyze();
    const ev = extractLocationEvidence(bundle.raw, bundle.sectors);
    const counts = ev.reduce<Record<string, number>>((acc, e) => {
      acc[e.kind] = (acc[e.kind] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts.gps).toBe(18); // 4 条原签到 + 14 条漂移轨迹
    expect(counts.photo).toBe(2);
    expect(counts.scan).toBe(2);
    expect(counts.repair).toBe(1);
    // 漂移 GPS 在围栏外，照片/扫码在绑定片区内
    expect(ev.find((e) => e.ref === 'IMG-9001')!.sectorId).toBe('PS-A');
    expect(ev.find((e) => e.ref === 'SC-C-11')!.sourceSectorId).toBe('PS-C');
  });

  it('连续速度越过可达上限的 GPS 点强制判漂移，并保留可解释因子', async () => {
    const { out } = await analyze();
    const byTime = new Map(
      out.evidence.filter((e) => e.kind === 'gps').map((e) => [e.at, e]),
    );
    const trustAt = (h: number, m: number) =>
      out.trusts.find((x) => x.evidenceId === byTime.get(t(h, m))!.id)!;

    const drift = trustAt(14, 20);
    expect(drift.level).toBe('drift');
    expect(drift.speedKmh).toBeGreaterThan(60);
    expect(drift.factors.some((f) => f.code === 'speed' && f.delta < 0)).toBe(true);
    expect(drift.contradictEvidenceIds.length).toBeGreaterThan(0);

    // 正常稀疏签到：13:10 与上一点相距 1.1km，但速度仅 0.3km/h，不得判漂移
    const normal = trustAt(13, 10);
    expect(normal.level).toBe('trusted');
    expect(normal.factors.some((f) => f.code === 'jump' && f.note.includes('稀疏采样可解释'))).toBe(true);
  });

  it('纯函数分层调用结果与总分析一致', async () => {
    const { bundle, rule } = await analyze();
    const evidence = extractLocationEvidence(bundle.raw, bundle.sectors);
    const trusts = evaluateTrust(evidence, {
      jumpM: rule.params.geoJumpM!,
      speedLimitKmh: rule.params.geoSpeedLimitKmh!,
    });
    const segments = correctSegments(
      segmentDrift(evidence, trusts),
      evidence,
      trusts,
      bundle.sectors,
    );
    expect(segments.length).toBe(2);
  });
});

describe('漂移段切分与区间位置校正', () => {
  it('段一满足 C1-C4 校正为 PS-A 锚点区间位置，段二因跨片区证据不可校正', async () => {
    const { bundle, out } = await analyze();
    expect(out.segments.length).toBe(2);
    const [seg1, seg2] = out.segments;

    expect(seg1.status).toBe('corrected');
    expect(seg1.entrySectorId).toBe('PS-A');
    expect(seg1.exitSectorId).toBe('PS-A');
    expect(seg1.correctedSectorId).toBe('PS-A');
    const anchor = bundle.sectors.find((s) => s.id === 'PS-A')!.anchorLocation;
    expect(seg1.correctedLocation).toEqual(anchor);
    for (const code of ['C1', 'C2', 'C3', 'C4']) {
      expect(seg1.correctionBasis.some((b) => b.startsWith(code))).toBe(true);
    }
    expect(seg1.supportingEvidenceIds.length).toBeGreaterThanOrEqual(2); // 照片 + 同片区扫码
    expect(seg1.contradictEvidenceIds).toEqual([]);

    expect(seg2.status).toBe('uncorrectable');
    expect(seg2.correctedLocation).toBeNull();
    expect(seg2.uncorrectableReason).toContain('不能校正的时间范围');
    expect(seg2.uncorrectableReason).toContain('SC-C-11');
    expect(seg2.contradictEvidenceIds.length).toBe(2); // 跨片区扫码 + 报修
  });

  it('原始 GPS 坐标在校正后仍完整保留，不被区间位置替换', async () => {
    const { out } = await analyze();
    const seg1 = out.segments[0];
    const driftPoints = seg1.evidenceIds.map(
      (id) => out.evidence.find((e) => e.id === id)!,
    );
    expect(driftPoints.every((e) => e.sectorId === null)).toBe(true); // 原始点仍在围栏外
    expect(driftPoints.some((e) => e.location.lng > 116.45)).toBe(true); // 数公里外原坐标保留
  });
});

describe('异常检测与告警降权', () => {
  it('产出独立疑点、行程异常、报修联动三类异常', async () => {
    const { out } = await analyze();
    const kinds = out.anomalies.map((a) => a.kind);
    expect(kinds.filter((k) => k === 'independent_doubt').length).toBe(2);
    expect(kinds.filter((k) => k === 'trip_anomaly').length).toBe(2);
    expect(kinds.filter((k) => k === 'repair_link').length).toBe(1);
    const repair = out.anomalies.find((a) => a.kind === 'repair_link')!;
    const refs = repair.evidenceIds.map((id) => out.evidence.find((e) => e.id === id)?.ref);
    expect(refs).toContain('SC-C-11');
    expect(refs).toContain('RP-2026-11-23-09');
    expect(repair.detail).toContain('禁止自动校正');
  });

  it('仅由定位单独触发的越界告警：可校正段降权、不可校正段维持原级', async () => {
    const { out } = await analyze();
    expect(out.alerts.every((a) => a.kind === 'geo_breach')).toBe(true);
    expect(out.alerts.length).toBe(5);
    const down = out.alerts.filter((a) => a.geoAdjustment!.downweighted);
    const kept = out.alerts.filter((a) => !a.geoAdjustment!.downweighted);
    expect(down.length).toBe(3);
    expect(kept.length).toBe(2);
    for (const a of down) {
      expect(a.geoAdjustment!.originalSeverity).toBe('critical');
      expect(a.severity).toBe('minor');
      expect(a.geoAdjustment!.correctedLocation).not.toBeNull();
    }
    for (const a of kept) {
      expect(a.severity).toBe('critical');
      expect(a.geoAdjustment!.driftSegmentId).toBe('DRIFT-002');
    }
  });

  it('复核队列覆盖越界告警、漂移段、异常三类，且证据签名可回溯', async () => {
    const { out } = await analyze();
    const cats = new Set(out.reviewItems.map((r) => r.category));
    expect(cats).toEqual(new Set(['geo_alert', 'drift_segment', 'anomaly']));
    expect(out.reviewItems.every((r) => r.status === 'queued')).toBe(true);
    expect(out.reviewItems.every((r) => r.evidenceRefs.length > 0)).toBe(true);
    const sigs = new Set(out.evidence.map((e) => e.signature));
    for (const r of out.reviewItems) {
      for (const s of r.evidenceRefs) expect(sigs.has(s)).toBe(true);
    }
  });
});
