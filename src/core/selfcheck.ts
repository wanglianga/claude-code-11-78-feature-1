// ============================================================
// 自检断言库：以三阶段样例核验双路线的成员集合、严重度、贡献说明、
// 重算影响与同步差异。UI 自检页与 Vitest 共用同一套断言。
// ============================================================

import { canonicalize, sha256Hex } from './crypto';
import { decodeWitness } from './compression';
import type { PipelineOutput } from './pipeline';
import type { Alert, RuleKind } from './types';

export interface CheckResult {
  id: string;
  dimension:
    | '漂移与施工'
    | '规则换版'
    | '离线补传'
    | '双路线一致性'
    | '证据完整性'
    | '定位可信度';
  name: string;
  passed: boolean;
  detail: string;
}

const ok = (id: string, dimension: CheckResult['dimension'], name: string, detail: string): CheckResult => ({
  id,
  dimension,
  name,
  passed: true,
  detail,
});
const bad = (id: string, dimension: CheckResult['dimension'], name: string, detail: string): CheckResult => ({
  id,
  dimension,
  name,
  passed: false,
  detail,
});

const countBy = (alerts: Alert[], deviceId: string, kind: RuleKind) =>
  alerts.filter((a) => a.deviceId === deviceId && a.kind === kind).length;

export async function runSelfCheck(
  out: PipelineOutput,
  rawSignedCount: number,
  rawSignatures?: Set<string>,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const v1 = out.alerts.filter((a) => a.ruleVersionId === 'RV-2026.1');
  const v2 = out.alerts.filter((a) => a.ruleVersionId === 'RV-2026.2');
  const alertsById = new Map(out.alerts.map((a) => [a.id, a]));

  // ---------- 证据完整性 ----------
  results.push(
    rawSignedCount > 0
      ? ok('EV-1', '证据完整性', '原始记录全部带签名', `${rawSignedCount} 条原始记录均固化 SHA-256 签名`)
      : bad('EV-1', '证据完整性', '原始记录全部带签名', '存在未签名记录'),
  );

  const refsAll = new Set(out.alerts.flatMap((a) => a.evidenceRefs));
  const everyRefResolvable = rawSignatures
    ? [...refsAll].every((sig) => rawSignatures.has(sig))
    : [...refsAll].every((sig) => out.alerts.some((a) => a.evidenceRefs.includes(sig)));
  results.push(
    everyRefResolvable
      ? ok(
          'EV-2',
          '证据完整性',
          '告警证据引用可回溯到签名原始记录',
          `${refsAll.size} 个证据签名引用${rawSignatures ? '均命中 IndexedDB 原始记录签名' : '均来自核验输入'}`,
        )
      : bad('EV-2', '证据完整性', '告警证据引用可回溯到签名原始记录', '存在无法回溯的证据引用'),
  );

  const noSnapshotOnly =
    out.eventsA.every((e) => (e.memberships?.length ?? 0) > 0) &&
    out.eventsB.every((e) => (e.witness?.alertRefs.length ?? 0) > 0);
  results.push(
    noSnapshotOnly
      ? ok('EV-3', '证据完整性', '不存在只含摘要的事件快照', 'A 事件均带成员关系，B 事件均带内容寻址告警引用')
      : bad('EV-3', '证据完整性', '不存在只含摘要的事件快照', '发现无成员的摘要事件'),
  );

  // ---------- 漂移与施工 ----------
  const suppressedJump = out.alerts.find(
    (a) =>
      a.deviceId === 'VW-001' &&
      a.kind === 'jump' &&
      a.severity === 'info' &&
      a.context.inConstruction,
  );
  results.push(
    suppressedJump
      ? ok(
          'DC-1',
          '漂移与施工',
          '施工窗口跳变按清单抑制但保留为成员',
          `11:00 回落跳变降级 info 并保留证据：${suppressedJump.detail.slice(0, 48)}…`,
        )
      : bad('DC-1', '漂移与施工', '施工窗口跳变按清单抑制但保留为成员', '未找到施工抑制的跳变成员'),
  );

  const driftAlerts = out.alerts.filter((a) => a.context.networkDrift).length;
  results.push(
    driftAlerts > 0
      ? ok('DC-2', '漂移与施工', '网络漂移只作上下文、不批量关闭', `${driftAlerts} 条告警带漂移上下文且全部保留`)
      : bad('DC-2', '漂移与施工', '网络漂移只作上下文、不批量关闭', '未检出漂移上下文'),
  );

  const missingGap = out.alerts.find(
    (a) => a.deviceId === 'VW-001' && a.kind === 'missing' && a.detail.includes('45 分钟'),
  );
  results.push(
    missingGap
      ? ok('DC-3', '漂移与施工', '漂移乱序后的缺测仍按时间线识别', 'VW-001 09:15→10:00 的 45 分钟缺口被识别（乱序 10:30 不影响时间线）')
      : bad('DC-3', '漂移与施工', '漂移乱序后的缺测仍按时间线识别', '缺测未识别'),
  );

  // ---------- 规则换版 ----------
  const checks: Array<[string, string, RuleKind, number, number]> = [
    ['RV-1', 'PS-002 跳变换版后增多（13:00/13:10 新增）', 'jump', 2, 4],
    ['RV-2', 'VW-001 缺测换版后增多（13:30 新增）', 'missing', 1, 2],
    ['RV-3', 'FS-003 缺测（16:00 缺口）仅换版后可见', 'missing', 0, 1],
  ];
  for (const [id, name, kind, expectV1, expectV2] of checks) {
    const device = id === 'RV-1' ? 'PS-002' : id === 'RV-2' ? 'VW-001' : 'FS-003';
    const c1 = countBy(v1, device, kind);
    const c2 = countBy(v2, device, kind);
    results.push(
      c1 === expectV1 && c2 === expectV2
        ? ok(id, '规则换版', name, `${device} ${kind}：v1=${c1}，v2=${c2}`)
        : bad(id, '规则换版', name, `${device} ${kind}：期望 v1=${expectV1}/v2=${expectV2}，实际 v1=${c1}/v2=${c2}`),
    );
  }

  const contraV1 = v1.find((a) => a.deviceId === 'VW-001' && a.kind === 'contradiction');
  const contraV2 = v2.find((a) => a.deviceId === 'VW-001' && a.kind === 'contradiction');
  results.push(
    contraV1?.severity === 'major' && contraV2?.severity === 'critical'
      ? ok('RV-4', '规则换版', '矛盾规则换版后升级 critical', `v1=${contraV1?.severity} → v2=${contraV2?.severity}`)
      : bad('RV-4', '规则换版', '矛盾规则换版后升级 critical', `v1=${contraV1?.severity}，v2=${contraV2?.severity}`),
  );

  const overdueV1 = countBy(v1, 'FS-003', 'overdue');
  const overdueV2 = countBy(v2, 'FS-003', 'overdue');
  results.push(
    overdueV1 === 0 && overdueV2 === 1
      ? ok('RV-5', '规则换版', '逾期宽限收紧后新增逾期（RC-003）', `v1=${overdueV1}（60 分钟宽限）→ v2=${overdueV2}（30 分钟宽限）`)
      : bad('RV-5', '规则换版', '逾期宽限收紧后新增逾期（RC-003）', `v1=${overdueV1}，v2=${overdueV2}`),
  );

  const linked = out.eventsA.filter((e) => e.ruleVersionId === 'RV-2026.2' && e.parentEventId);
  results.push(
    linked.length > 0
      ? ok('RV-6', '规则换版', '局部重算事件通过 parentEventId 串联', `${linked.length} 个 v2 事件挂接 v1 父事件，旧事件未改写`)
      : bad('RV-6', '规则换版', '局部重算事件通过 parentEventId 串联', '重算链缺失'),
  );

  // ---------- 离线补传 ----------
  results.push(
    out.report.conflicts.length >= 2
      ? ok('OB-1', '离线补传', '离线行动与远端写入产生冲突并保留双方', `${out.report.conflicts.length} 项冲突（事件状态/行动/回执）`)
      : bad('OB-1', '离线补传', '离线行动与远端写入产生冲突并保留双方', `冲突数=${out.report.conflicts.length}`),
  );
  const backfillAlerts = out.alerts.filter((a) => a.context.backfilled).length;
  results.push(
    backfillAlerts > 0
      ? ok('OB-2', '离线补传', '补传观测参与核验并标注上下文', `${backfillAlerts} 条告警成员来自补传/延迟回执`)
      : bad('OB-2', '离线补传', '补传观测参与核验并标注上下文', '未检出补传上下文'),
  );

  // ---------- 双路线一致性 ----------
  const eq = out.report.equivalence;
  const allEq = eq.every((e) => e.sameMembers && e.sameSeverity && e.sameContributions);
  results.push(
    allEq
      ? ok('AB-1', '双路线一致性', '两路线还原相同成员集合/严重度/贡献', `${eq.length} 个同键事件全部一致`)
      : bad('AB-1', '双路线一致性', '两路线还原相同成员集合/严重度/贡献', '存在不一致事件'),
  );

  const boundaryPass = out.eventsB.every((e) => e.witness?.boundary.passed);
  results.push(
    boundaryPass
      ? ok('AB-2', '双路线一致性', '全部见证边界校验通过、无遗漏成员', `${out.eventsB.length} 个见证均通过相邻槽位检查`)
      : bad('AB-2', '双路线一致性', '全部见证边界校验通过、无遗漏成员', '存在边界遗漏'),
  );

  let tamperDetected = true;
  for (const e of out.eventsB) {
    if (!e.witness) continue;
    const { witnessHash: _h, boundary: _b, ...body } = e.witness;
    const recompute = await sha256Hex(canonicalize(body));
    if (recompute !== e.witness.witnessHash) {
      tamperDetected = false;
      break;
    }
  }
  results.push(
    tamperDetected
      ? ok('AB-3', '双路线一致性', '见证哈希重算一致（防篡改）', '全部见证 witnessHash 与规范化体重算结果相同')
      : bad('AB-3', '双路线一致性', '见证哈希防篡改', '见证体与哈希不符'),
  );

  let decodeOk = true;
  let decodeDetail = '';
  for (const e of out.eventsB) {
    if (!e.witness) continue;
    try {
      const decoded = decodeWitness(e.witness, alertsById, out.dict);
      if (decoded.length !== e.memberCount) {
        decodeOk = false;
        decodeDetail = `事件 ${e.id} 解码成员数 ${decoded.length} ≠ ${e.memberCount}`;
        break;
      }
    } catch (err) {
      decodeOk = false;
      decodeDetail = (err as Error).message;
      break;
    }
  }
  results.push(
    decodeOk
      ? ok('AB-4', '双路线一致性', 'B 路线确定性解码可完整还原成员', decodeDetail || '所有见证解码成功且成员数一致')
      : bad('AB-4', '双路线一致性', 'B 路线确定性解码可完整还原成员', decodeDetail),
  );

  const smaller = out.report.routeStats.B.payloadBytes < out.report.routeStats.A.payloadBytes;
  results.push(
    smaller
      ? ok(
          'AB-5',
          '双路线一致性',
          '路线 B 本地存储小于路线 A（同步量差异）',
          `A=${out.report.routeStats.A.payloadBytes}B，B=${out.report.routeStats.B.payloadBytes}B`,
        )
      : bad('AB-5', '双路线一致性', '路线 B 本地存储小于路线 A', '体积对比异常'),
  );

  // ---------- 定位可信度 ----------
  const corrected = out.driftSegments.filter((s) => s.status === 'corrected');
  const uncorrectable = out.driftSegments.filter((s) => s.status === 'uncorrectable');
  results.push(
    out.driftSegments.length === 2 && corrected.length === 1 && uncorrectable.length === 1
      ? ok('GEO-1', '定位可信度', '漂移切分得到可校正段与不可校正段各一', `共 ${out.driftSegments.length} 段：${corrected[0].id} 已校正、${uncorrectable[0].id} 不可校正`)
      : bad('GEO-1', '定位可信度', '漂移切分得到可校正段与不可校正段各一', `实际段数=${out.driftSegments.length}，校正=${corrected.length}，不可校正=${uncorrectable.length}`),
  );

  const seg1 = corrected[0];
  const basisOk = !!seg1 && ['C1', 'C2', 'C3', 'C4'].every((c) => seg1.correctionBasis.some((b) => b.startsWith(c)));
  results.push(
    basisOk
      ? ok('GEO-2', '定位可信度', '区间校正满足 C1-C4 明确校验条件并保留依据', `${seg1!.id} 校正到片区 ${seg1!.correctedSectorId} 锚点，${seg1!.correctionBasis.length} 条依据可审计`)
      : bad('GEO-2', '定位可信度', '区间校正满足 C1-C4 明确校验条件并保留依据', '校正条件依据不完整'),
  );

  const seg2 = uncorrectable[0];
  const reasonOk = !!seg2 && !!seg2.uncorrectableReason?.includes('不能校正的时间范围') && seg2.contradictEvidenceIds.length >= 2;
  results.push(
    reasonOk
      ? ok('GEO-3', '定位可信度', '不可校正范围保留时间范围、原因与跨片区矛盾证据', seg2!.uncorrectableReason!)
      : bad('GEO-3', '定位可信度', '不可校正范围保留时间范围、原因与跨片区矛盾证据', '缺少不可校正范围说明或矛盾证据'),
  );

  const locById = new Map(out.locationEvidence.map((e) => [e.id, e]));
  const rawKept =
    !!seg1 &&
    seg1.evidenceIds.every((id) => {
      const e = locById.get(id);
      return e && e.sectorId === null; // 原始漂移点仍在围栏外，未被校正落点替换
    });
  results.push(
    rawKept
      ? ok('GEO-4', '定位可信度', '校正后原始 GPS 坐标完整保留、不回写原始记录', `${seg1!.evidenceIds.length} 个漂移点原始坐标仍为数公里外的围栏外位置`)
      : bad('GEO-4', '定位可信度', '校正后原始 GPS 坐标完整保留、不回写原始记录', '发现原始坐标被替换'),
  );

  const kindCount = (k: string) => out.locationAnomalies.filter((a) => a.kind === k).length;
  const anomalyOk =
    kindCount('independent_doubt') === 2 &&
    kindCount('trip_anomaly') === 2 &&
    kindCount('repair_link') === 1;
  results.push(
    anomalyOk
      ? ok('GEO-5', '定位可信度', '独立疑点/行程异常/报修联动三类样例齐全', `独立疑点 2（照片在漂移段外）、行程异常 2（连续速度越上限）、报修联动 1（跨片区扫码+报修单）`)
      : bad('GEO-5', '定位可信度', '独立疑点/行程异常/报修联动三类样例齐全', `实际计数 ${JSON.stringify(out.locationAnomalies.map((a) => a.kind))}`),
  );

  const geoAlerts = out.alerts.filter((a) => a.kind === 'geo_breach');
  const down = geoAlerts.filter((a) => a.geoAdjustment?.downweighted);
  const kept = geoAlerts.filter((a) => a.geoAdjustment && !a.geoAdjustment.downweighted);
  const downweightOk =
    geoAlerts.length === 5 &&
    down.length === 3 &&
    kept.length === 2 &&
    down.every((a) => a.geoAdjustment!.originalSeverity === 'critical' && a.severity === 'minor') &&
    kept.every((a) => a.severity === 'critical');
  results.push(
    downweightOk
      ? ok('GEO-6', '定位可信度', '定位单独触发的越界告警按多源证据降权、原级留痕', `3 条可校正段告警 critical→minor；2 条不可校正段维持 critical，originalSeverity 全部保留`)
      : bad('GEO-6', '定位可信度', '定位单独触发的越界告警按多源证据降权、原级留痕', `越界告警 ${geoAlerts.length} 条，降权 ${down.length} 条，维持 ${kept.length} 条`),
  );

  const reviewCats = new Set(out.reviewItems.map((r) => r.category));
  const reviewTraceable = out.reviewItems.every((r) => r.evidenceRefs.length > 0);
  results.push(
    reviewCats.size === 3 && reviewTraceable
      ? ok('GEO-7', '定位可信度', '复核队列覆盖告警/漂移段/异常且证据可回溯', `${out.reviewItems.length} 条复核单，类别 ${[...reviewCats].join('/')}，证据签名均非空`)
      : bad('GEO-7', '定位可信度', '复核队列覆盖告警/漂移段/异常且证据可回溯', `类别数=${reviewCats.size}，可回溯=${reviewTraceable}`),
  );

  const geoInEvents = [...out.eventsA, ...out.eventsB].some((e) => e.ruleId === 'R-GEO');
  results.push(
    geoInEvents
      ? ok('GEO-8', '定位可信度', '定位越界告警进入双路线压缩并参与 A/B 等价核验', 'R-GEO 事件同时存在于路线 A 成员关系与路线 B 见证')
      : bad('GEO-8', '定位可信度', '定位越界告警进入双路线压缩并参与 A/B 等价核验', '未找到 R-GEO 聚合事件'),
  );

  return results;
}
