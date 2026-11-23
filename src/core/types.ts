// ============================================================
// 领域类型定义：装载器 / 对齐器 / 规则 / 核验 / 证据图 / 处置 / 同步
// ============================================================

export type RecordKind =
  | 'trajectory' // 巡检轨迹
  | 'valve_reading' // 阀井读数
  | 'ledger' // 设备台账
  | 'construction' // 施工清单
  | 'rectification' // 整改回执
  | 'photo' // 现场照片（带拍摄定位）
  | 'scan' // 点位扫码记录
  | 'repair'; // 设备报修单

export type Confidence = 'high' | 'medium' | 'low';
export type Severity = 'info' | 'minor' | 'major' | 'critical';
export type RuleKind = 'missing' | 'jump' | 'contradiction' | 'overdue' | 'geo_breach';
export type AlertStatus = 'open' | 'actioned' | 'closed';
export type CompressionRoute = 'A' | 'B';
export type SyncState = 'local' | 'synced' | 'conflict';
export type UserRole = 'supervisor' | 'inspector' | 'auditor';

// ---------------- 装载器：原始记录 ----------------
export interface RawRecord {
  id: string; // 装载器分配的本地 ID
  sourceId: string; // 上游系统原始 ID
  kind: RecordKind;
  payload: Record<string, unknown>;
  sampledAt: string; // 采样时间
  arrivedAt: string; // 到达时间
  confidence: Confidence;
  signature: string; // 内容哈希签名（装载时计算并固化）
  batchId: string;
  backfilled: boolean; // 离线补传
}

// ============================================================
// 定位可信度子系统：
// 巡检片区 -> 多源定位证据（GPS 轨迹/照片/扫码/报修）-> 逐点可信度
// -> 漂移段切分 -> 区间位置校正（保留依据与不可校正范围）
// -> 独立疑点/行程异常/报修联动 -> 定位单独触发告警的降权与复核队列。
// 原始 GPS 坐标全程保留，任何调整都不回写原始记录。
// ============================================================

/** 巡检片区（人员应在的指定片区，含设备与地理围栏） */
export interface PatrolSector {
  id: string;
  name: string;
  bbox: { lngMin: number; lngMax: number; latMin: number; latMax: number };
  anchorLocation: { lng: number; lat: number }; // 片区锚点（签到点/中心）
  deviceIds: string[]; // 片区内设备
}

export type LocationEvidenceKind = 'gps' | 'photo' | 'scan' | 'repair';

/** 多源定位证据：统一封装轨迹点、照片定位、扫码点位与报修点位 */
export interface LocationEvidence {
  id: string;
  rawId: string; // 对应 RawRecord.id
  signature: string; // 对应 RawRecord.signature，证据链可回溯
  kind: LocationEvidenceKind;
  inspector: string;
  at: string; // 业务时间（采样/拍摄/扫码/报修时间）
  location: { lng: number; lat: number }; // WGS84
  sectorId: string | null; // 坐标所在片区（地理围栏判定）
  sourceSectorId: string | null; // 业务来源片区：扫码/报修绑定的片区（可能与坐标片区冲突）
  deviceId: string | null;
  ref: string; // 照片号 / 扫码点编号 / 报修单号等展示引用
  accuracyM?: number; // GPS 标称精度（米），越小越可信
}

/** 单个可信度评分因子（解释性，可在页面逐项列出） */
export interface TrustFactor {
  code:
    | 'accuracy' // GPS 标称精度
    | 'speed' // 与上一点的连续速度是否越过可达上限
    | 'jump' // 坐标瞬时跳变距离
    | 'fence' // 是否落在指定片区围栏内
    | 'photo_confirm' // 同时段照片定位一致
    | 'scan_confirm' // 同时段扫码片区一致
    | 'repair_confirm' // 同时段报修点位一致
    | 'trajectory_density'; // 邻近轨迹点密度（孤点降可信）
  delta: number; // 分值增减（可为负）
  note: string;
}

export type TrustLevel = 'trusted' | 'suspect' | 'drift';

