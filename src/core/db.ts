// ============================================================
// IndexedDB 离线存储层：原始记录 / 台账 / 规则版本 / 事件 / 处置 / 同步
// 所有写操作均在本地完成，应用全程离线可用。
// ============================================================

import type {
  CompressionEvent,
  ConstructionZone,
  DeviceLedger,
  DisposalAction,
  DriftSegment,
  LocationAnomaly,
  LocationEvidence,
  LocationTrust,
  MembershipRecord,
  PatrolSector,
  RawRecord,
  Rectification,
  ReviewItem,
  RuleVersion,
  ScenarioManifest,
  SyncConflict,
  SyncReport,
} from './types';

const DB_NAME = 'gas-consistency-db';
const DB_VERSION = 2;

export const STORES = {
  raw: 'raw_records',
  ledger: 'ledger',
  construction: 'construction',
  sectors: 'patrol_sectors',
  rectification: 'rectifications',
  ruleVersions: 'rule_versions',
  manifest: 'manifests',
  alerts: 'alerts',
  events: 'events',
  memberships: 'memberships',
  actions: 'disposal_actions',
  conflicts: 'sync_conflicts',
  reports: 'sync_reports',
  locationEvidence: 'location_evidence',
  locationTrust: 'location_trust',
  driftSegments: 'drift_segments',
  locationAnomalies: 'location_anomalies',
  reviewItems: 'review_items',
  meta: 'meta',
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const make = (name: string, keyPath: string, indexes: [string, string][]) => {
        // v1 -> v2 升级时旧 store 已存在，仅补建新增 store
        if (db.objectStoreNames.contains(name)) return;
        const store = db.createObjectStore(name, { keyPath });
        for (const [idx, field] of indexes) store.createIndex(idx, field);
      };
      make(STORES.raw, 'id', [
        ['by_kind', 'kind'],
        ['by_batch', 'batchId'],
        ['by_signature', 'signature'],
      ]);
      make(STORES.ledger, 'deviceId', []);
      make(STORES.construction, 'id', []);
      make(STORES.sectors, 'id', []);
      make(STORES.rectification, 'id', [['by_device', 'deviceId']]);
      make(STORES.ruleVersions, 'id', [['by_active', 'active']]);
      make(STORES.manifest, 'id', []);
      make(STORES.alerts, 'id', [
        ['by_device', 'deviceId'],
        ['by_ruleVersion', 'ruleVersionId'],
      ]);
      make(STORES.events, 'id', [
        ['by_device', 'deviceId'],
        ['by_route', 'route'],
        ['by_ruleVersion', 'ruleVersionId'],
      ]);
      make(STORES.memberships, 'alertId', [
        ['by_event', 'eventId'],
        ['by_immutable', 'immutable'],
      ]);
      make(STORES.actions, 'id', [
        ['by_event', 'eventId'],
        ['by_sync', 'syncState'],
      ]);
      make(STORES.conflicts, 'id', [
        ['by_resolution', 'resolution'],
        ['by_entity', 'entityId'],
      ]);
      make(STORES.reports, 'id', []);
      make(STORES.locationEvidence, 'id', [
        ['by_kind', 'kind'],
        ['by_sector', 'sectorId'],
      ]);
      make(STORES.locationTrust, 'evidenceId', []);
      make(STORES.driftSegments, 'id', [['by_status', 'status']]);
      make(STORES.locationAnomalies, 'id', [
        ['by_kind', 'kind'],
        ['by_verdict', 'verdict'],
      ]);
      make(STORES.reviewItems, 'id', [
        ['by_status', 'status'],
        ['by_category', 'category'],
      ]);
      make(STORES.meta, 'key', []);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function putOne<T>(store: string, value: T): Promise<IDBValidKey> {
  return tx(store, 'readwrite', (s) => s.put(value));
}

export async function putMany<T>(store: string, values: T[]): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const s = t.objectStore(store);
    for (const v of values) s.put(v);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function getAll<T>(store: string): Promise<T[]> {
  return (await tx(store, 'readonly', (s) => s.getAll())) as T[];
}

export async function getOne<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  return (await tx(store, 'readonly', (s) => s.get(key))) as T | undefined;
}

