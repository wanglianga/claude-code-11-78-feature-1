// ============================================================
// 仓储层：把核验产物持久化到 IndexedDB，并支持重新载入还原。
// ============================================================

import {
  STORES,
  clearStore,
  countStore,
  getAll,
  getOne,
  putMany,
  putOne,
  queryIndex,
} from './db';
import type {
  Alert,
  CompressionEvent,
  DisposalAction,
  DriftSegment,
  LocationAnomaly,
  LocationEvidence,
  LocationTrust,
  MembershipRecord,
  PatrolSector,
  RawRecord,
  ReviewItem,
  RuleVersion,
  ScenarioManifest,
  SemanticMapping,
  SyncConflict,
  SyncReport,
  ConstructionZone,
  DeviceLedger,
  Rectification,
} from './types';

const META_KEYS = { mapping: 'mapping', dict: 'contribution_dict' };

export const repository = {
  raw: () => getAll<RawRecord>(STORES.raw),
  ledger: () => getAll<DeviceLedger>(STORES.ledger),
  zones: () => getAll<ConstructionZone>(STORES.construction),
  sectors: () => getAll<PatrolSector>(STORES.sectors),
  rectifications: () => getAll<Rectification>(STORES.rectification),
  ruleVersions: () => getAll<RuleVersion>(STORES.ruleVersions),
  manifest: () => getOne<ScenarioManifest>(STORES.manifest, 'SCENARIO-2026-11-23'),
  alerts: () => getAll<Alert>(STORES.alerts),
  events: () => getAll<CompressionEvent>(STORES.events),
  memberships: () => getAll<MembershipRecord>(STORES.memberships),
  actions: () => getAll<DisposalAction>(STORES.actions),
  conflicts: () => getAll<SyncConflict>(STORES.conflicts),
  reports: () => getAll<SyncReport>(STORES.reports),
  locationEvidence: () => getAll<LocationEvidence>(STORES.locationEvidence),
  locationTrust: () => getAll<LocationTrust>(STORES.locationTrust),
  driftSegments: () => getAll<DriftSegment>(STORES.driftSegments),
  locationAnomalies: () => getAll<LocationAnomaly>(STORES.locationAnomalies),
  reviewItems: () => getAll<ReviewItem>(STORES.reviewItems),
  counts: async () =>
    Object.fromEntries(
      await Promise.all(
        Object.values(STORES).map(async (s) => [s, await countStore(s)] as const),
      ),
    ),

  saveMapping: (mapping: SemanticMapping) =>
    putOne(STORES.meta, { key: META_KEYS.mapping, value: mapping }),
  loadMapping: () =>
    getOne<{ key: string; value: SemanticMapping }>(STORES.meta, META_KEYS.mapping),
  saveDict: (values: string[]) =>
    putOne(STORES.meta, { key: META_KEYS.dict, value: values }),
  loadDict: () => getOne<{ key: string; value: string[] }>(STORES.meta, META_KEYS.dict),

  saveVerifyOutput: async (out: {
    alerts: Alert[];
    eventsA: CompressionEvent[];
    eventsB: CompressionEvent[];
    memberships: MembershipRecord[];
    dict: string[];
    report: SyncReport;
    actions: DisposalAction[];
    locationEvidence: LocationEvidence[];
    locationTrust: LocationTrust[];
    driftSegments: DriftSegment[];
    locationAnomalies: LocationAnomaly[];
    reviewItems: ReviewItem[];
  }) => {
    await Promise.all([
      putMany(STORES.alerts, out.alerts),
      putMany(STORES.events, [...out.eventsA, ...out.eventsB]),
      putMany(STORES.memberships, out.memberships),
      putMany(STORES.actions, out.actions),
      putMany(STORES.conflicts, out.report.conflicts),
      putOne(STORES.reports, out.report),
      putOne(STORES.meta, { key: META_KEYS.dict, value: out.dict }),
      putMany(STORES.locationEvidence, out.locationEvidence),
      putMany(STORES.locationTrust, out.locationTrust),
      putMany(STORES.driftSegments, out.driftSegments),
      putMany(STORES.locationAnomalies, out.locationAnomalies),
      putMany(STORES.reviewItems, out.reviewItems),
    ]);
  },

  addAction: (action: DisposalAction) => putOne(STORES.actions, action),
  saveConflicts: (rows: SyncConflict[]) => putMany(STORES.conflicts, rows),
  saveReport: (report: SyncReport) => putOne(STORES.reports, report),
  saveReviewItems: (rows: ReviewItem[]) => putMany(STORES.reviewItems, rows),
  saveLocationAnomalies: (rows: LocationAnomaly[]) => putMany(STORES.locationAnomalies, rows),
  actionsByEvent: (eventId: string) =>
    queryIndex<DisposalAction>(STORES.actions, 'by_event', eventId),

  /** 复核队列处理：更新状态、结论、处理人与时间 */
  resolveReviewItem: async (
    reviewId: string,
    resolution: Extract<ReviewItem['status'], 'resolved' | 'rejected'>,
    comment: string,
    resolvedBy: string,
    at: string,
  ) => {
    const rows = await getAll<ReviewItem>(STORES.reviewItems);
    const updated = rows.map((r) =>
      r.id === reviewId
        ? {
            ...r,
            status: resolution,
            resolution: comment,
            resolvedBy,
            resolvedAt: at,
          }
        : r,
    );
    await putMany(STORES.reviewItems, updated);
    return updated;
  },

  wipeDerived: () =>
    Promise.all(
      [
        STORES.alerts,
        STORES.events,
        STORES.memberships,
        STORES.conflicts,
        STORES.reports,
        STORES.locationEvidence,
        STORES.locationTrust,
        STORES.driftSegments,
        STORES.locationAnomalies,
        STORES.reviewItems,
      ].map(clearStore),
    ),
};