/** 逐定位点可信度评估结果（原始坐标保留在 LocationEvidence.location） */
export interface LocationTrust {
  evidenceId: string;
  score: number; // 0-100
  level: TrustLevel;
  factors: TrustFactor[];
  matchedEvidenceIds: string[]; // 交叉匹配命中的照片/扫码/报修证据
  contradictEvidenceIds: string[]; // 与 GPS 位置矛盾的证据（如照片在漂移段外）
  speedKmh: number | null; // 相对上一 GPS 点的连续速度
  jumpM: number | null; // 相对上一 GPS 点的跳变距离（米）
}

export type CorrectionStatus =
  | 'none' // 未校正（可信点或不满足明确校验条件）
  | 'corrected' // 已按明确校验条件校正为区间位置
  | 'uncorrectable'; // 漂移且存在矛盾证据，禁止校正，必须人工复核

/** 漂移段：连续低可信 GPS 点切分，含区间位置校正结论与依据 */
export interface DriftSegment {
  id: string;
  evidenceIds: string[]; // 段内 GPS 证据（按时间）
  startAt: string;
  endAt: string;
  entryLocation: { lng: number; lat: number }; // 漂移前最后一个可信点
  exitLocation: { lng: number; lat: number }; // 漂移后第一个可信点
  entrySectorId: string | null;
  exitSectorId: string | null;
  maxJumpM: number;
  maxSpeedKmh: number;
  status: CorrectionStatus;
  /** 校正为区间位置时的落点（entry/exit 同片区时为该片区锚点） */
  correctedLocation: { lng: number; lat: number } | null;
  correctedSectorId: string | null;
  /** 校正依据：满足的明确校验条件（逐条可审计） */
  correctionBasis: string[];
  /** 不能校正的范围/原因（status=uncorrectable 时必填） */
  uncorrectableReason: string | null;
  supportingEvidenceIds: string[]; // 支持校正/判定的照片/扫码/报修证据
  contradictEvidenceIds: string[]; // 阻碍校正的矛盾证据
}

export type LocationAnomalyKind =
  | 'independent_doubt' // 独立疑点：照片落在漂移段外
  | 'trip_anomaly' // 行程异常：连续速度越过可达上限
  | 'repair_link'; // 设备报修联动：扫码属另一片区且与报修单相互印证

export type AnomalyVerdict = 'open' | 'confirmed' | 'dismissed';

/** 定位异常：独立疑点 / 行程异常 / 报修联动 */
export interface LocationAnomaly {
  id: string;
  kind: LocationAnomalyKind;
  title: string;
  at: string;
  sectorId: string | null;
  deviceId: string | null;
  evidenceIds: string[]; // 关联证据（含签名回溯）
  driftSegmentId: string | null;
  detail: string;
  verdict: AnomalyVerdict;
  severityScore: number;
}

/** 告警的定位调整（仅作用于“由定位单独触发”的 geo_breach 告警） */
export interface AlertGeoAdjustment {
  originalSeverity: Severity; // 调整前严重度（原始判定保留）
  adjustedSeverity: Severity; // 降权后严重度
  trustLevel: TrustLevel;
  driftSegmentId: string | null;
  correctedLocation: { lng: number; lat: number } | null;
  basis: string[]; // 降权/调整依据（多源证据条目）
  downweighted: boolean; // 是否实际降权
  reviewItemId: string;
}

/** 复核队列条目：定位降权、漂移段、异常统一进入人工复核 */
export interface ReviewItem {
  id: string;
  createdAt: string;
  category: 'geo_alert' | 'drift_segment' | 'anomaly';
  refId: string; // Alert.id / DriftSegment.id / LocationAnomaly.id
  title: string;
  reason: string;
  severity: Severity;
  status: 'queued' | 'in_review' | 'resolved' | 'rejected';
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  evidenceRefs: string[]; // 签名列表
}

// ---------------- 台账 / 施工 / 回执 ----------------
export interface DeviceLedger {
  deviceId: string;
  name: string;
  aliases: string[];
  deviceType: 'valve_well' | 'pressure_sensor' | 'flow_sensor';
  standardUnit: string;
  rangeMin: number;
  rangeMax: number;
  warnThreshold: number;
  highThreshold: number;
  expectedIntervalMin: number; // 期望采样间隔（缺测判定）
  location: { lng: number; lat: number };
  declaredStatus: 'open' | 'closed' | 'fault';
  ledgerVersion: string;
}