export async function clearStore(store: string): Promise<void> {
  await tx(store, 'readwrite', (s) => s.clear());
}

export async function queryIndex<T>(
  store: string,
  index: string,
  value: IDBValidKey,
): Promise<T[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readonly');
    const req = t.objectStore(store).index(index).getAll(value);
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

export async function countStore(store: string): Promise<number> {
  return tx(store, 'readonly', (s) => s.count());
}

// ---------- 业务便捷方法 ----------
export const saveRawRecords = (rows: RawRecord[]) => putMany(STORES.raw, rows);
export const saveLedger = (rows: DeviceLedger[]) => putMany(STORES.ledger, rows);
export const saveZones = (rows: ConstructionZone[]) => putMany(STORES.construction, rows);
export const saveSectors = (rows: PatrolSector[]) => putMany(STORES.sectors, rows);
export const saveRectifications = (rows: Rectification[]) =>
  putMany(STORES.rectification, rows);
export const saveRuleVersions = (rows: RuleVersion[]) => putMany(STORES.ruleVersions, rows);
export const saveManifest = (m: ScenarioManifest) => putOne(STORES.manifest, m);
export const saveEvents = (rows: CompressionEvent[]) => putMany(STORES.events, rows);
export const saveMemberships = (rows: MembershipRecord[]) =>
  putMany(STORES.memberships, rows);
export const saveActions = (rows: DisposalAction[]) => putMany(STORES.actions, rows);
export const saveConflicts = (rows: SyncConflict[]) => putMany(STORES.conflicts, rows);
export const saveReport = (r: SyncReport) => putOne(STORES.reports, r);
export const saveLocationEvidence = (rows: LocationEvidence[]) =>
  putMany(STORES.locationEvidence, rows);
export const saveLocationTrust = (rows: LocationTrust[]) => putMany(STORES.locationTrust, rows);
export const saveDriftSegments = (rows: DriftSegment[]) => putMany(STORES.driftSegments, rows);
export const saveLocationAnomalies = (rows: LocationAnomaly[]) =>
  putMany(STORES.locationAnomalies, rows);
export const saveReviewItems = (rows: ReviewItem[]) => putMany(STORES.reviewItems, rows);

export async function loadAll() {
  const [
    raw,
    ledger,
    zones,
    sectors,
    rectifications,
    ruleVersions,
    manifests,
    alerts,
    events,
    memberships,
    actions,
    conflicts,
    reports,
    locationEvidence,
    locationTrust,
    driftSegments,
    locationAnomalies,
    reviewItems,
  ] = await Promise.all([
    getAll<RawRecord>(STORES.raw),
    getAll<DeviceLedger>(STORES.ledger),
    getAll<ConstructionZone>(STORES.construction),
    getAll<PatrolSector>(STORES.sectors),
    getAll<Rectification>(STORES.rectification),
    getAll<RuleVersion>(STORES.ruleVersions),
    getAll<ScenarioManifest>(STORES.manifest),
    getAll<import('./types').Alert>(STORES.alerts),
    getAll<CompressionEvent>(STORES.events),
    getAll<MembershipRecord>(STORES.memberships),
    getAll<DisposalAction>(STORES.actions),
    getAll<SyncConflict>(STORES.conflicts),
    getAll<SyncReport>(STORES.reports),
    getAll<LocationEvidence>(STORES.locationEvidence),
    getAll<LocationTrust>(STORES.locationTrust),
    getAll<DriftSegment>(STORES.driftSegments),
    getAll<LocationAnomaly>(STORES.locationAnomalies),
    getAll<ReviewItem>(STORES.reviewItems),
  ]);
  return {
    raw,
    ledger,
    zones,
    sectors,
    rectifications,
    ruleVersions,
    manifests,
    alerts,
    events,
    memberships,
    actions,
    conflicts,
    reports,
    locationEvidence,
    locationTrust,
    driftSegments,
    locationAnomalies,
    reviewItems,
  };
}

export async function wipeDerivedData(): Promise<void> {
  await Promise.all(
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
  );
}

export async function resetAll(): Promise<void> {
  await Promise.all(Object.values(STORES).map(clearStore));
  dbPromise = null;
}
