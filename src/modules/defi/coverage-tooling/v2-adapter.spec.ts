import { adaptV2Sources } from './v2-adapter';

describe('adaptV2Sources', () => {
  const roster = Array.from({ length: 8_476 }, (_, index) => ({ id: String(index + 1), name: `provider ${index + 1}` }));
  const source = (mappings: any[]) => ({
    market: { protocolUniverse: roster },
    activity: { snapshotId: 'fixture-v2', captureTimestampUtc: '2026-10-03T19:11:22Z', sourceUniverse: { m1ProtocolUniverseCanonicalJsonSha256: 'frozen' }, sourceIdMetricRows: [], metricSourceIdsUnmatchedM1Universe: [] },
    crosswalk: { m1UniverseCanonicalJsonSha256: 'frozen', ledgerRecordCount: 8476, ledger: roster.map((row) => ({ sourceId: row.id })), mappings },
    methods: { methods: [] },
    workflows: { products: mappings }, catalog: { chains: [] }, catalogSource: { sources: [] },
  } as any);

  it('retains all unbridged and partial rows as unresolved source proxies', () => {
    const projection = adaptV2Sources(source([
      { sourceId: '1', identityStatus: 'canonical', productLabel: 'Exact product', categoryId: 'dex', identityEvidenceRef: 'pinned-source', expectedChains: [1], chainInventoryCompleteness: 'incomplete', targets: {}, workflows: [] },
      { sourceId: '2', identityStatus: 'partial', productLabel: 'Partial', categoryId: 'dex', identityEvidenceRef: 'partial-source', expectedChains: [1], chainInventoryCompleteness: 'incomplete', targets: {}, workflows: [] },
    ]));
    expect(projection.input.products.map((row) => row.productId)).toEqual(['raw-provider:1']);
    expect(projection.input.unresolvedUniverseRecords).toHaveLength(8_475);
    expect(projection.input.unresolvedUniverseRecords.some((row) => row.sourceRecordRef === 'protocol-roster:2')).toBe(true);
    expect(projection.input.snapshot.observedAt).toBe('2026-10-03T19:11:22Z');
  });

  it('rejects a source row absent from the frozen M1 roster', () => {
    expect(() => adaptV2Sources(source([{ sourceId: '99999', identityStatus: 'canonical', productLabel: 'not present', categoryId: 'dex', identityEvidenceRef: 'x', expectedChains: [1], chainInventoryCompleteness: 'incomplete', targets: {}, workflows: [] }]))).toThrow('not in frozen M1 roster');
  });

  it('rejects duplicate crosswalk IDs instead of merging source labels', () => {
    expect(() => adaptV2Sources(source([
      { sourceId: '1', identityStatus: 'canonical', productLabel: 'one', categoryId: 'dex', identityEvidenceRef: 'x', expectedChains: [1], chainInventoryCompleteness: 'incomplete', targets: {}, workflows: [] },
      { sourceId: '1', identityStatus: 'canonical', productLabel: 'alias', categoryId: 'dex', identityEvidenceRef: 'y', expectedChains: [1], chainInventoryCompleteness: 'incomplete', targets: {}, workflows: [] },
    ]))).toThrow('Duplicate raw source ID');
  });

  it('keeps Compound V2 positive BORROW_INTEREST fees unresolved without a captured activity-method link', () => {
    const fixture = source([{ sourceId: '114', identityStatus: 'canonical', productLabel: 'Compound V2', categoryId: 'lending', identityEvidenceRef: 'official-comptroller-source', expectedChains: [1], chainInventoryCompleteness: 'incomplete', targets: {}, workflows: [] }]);
    fixture.activity.sourceIdMetricRows = [{ sourceId: '114', metricsByChain: { ethereum: { fees: { observationWindowDays: 30, valueUsd: 86839, activityEvidenceStatus: 'positive_fees_not_user_activity_proxy' } } } }];
    fixture.methods.methods = [{ methodId: 'compound-v2-borrow-interest-fees-unqualified-v1', providerMetric: 'fees', qualifiesAsUserActivity: false, sourceIds: ['114'], chainIds: [1] }];
    const result = adaptV2Sources(fixture);
    const observation = result.input.observations.find((row) => row.productId === 'raw-provider:114' && row.chainId === 1);
    expect(observation?.status).toBe('unresolved');
    expect(observation?.activityMetrics).toBeUndefined();
    expect(result.input.unresolvedUniverseRecords.some((row) => row.sourceRecordRef === 'protocol-roster:114')).toBe(false);
  });

  it('continues to qualify positive DEX volume as an observed occurrence', () => {
    const fixture = source([{ sourceId: '1', identityStatus: 'canonical', productLabel: 'DEX', categoryId: 'dex', identityEvidenceRef: 'pinned-source', expectedChains: [1], chainInventoryCompleteness: 'incomplete', targets: {}, workflows: [] }]);
    fixture.activity.sourceIdMetricRows = [{ sourceId: '1', metricsByChain: { ethereum: { dexs: { observationWindowDays: 30, valueUsd: 12, activityEvidenceStatus: 'positive_observation_within_90d_window' } } } }];
    fixture.methods.methods = [{ methodId: 'dex-volume-30d-positive-occurrence-v1', providerMetric: 'dexs', qualifiesAsUserActivity: true, sourceIds: ['1'], chainIds: [1], unit: 'USD', window: '30d in 90d' }];
    const result = adaptV2Sources(fixture);
    expect(result.input.observations.find((row) => row.productId === 'raw-provider:1')?.status).toBe('observed_active');
  });
});
