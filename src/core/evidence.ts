// ============================================================
// 证据图：连接观测、台账、施工、回执、告警与聚合事件。
// 任一聚合事件都能沿边回溯到原始签名记录，满足“证据链”要求。
// ============================================================

import type {
  Alert,
  CompressionEvent,
  ConstructionZone,
  DeviceLedger,
  DriftSegment,
  EvidenceEdge,
  EvidenceNode,
  LocationAnomaly,
  LocationEvidence,
  PatrolSector,
  RawRecord,
  Rectification,
  ReviewItem,
} from './types';

export interface EvidenceGraph {
  nodes: EvidenceNode[];
  edges: EvidenceEdge[];
}

const EVIDENCE_LABEL: Record<LocationEvidence['kind'], string> = {
  gps: 'GPS',
  photo: '照片',
  scan: '扫码',
  repair: '报修',
};

export function buildEvidenceGraph(input: {
  raw: RawRecord[];
  ledger: DeviceLedger[];
  zones: ConstructionZone[];
  sectors?: PatrolSector[];
  rectifications: Rectification[];
  alerts: Alert[];
  events: CompressionEvent[];
  membershipAlertIds: Set<string>; // 实际属于事件的告警（两路线并集）
  locationEvidence?: LocationEvidence[];
  driftSegments?: DriftSegment[];
  locationAnomalies?: LocationAnomaly[];
  reviewItems?: ReviewItem[];
}): EvidenceGraph {
  const nodes: EvidenceNode[] = [];
  const edges: EvidenceEdge[] = [];
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();

  const addNode = (n: EvidenceNode) => {
    if (!nodeIds.has(n.id)) {
      nodeIds.add(n.id);
      nodes.push(n);
    }
  };
  const addEdge = (from: string, to: string, relation: EvidenceEdge['relation']) => {
    const id = `${from}->${relation}->${to}`;
    if (!edgeIds.has(id)) {
      edgeIds.add(id);
      edges.push({ id, from, to, relation });
    }
  };

  const rawBySignature = new Map(input.raw.map((r) => [r.signature, r]));

  for (const d of input.ledger) {
    addNode({ id: `ledger:${d.deviceId}`, type: 'ledger', label: d.deviceId, sub: d.name });
  }
  for (const z of input.zones) {
    addNode({ id: `zone:${z.id}`, type: 'construction', label: z.id, sub: z.name });
    for (const dev of z.affectedDevices) addEdge(`zone:${z.id}`, `ledger:${dev}`, 'in_zone');
  }
  for (const rc of input.rectifications) {
    addNode({
      id: `rc:${rc.id}`,
      type: 'rectification',
      label: rc.id,
      sub: `${rc.status} / 截止 ${rc.dueAt.slice(11, 16)}`,
    });
    addEdge(`rc:${rc.id}`, `ledger:${rc.deviceId}`, 'about_device');
  }

  for (const a of input.alerts) {
    addNode({
      id: `alert:${a.id}`,
      type: 'alert',
      label: `${a.ruleId}`,
      sub: `${a.deviceId} @ ${a.observedAt.slice(11, 16)} · ${a.severity}`,
    });
    addEdge(`alert:${a.id}`, `ledger:${a.deviceId}`, 'about_device');
    if (a.context.constructionId) {
      addEdge(`alert:${a.id}`, `zone:${a.context.constructionId}`, 'in_zone');
    }
    for (const sig of a.evidenceRefs) {
      const rawRec = rawBySignature.get(sig);
      if (!rawRec) continue;
      const oid = `raw:${rawRec.id}`;
      addNode({
        id: oid,
        type: 'observation',
        label: rawRec.sourceId,
        sub: `${rawRec.kind} · 采样 ${rawRec.sampledAt.slice(11, 16)}`,
      });
      addEdge(`alert:${a.id}`, oid, 'derived_from');
      addEdge(oid, `ledger:${a.deviceId}`, 'about_device');
    }
    // 回执关联：有上游 ID 直接关联，缺失时按设备+时间窗做证据关联
    const linked = input.rectifications.find(
      (rc) =>
        (rc.alertSourceId &&
          rawBySignature.get(a.evidenceRefs[0])?.sourceId?.includes(rc.alertSourceId)) ||
        (rc.deviceId === a.deviceId &&
          new Date(rc.dueAt).getTime() >= new Date(a.windowStart).getTime() - 3600_000 &&
          new Date(rc.dueAt).getTime() <= new Date(a.windowEnd).getTime() + 3600_000),
    );
    if (linked) addEdge(`alert:${a.id}`, `rc:${linked.id}`, 'responded_by');
    if (a.kind === 'contradiction') addEdge(`alert:${a.id}`, `ledger:${a.deviceId}`, 'contradicts');
  }

  for (const ev of input.events) {
    addNode({
      id: `event:${ev.id}`,
      type: 'event',
      label: ev.route === 'A' ? '事件 A' : '事件 B',
      sub: `${ev.title} · ${ev.severity}`,
    });
    const memberIds =
      ev.route === 'A'
        ? (ev.memberships ?? []).map((m) => m.alertId)
        : (ev.witness?.alertRefs ?? []);
    for (const alertId of memberIds) {
      addEdge(`event:${ev.id}`, `alert:${alertId}`, 'member_of');
    }
    if (ev.parentEventId) addEdge(`event:${ev.id}`, `event:${ev.parentEventId}`, 'derived_from');
  }

  // ---------------- 定位可信度子系统：证据 / 漂移段 / 复核队列 ----------------
  const locEvidence = input.locationEvidence ?? [];
  const locById = new Map(locEvidence.map((e) => [e.id, e]));
  for (const le of locEvidence) {
    addNode({
      id: `loc:${le.id}`,
      type: 'location',
      label: `${EVIDENCE_LABEL[le.kind]} ${le.ref}`,
      sub: `${le.at.slice(11, 16)} · 片区 ${le.sectorId ?? '围栏外'}`,
    });
    if (le.deviceId) addEdge(`loc:${le.id}`, `ledger:${le.deviceId}`, 'about_device');
    if (le.sectorId) addEdge(`loc:${le.id}`, `sector:${le.sectorId}`, 'located_in');
  }
  for (const sector of input.sectors ?? []) {
    addNode({
      id: `sector:${sector.id}`,
      type: 'construction',
      label: sector.id,
      sub: sector.name,
    });
  }

  for (const seg of input.driftSegments ?? []) {
    addNode({
      id: `drift:${seg.id}`,
      type: 'drift',
      label: seg.id,
      sub: `${seg.startAt.slice(11, 16)}–${seg.endAt.slice(11, 16)} · ${
        seg.status === 'corrected' ? `已校正→${seg.correctedSectorId}` : '不可校正'
      }`,
    });
    for (const evId of seg.evidenceIds) {
      addEdge(`drift:${seg.id}`, `loc:${evId}`, 'derived_from');
    }
    for (const evId of seg.supportingEvidenceIds) {
      addEdge(`drift:${seg.id}`, `loc:${evId}`, 'located_in');
    }
    for (const evId of seg.contradictEvidenceIds) {
      addEdge(`drift:${seg.id}`, `loc:${evId}`, 'contradicts');
    }
    if (seg.correctedSectorId) {
      addEdge(`drift:${seg.id}`, `sector:${seg.correctedSectorId}`, 'corrected_to');
    }
  }

  for (const review of input.reviewItems ?? []) {
    addNode({
      id: `review:${review.id}`,
      type: 'review',
      label: review.id,
      sub: `${review.category} · ${review.status}`,
    });
    if (review.category === 'geo_alert') addEdge(`review:${review.id}`, `alert:${review.refId}`, 'queued_as');
    if (review.category === 'drift_segment') addEdge(`review:${review.id}`, `drift:${review.refId}`, 'queued_as');
    if (review.category === 'anomaly') {
      const anm = input.locationAnomalies?.find((x) => x.id === review.refId);
      for (const evId of anm?.evidenceIds ?? []) {
        if (locById.has(evId)) addEdge(`review:${review.id}`, `loc:${evId}`, 'derived_from');
      }
    }
  }

  return { nodes, edges };
}

/** 从事件出发的可达证据子图（调查页使用） */
export function subgraphFrom(graph: EvidenceGraph, startNodeId: string): EvidenceGraph {
  const keep = new Set<string>([startNodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of graph.edges) {
      if (keep.has(e.from) && !keep.has(e.to)) {
        keep.add(e.to);
        changed = true;
      }
    }
  }
  return {
    nodes: graph.nodes.filter((n) => keep.has(n.id)),
    edges: graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
  };
}
