import { useMemo, useState } from 'react';
import { useApp } from '../../state/app';
import type {
  DriftSegment,
  LocationAnomaly,
  LocationEvidence,
  LocationTrust,
  ReviewItem,
  TrustLevel,
} from '../../core/types';
import { SeverityBadge, hm, short } from '../components';

const KIND_LABEL: Record<LocationEvidence['kind'], string> = {
  gps: 'GPS',
  photo: '照片',
  scan: '扫码',
  repair: '报修',
};

const LEVEL_BADGE: Record<TrustLevel, { cls: string; text: string }> = {
  trusted: { cls: 'ok', text: '可信' },
  suspect: { cls: 'minor', text: '存疑' },
  drift: { cls: 'bad', text: '漂移' },
};

const ANOMALY_LABEL: Record<LocationAnomaly['kind'], string> = {
  independent_doubt: '独立疑点',
  trip_anomaly: '行程异常',
  repair_link: '报修联动',
};

const REVIEW_STATUS: Record<ReviewItem['status'], string> = {
  queued: '待复核',
  in_review: '复核中',
  resolved: '已确认处理',
  rejected: '已驳回',
};

export default function LocationPage() {
  const {
    loaded,
    alerts,
    locationEvidence,
    locationTrusts,
    driftSegments,
    locationAnomalies,
    reviewItems,
    resolveReview,
  } = useApp();
  const [tab, setTab] = useState<'trust' | 'segment' | 'anomaly' | 'review'>('trust');
  const [comment, setComment] = useState<Record<string, string>>({});

  const evidenceById = useMemo(
    () => new Map(locationEvidence.map((e) => [e.id, e])),
    [locationEvidence],
  );
  const trustById = useMemo(
    () => new Map(locationTrusts.map((t) => [t.evidenceId, t])),
    [locationTrusts],
  );

  const geoAlerts = useMemo(() => alerts.filter((a) => a.kind === 'geo_breach'), [alerts]);
  const downweightedCount = geoAlerts.filter((a) => a.geoAdjustment?.downweighted).length;

  const gpsRows = useMemo(
    () =>
      locationEvidence
        .filter((e) => e.kind === 'gps')
        .map((e) => ({ ev: e, trust: trustById.get(e.id) }))
        .filter((x): x is { ev: LocationEvidence; trust: LocationTrust } => !!x.trust),
    [locationEvidence, trustById],
  );

  if (!loaded) {
    return <div className="card">请先在「装载器与签名」页装载场景并运行核验。</div>;
  }

  const noData = locationEvidence.length === 0;

  const setC = (id: string, v: string) => setComment((p) => ({ ...p, [id]: v }));

  return (
    <div>
      <div className="card">
        <h2>⑩ 定位可信度与漂移复核：多源证据交叉匹配，原坐标保留、按证据调整定位风险</h2>
        <p className="muted small">
          对 GPS 轨迹逐点评估可信度（精度/连续速度/瞬时跳变/围栏/照片/扫码/报修/轨迹密度八类因子），
          切分连续漂移段并按 <strong>C1–C4 明确校验条件</strong>决定区间位置校正；
          不满足条件的范围标记为<strong>不可校正</strong>并保留原因。由定位单独触发的越界告警，
          仅在多源证据印证人员未离开片区时降权，原始坐标、原严重度与调整依据全程留痕，所有结论进入复核队列。
        </p>
        {noData && (
          <div className="banner warn">
            尚未生成定位分析产物，请先到「时序核验器」运行双路线核验（定位可信度随管线一并计算）。
          </div>
        )}
        <div className="kpi-grid">
          <div className="kpi">
            <div className="num">{locationEvidence.length}</div>
            <div className="label">多源定位证据</div>
          </div>
          <div className="kpi">
            <div className="num">{gpsRows.filter((r) => r.trust.level === 'drift').length}</div>
            <div className="label">判漂移 GPS 点</div>
          </div>
          <div className="kpi">
            <div className="num">{driftSegments.filter((s) => s.status === 'corrected').length}</div>
            <div className="label">已区间校正漂移段</div>
          </div>
          <div className="kpi">
            <div className="num">{driftSegments.filter((s) => s.status === 'uncorrectable').length}</div>
            <div className="label">不可校正范围</div>
          </div>
          <div className="kpi">
            <div className="num">{locationAnomalies.length}</div>
            <div className="label">独立疑点/行程/报修异常</div>
          </div>
          <div className="kpi">
            <div className="num">{downweightedCount}/{geoAlerts.length}</div>
            <div className="label">越界告警降权/总数</div>
          </div>
          <div className="kpi">
            <div className="num">{reviewItems.filter((r) => r.status === 'queued').length}</div>
            <div className="label">待复核队列条目</div>
          </div>
        </div>
        <div className="tabs" style={{ marginTop: 14 }}>
          {(
            [
              ['trust', `逐点可信度（${gpsRows.length}）`],
              ['segment', `漂移段与校正（${driftSegments.length}）`],
              ['anomaly', `异常联动（${locationAnomalies.length}）`],
              ['review', `复核队列（${reviewItems.length}）`],
            ] as const
          ).map(([k, label]) => (
            <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ---------------- 逐点可信度 ---------------- */}
      {tab === 'trust' && (
        <div className="card">
          <h2>逐点可信度评估（原始 GPS 坐标保留，不回写原始记录）</h2>
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>来源</th>
                <th>原始 WGS84 坐标</th>
                <th>精度</th>
                <th>片区</th>
                <th>跳变/速度</th>
                <th>评分</th>
                <th>结论</th>
                <th>评分因子（交叉匹配）</th>
              </tr>
            </thead>
            <tbody>
              {gpsRows.map(({ ev, trust }) => (
                <tr key={ev.id}>
                  <td>{hm(ev.at)}</td>
                  <td className="mono small">{ev.ref}</td>
                  <td className="mono small">
                    {ev.location.lng.toFixed(4)}, {ev.location.lat.toFixed(4)}
                  </td>
                  <td>{ev.accuracyM ? `${ev.accuracyM}m` : '—'}</td>
                  <td>{ev.sectorId ?? <span className="diff-del">围栏外</span>}</td>
                  <td className="small">
                    {trust.jumpM != null ? `${trust.jumpM}m` : '—'}
                    <br />
                    {trust.speedKmh != null ? `${trust.speedKmh} km/h` : '—'}
                  </td>
                  <td>
                    <strong>{trust.score}</strong>
                  </td>
                  <td>
                    <span className={`badge ${LEVEL_BADGE[trust.level].cls}`}>
                      {LEVEL_BADGE[trust.level].text}
                    </span>
                  </td>
                  <td className="small">
                    <ul className="tight">
                      {trust.factors.map((f, i) => (
                        <li key={i} className={f.delta < 0 ? 'diff-del' : 'diff-add'}>
                          {f.note}（{f.delta >= 0 ? '+' : ''}
                          {f.delta}）
                        </li>
                      ))}
                    </ul>
                    {trust.matchedEvidenceIds.length > 0 && (
                      <div className="small">
                        交叉印证：
                        {trust.matchedEvidenceIds
                          .map((id) => `${KIND_LABEL[evidenceById.get(id)!.kind]}${evidenceById.get(id)!.ref}`)
                          .join('、')}
                      </div>
                    )}
                    {trust.contradictEvidenceIds.length > 0 && (
                      <div className="small diff-del">
                        矛盾证据：
                        {trust.contradictEvidenceIds
                          .map((id) => `${KIND_LABEL[evidenceById.get(id)!.kind]}${evidenceById.get(id)!.ref}`)
                          .join('、')}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---------------- 漂移段与校正 ---------------- */}
      {tab === 'segment' && (
        <>
          {driftSegments.map((seg) => (
            <SegmentCard
              key={seg.id}
              seg={seg}
              evidenceById={evidenceById}
            />
          ))}
        </>
      )}

      {/* ---------------- 异常联动 ---------------- */}
      {tab === 'anomaly' && (
        <div className="card">
          <h2>独立疑点 / 行程异常 / 设备报修联动</h2>
          <table>
            <thead>
              <tr>
                <th>类型</th>
                <th>异常</th>
                <th>时间</th>
                <th>关联漂移段</th>
                <th>证据链</th>
                <th>判定说明</th>
              </tr>
            </thead>
            <tbody>
              {locationAnomalies.map((anm) => (
                <tr key={anm.id}>
                  <td><span className="tag">{ANOMALY_LABEL[anm.kind]}</span></td>
                  <td className="small">{anm.title}</td>
                  <td>{hm(anm.at)}</td>
                  <td className="mono small">{anm.driftSegmentId ?? '—'}</td>
                  <td className="small">
                    {anm.evidenceIds.map((id) => {
                      const e = evidenceById.get(id);
                      return e ? (
                        <span key={id} className="tag">
                          {KIND_LABEL[e.kind]}
                          {e.ref}
                        </span>
                      ) : null;
                    })}
                  </td>
                  <td className="small">{anm.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---------------- 复核队列 ---------------- */}
      {tab === 'review' && (
        <div className="card">
          <h2>复核队列：定位降权、漂移段与异常统一人工复核（保留处理结论）</h2>
          <table>
            <thead>
              <tr>
                <th>复核单</th>
                <th>类别</th>
                <th>事项</th>
                <th>严重度</th>
                <th>状态</th>
                <th>依据 / 结论</th>
                <th>处理</th>
              </tr>
            </thead>
            <tbody>
              {reviewItems.map((r) => (
                <tr key={r.id}>
                  <td className="mono small">{r.id}</td>
                  <td>
                    <span className="tag">
                      {r.category === 'geo_alert'
                        ? '越界告警'
                        : r.category === 'drift_segment'
                          ? '漂移段'
                          : '异常'}
                    </span>
                  </td>
                  <td className="small">{r.title}</td>
                  <td><SeverityBadge value={r.severity} /></td>
                  <td>
                    <span className={`badge ${r.status === 'queued' ? 'bad' : r.status === 'rejected' ? 'minor' : 'ok'}`}>
                      {REVIEW_STATUS[r.status]}
                    </span>
                    {r.resolvedBy && (
                      <div className="small muted">
                        {r.resolvedBy} · {r.resolvedAt ? hm(r.resolvedAt) : ''}
                      </div>
                    )}
                  </td>
                  <td className="small">
                    {r.resolution ?? r.reason}
                    <div className="muted" style={{ marginTop: 4 }}>
                      证据签名：{r.evidenceRefs.map((s) => short(s, 8)).join('、')}
                    </div>
                  </td>
                  <td>
                    {r.status === 'queued' || r.status === 'in_review' ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 220 }}>
                        <input
                          className="review-input"
                          placeholder="复核意见（必填）"
                          value={comment[r.id] ?? ''}
                          onChange={(e) => setC(r.id, e.target.value)}
                        />
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            className="primary tiny"
                            disabled={!(comment[r.id] ?? '').trim()}
                            onClick={() => resolveReview(r.id, 'resolved', (comment[r.id] ?? '').trim())}
                          >
                            确认
                          </button>
                          <button
                            className="danger tiny"
                            disabled={!(comment[r.id] ?? '').trim()}
                            onClick={() => resolveReview(r.id, 'rejected', (comment[r.id] ?? '').trim())}
                          >
                            驳回
                          </button>
                        </div>
                      </div>
                    ) : (
                      <span className="small muted">已闭环</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SegmentCard({
  seg,
  evidenceById,
}: {
  seg: DriftSegment;
  evidenceById: Map<string, LocationEvidence>;
}) {
  const corrected = seg.status === 'corrected';
  return (
    <div className="card" key={seg.id}>
      <h2>
        漂移段 <span className="mono">{seg.id}</span>
        <span className={`badge ${corrected ? 'ok' : 'bad'}`} style={{ marginLeft: 10 }}>
          {corrected ? `已校正为区间位置 → ${seg.correctedSectorId}` : '不可校正范围'}
        </span>
      </h2>
      <div className="grid-3">
        <div className="small">
          <div className="muted">时间窗</div>
          {hm(seg.startAt)}–{hm(seg.endAt)}（{seg.evidenceIds.length} 个漂移 GPS 点）
        </div>
        <div className="small">
          <div className="muted">最大跳变 / 连续速度</div>
          {seg.maxJumpM} m · {seg.maxSpeedKmh} km/h
        </div>
        <div className="small">
          <div className="muted">两侧锚点片区</div>
          入口 {seg.entrySectorId ?? '无'} → 出口 {seg.exitSectorId ?? '无'}
        </div>
      </div>

      <h3>段内 GPS 原始坐标（保留不回写）</h3>
      <table>
        <thead>
          <tr>
            <th>时间</th>
            <th>原始坐标</th>
            <th>所在片区</th>
            <th>证据引用</th>
          </tr>
        </thead>
        <tbody>
          {seg.evidenceIds.map((id) => {
            const e = evidenceById.get(id);
            if (!e) return null;
            return (
              <tr key={id}>
                <td>{hm(e.at)}</td>
                <td className="mono small">
                  {e.location.lng.toFixed(4)}, {e.location.lat.toFixed(4)}
                </td>
                <td>{e.sectorId ?? <span className="diff-del">围栏外（越界）</span>}</td>
                <td className="small muted">{short(e.signature, 12)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {corrected ? (
        <>
          <h3>校正依据（C1–C4 全部满足，落点为片区锚点区间位置）</h3>
          <ul className="tight small">
            {seg.correctionBasis.map((b, i) => (
              <li key={i} className="diff-add">{b}</li>
            ))}
          </ul>
          <div className="small">
            校正落点：
            <span className="mono">
              {seg.correctedLocation?.lng.toFixed(4)}, {seg.correctedLocation?.lat.toFixed(4)}
            </span>
            （片区 {seg.correctedSectorId} 锚点，仅作为区间位置展示，不替换原始 GPS）
          </div>
          <div className="small" style={{ marginTop: 6 }}>
            支持证据：
            {seg.supportingEvidenceIds.map((id) => {
              const e = evidenceById.get(id)!;
              return (
                <span key={id} className="tag">
                  {KIND_LABEL[e.kind]}
                  {e.ref}
                </span>
              );
            })}
          </div>
        </>
      ) : (
        <>
          <h3>不能校正的范围与原因</h3>
          <div className="banner bad">{seg.uncorrectableReason}</div>
          <ul className="tight small">
            {seg.correctionBasis.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
          <div className="small">
            矛盾证据（阻碍自动校正）：
            {seg.contradictEvidenceIds.map((id) => {
              const e = evidenceById.get(id)!;
              return (
                <span key={id} className="tag">
                  {KIND_LABEL[e.kind]}
                  {e.ref}→{e.sourceSectorId ?? e.sectorId}
                </span>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