export interface ConstructionZone {
  id: string;
  name: string;
  bbox: { lngMin: number; lngMax: number; latMin: number; latMax: number };
  affectedDevices: string[];
  startAt: string;
  endAt: string;
  graceIntervalMin: number; // 施工扰动宽限间隔
  suppressKinds: RuleKind[]; // 施工期间抑制的规则类型
}

export interface Rectification {
  id: string;
  alertSourceId: string | null; // 关联的上游告警 ID（可能缺失）
  deviceId: string;
  dueAt: string;
  closedAt: string | null;
  status: 'pending' | 'done' | 'rejected';
  note: string;
  arrivedAt: string;
}

// ---------------- 语义对齐 ----------------
export interface SemanticMapping {
  version: string;
  aliasMap: Record<string, string>; // 源别名 -> 规范 deviceId
  unitConversions: Record<string, { factor: number; offset: number }>; // 源单位 -> 标准单位
  coordSystem: 'WGS84' | 'GCJ02' | 'BD09';
  coordOffset: { dLng: number; dLat: number }; // 相对于 WGS84 的修正偏移
  updatedAt: string;
}

export interface CanonicalObservation {
  id: string;
  deviceId: string;
  value: number; // 已换算为标准单位
  sourceUnit: string;
  status: 'open' | 'closed' | 'fault';
  sampledAt: string;
  arrivedAt: string;
  confidence: Confidence;
  rawId: string;
  rawSignature: string;
  backfilled: boolean;
  networkDrift: boolean; // 到达延迟/乱序
  inConstruction: boolean;
  constructionId: string | null;
  location: { lng: number; lat: number };
}

// ---------------- 规则版本管理 ----------------
export interface RuleDef {
  id: string;
  kind: RuleKind;
  name: string;
  enabled: boolean;
  params: {
    missingGapMin?: number;
    jumpRangeRatio?: number; // 跳变幅度占量程比例
    contradictionTol?: number; // 状态/读数矛盾容忍
    overdueMin?: number; // 逾期宽限分钟
    geoJumpM?: number; // 定位瞬时跳变距离阈值（米）
    geoSpeedLimitKmh?: number; // 连续行程可达速度上限（km/h）
    geoTrustFloor?: number; // 定位可信度降权门限（低于该分数的定位单独告警降权）
  };
  baseSeverity: Severity;
  constructionGrace: boolean;
}

export interface RuleVersion {
  id: string;
  publishedAt: string;
  active: boolean;
  changelog: string;
  rules: RuleDef[];
}

// ---------------- 告警（压缩成员） ----------------
export interface AlertContribution {
  severityScore: number; // 0-100
  rationale: string; // 逐成员贡献说明
  recommendation: string; // 该成员对处置建议的贡献
}

export interface Alert {
  id: string; // 内容寻址：sha256(canonical 业务字段)
  ruleId: string;
  ruleVersionId: string;
  ledgerVersion: string;
  mappingVersion: string;
  deviceId: string;
  kind: RuleKind;
  severity: Severity;
  observedAt: string;
  windowStart: string;
  windowEnd: string;
  evidenceRefs: string[]; // RawRecord.signature 列表
  detail: string;
  recommendation: string;
  contribution: AlertContribution;
  context: {
    inConstruction: boolean;
    constructionId: string | null;
    networkDrift: boolean;
    backfilled: boolean;
  };
  /** 定位单独触发告警的多源证据调整（降权/校正引用），不改变原始坐标与原严重度留痕 */
  geoAdjustment?: AlertGeoAdjustment;
}

// ---------------- 压缩事件 ----------------
export interface MembershipRecord {
  eventId: string;
  alertId: string;
  immutable: true;
  severityContribution: number;
  recommendationContribution: string;
  ruleVersionId: string;
  ledgerVersion: string;
  createdAt: string;
}

