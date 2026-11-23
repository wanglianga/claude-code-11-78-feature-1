// ============================================================
// IndexedDB 仓储冒烟（fake-indexeddb，Node 环境）：
// 验证真实浏览器使用的同一套 db/repository 代码可完成
// 原始记录、事件、成员关系、处置行动与同步报告的落盘/回读。
// ============================================================

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildScenario, t } from './scenario';
import { loadBundle, verifySignatures } from './loader';
import { runPipeline } from './pipeline';
import {
  STORES,
  countStore,
  resetAll,
} from './db';
import { repository } from './repository';

describe('IndexedDB 离线仓储', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('装载签名 -> 核验产物落盘 -> 重新打开后完整回读', async () => {
    const bundle = buildScenario();
    const stats = await loadBundle(bundle);
    expect(stats.rawCount).toBe(bundle.raw.length);
    expect(stats.signedCount).toBe(bundle.raw.length);

    const stored = await repository.raw();
    expect(await verifySignatures(stored)).toEqual([]);
    expect(await countStore(STORES.ledger)).toBe(bundle.ledger.length);
    expect(await countStore(STORES.construction)).toBe(bundle.zones.length);
    expect(await countStore(STORES.rectification)).toBe(bundle.rectifications.length);

    await repository.saveMapping(bundle.mapping);
    const out = await runPipeline({
      ...bundle,
      mapping: bundle.mapping,
      nowIso: t(18, 0),
      localRev: 18,
      seedOfflineActions: true,
    });
    await repository.saveVerifyOutput({
      alerts: out.alerts,
      eventsA: out.eventsA,
      eventsB: out.eventsB,
      memberships: out.memberships,
      dict: out.dict.toJSON(),
      report: out.report,
      actions: out.seededActions,
      locationEvidence: out.locationEvidence,
      locationTrust: out.locationTrusts,
      driftSegments: out.driftSegments,
      locationAnomalies: out.locationAnomalies,
      reviewItems: out.reviewItems,
    });

    // 模拟重新打开应用：仅靠 IndexedDB 回读
    const [
      alerts,
      events,
      memberships,
      actions,
      reports,
      dictRow,
      conflicts,
      locationEvidence,
      locationTrust,
      driftSegments,
      locationAnomalies,
      reviewItems,
    ] = await Promise.all([
      repository.alerts(),
      repository.events(),
      repository.memberships(),
      repository.actions(),
      repository.reports(),
      repository.loadDict(),
      repository.conflicts(),
      repository.locationEvidence(),
      repository.locationTrust(),
      repository.driftSegments(),
      repository.locationAnomalies(),
      repository.reviewItems(),
    ]);
    expect(alerts.length).toBe(out.alerts.length);
    expect(events.length).toBe(out.eventsA.length + out.eventsB.length);
    expect(memberships.length).toBe(out.memberships.length);
    expect(actions.length).toBe(out.seededActions.length);
    expect(reports[0].equivalence.length).toBe(out.report.equivalence.length);
    expect(dictRow?.value.length).toBe(out.dict.toJSON().length);
    expect(conflicts.length).toBe(out.report.conflicts.length);

    // 定位可信度子系统产物完整回读
    expect(locationEvidence.length).toBe(out.locationEvidence.length);
    expect(locationTrust.length).toBe(out.locationTrusts.length);
    expect(driftSegments.length).toBe(out.driftSegments.length);
    expect(locationAnomalies.length).toBe(out.locationAnomalies.length);
    expect(reviewItems.length).toBe(out.reviewItems.length);
    // 片区主数据独立保存，不随派生数据清理
    expect((await repository.sectors()).length).toBe(bundle.sectors.length);

    // 复核队列解决：确认后状态/结论/处理人/时间落盘，且其它条目不受影响
    const target = reviewItems.find((r) => r.category === 'geo_alert')!;
    const updated = await repository.resolveReviewItem(
      target.id,
      'resolved',
      '照片与扫码均在 PS-A，确认定位漂移，同意降权',
      '陈审计',
      t(18, 0),
    );
    const resolved = updated.find((r) => r.id === target.id)!;
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolution).toContain('同意降权');
    expect(resolved.resolvedBy).toBe('陈审计');
    expect(updated.filter((r) => r.status === 'queued').length).toBe(reviewItems.length - 1);

    // 索引查询：按事件回读处置行动
    const byEvent = await repository.actionsByEvent(out.seededActions[0].eventId);
    expect(byEvent.length).toBeGreaterThan(0);

    // 清空派生数据后原始记录与片区主数据仍在
    await repository.wipeDerived();
    expect(await countStore(STORES.alerts)).toBe(0);
    expect(await countStore(STORES.reviewItems)).toBe(0);
    expect(await countStore(STORES.driftSegments)).toBe(0);
    expect(await countStore(STORES.raw)).toBe(bundle.raw.length);
    expect(await countStore(STORES.sectors)).toBe(bundle.sectors.length);
  });
});