export interface CompressedWitness {
  deviceId: string;
  ruleId: string;
  ruleVersionId: string;
  ledgerVersion: string;
  windowStart: string;
  windowEnd: string;
  windowSlotMinutes: number;
  memberSlots: number[]; // 连续时间窗槽位编码
  alertRefs: string[]; // 内容寻址的原始告警引用
  severityScores: number[]; // 逐成员严重度分
  rationaleCodes: number[]; // 贡献说明字典码
  witnessHash: string;
  boundary: {
    prevSlotAlertId: string | null;
    nextSlotAlertId: string | null;
    passed: boolean;
    verifiedAt: string | null;
    note: string;
  };
}

export interface CompressionEvent {
  id: string;
  route: CompressionRoute;
  deviceId: string;
  ruleId: string;
  ruleVersionId: string;
  ledgerVersion: string;
  windowStart: string;
  windowEnd: string;
  severity: Severity;
  title: string;
  memberCount: number;
  status: AlertStatus;
  createdAt: string;
  memberships?: MembershipRecord[]; // 路线 A
  witness?: CompressedWitness; // 路线 B
  parentEventId: string | null; // 规则换版局部重算链
}

// ---------------- 证据图 ----------------
export type EvidenceNodeType =
  | 'observation'
  | 'ledger'
  | 'construction'
  | 'rectification'
  | 'alert'
  | 'event'
  | 'location' // 多源定位证据（GPS/照片/扫码/报修）
  | 'drift' // 漂移段
  | 'review'; // 复核队列条目

export interface EvidenceNode {
  id: string;
  type: EvidenceNodeType;
  label: string;
  sub: string;
}

export type EvidenceRelation =
  | 'derived_from'
  | 'about_device'
  | 'in_zone'
  | 'responded_by'
  | 'member_of'
  | 'contradicts'
  | 'located_in' // 定位证据 -> 片区/设备
  | 'corrected_to' // 漂移段 -> 校正落点（锚点证据）
  | 'queued_as'; // 告警/漂移段/异常 -> 复核条目

export interface EvidenceEdge {
  id: string;
  from: string;
  to: string;
  relation: EvidenceRelation;
}

// ---------------- 处置簿 ----------------
export interface DisposalAction {
  id: string;
  eventId: string;
  deviceId: string;
  actor: string;
  role: UserRole;
  action: 'ack' | 'assign' | 'close' | 'annotate' | 'reopen';
  comment: string;
  at: string;
  baseVersion: number;
  syncState: SyncState;
}

// ---------------- 同步对照 ----------------
export interface SyncConflict {
  id: string;
  entityType: 'action' | 'event_status' | 'rectification';
  entityId: string;
  local: string;
  remote: string;
  resolution: 'pending' | 'keep_local' | 'take_remote' | 'merge';
}

export interface RouteStat {
  payloadBytes: number;
  membershipCount: number;
  witnessCount: number;
  indexCount: number;
}

export interface EquivalenceCheck {
  eventKey: string;
  sameMembers: boolean;
  sameSeverity: boolean;
  sameContributions: boolean;
  memberCountA: number;
  memberCountB: number;
  decodeMsB: number;
  missingBoundary: boolean;
}

export interface SyncReport {
  id: string;
  generatedAt: string;
  localRev: number;
  remoteRev: number;
  routeStats: Record<CompressionRoute, RouteStat>;
  conflicts: SyncConflict[];
  equivalence: EquivalenceCheck[];
}

// ---------------- 场景 ----------------
export interface ScenarioPhase {
  id: string;
  name: string;
  startAt: string;
  endAt: string;
  activeRuleVersionId: string;
  note: string;
}

export interface ScenarioManifest {
  id: string;
  name: string;
  description: string;
  ledgerVersion: string;
  mappingVersion: string;
  initialRuleVersionId: string;
  targetRuleVersionId: string;
  phases: ScenarioPhase[];
}

// ---------------- Worker 消息 ----------------
export interface VerifyRequest {
  type: 'verify';
  batchId: string;
  route: CompressionRoute | 'both';
  ruleVersionId: string;
}

export interface VerifyProgress {
  phase: string;
  done: number;
  total: number;
}

export interface VerifyResponse {
  type: 'verify_result';
  batchId: string;
  alertCount: number;
  eventCount: number;
  route: CompressionRoute | 'both';
  elapsedMs: number;
  decodeMs: number;
  report: SyncReport | null;
}
