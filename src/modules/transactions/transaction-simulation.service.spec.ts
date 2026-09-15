import { BadRequestException, Logger } from '@nestjs/common';
import { ethAddress } from 'viem';
import {
  ASSET_FLOW_EVIDENCE_SCHEMA_VERSION,
  ASSET_FLOW_RULE_VERSION,
  computeAssetFlowPlanDigest,
  hasTrustedAssetFlowEvidenceAuthority,
  verifyTransactionAssetFlow,
} from './transaction-asset-flow.verifier';

const mockCall = jest.fn();
const mockSimulateCalls = jest.fn();
const mockCreatePublicClient = jest.fn();
const mockHttp = jest.fn((url?: string) =>
  url === undefined ? 'http-transport-default' : `http-transport:${url}`,
);

jest.mock('viem', () => ({
  ...jest.requireActual('viem'),
  createPublicClient: (options?: unknown) => mockCreatePublicClient(options),
  getAddress: (address: string) => address,
  http: (url?: string) => mockHttp(url),
  isAddress: (address: string) => /^0x[0-9a-fA-F]{40}$/.test(address),
}));

import {
  AssetFlowSimulationUnavailableError,
  TransactionSimulationService,
} from './transaction-simulation.service';

describe('TransactionSimulationService', () => {
  const dto = {
    chainId: 8453,
    interactions: [{ to: '0x1111111111111111111111111111111111111111', data: '0x12345678', value: '0' }],
    idempotencyKey: 'idem-1',
  } as any;
  const context = {
    userId: 'user-1',
    apiKeyId: 'api-key-1',
    apiKeyPrefix: 'sk_1234567890abcdef12345678',
    chainId: 8453,
    executionMode: 'session_key' as const,
    from: '0x2222222222222222222222222222222222222222',
  };
  const securityEvents = { record: jest.fn() };
  let loggerWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCall.mockResolvedValue({ data: '0x' });
    mockSimulateCalls.mockReset();
    mockCreatePublicClient.mockReset();
    mockCreatePublicClient.mockImplementation(() => ({
      call: mockCall,
      simulateCalls: mockSimulateCalls,
    }));
    loggerWarnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    loggerWarnSpy.mockRestore();
  });

  it('simulates every interaction and records an allow event', async () => {
    const service = new TransactionSimulationService(securityEvents as any);

    await expect(service.assertSimulatable(dto, context)).resolves.toBeUndefined();

    expect(mockCall).toHaveBeenCalledWith({
      account: context.from,
      to: dto.interactions[0].to,
      data: dto.interactions[0].data,
      value: 0n,
    });
    expect(securityEvents.record).toHaveBeenCalledWith({
      actorType: 'api_key',
      eventType: 'transaction.simulation_allowed',
      userId: 'user-1',
      apiKeyId: 'api-key-1',
      riskLevel: 'low',
      result: 'allowed',
      reason: 'simulation_passed',
      metadata: expect.objectContaining({
        chainId: 8453,
        executionMode: 'session_key',
        apiKeyPrefix: context.apiKeyPrefix,
        interactionCount: 1,
      }),
    });
  });

  it('defers multi-interaction batch simulation to the bundler', async () => {
    const service = new TransactionSimulationService(securityEvents as any);
    const batchDto = {
      ...dto,
      interactions: [
        dto.interactions[0],
        {
          to: '0x3333333333333333333333333333333333333333',
          data: '0xabcdef12',
          value: '0',
        },
      ],
    };

    await expect(service.assertSimulatable(batchDto, context)).resolves.toBeUndefined();

    expect(mockCall).not.toHaveBeenCalled();
    expect(securityEvents.record).toHaveBeenCalledWith({
      actorType: 'api_key',
      eventType: 'transaction.simulation_allowed',
      userId: 'user-1',
      apiKeyId: 'api-key-1',
      riskLevel: 'low',
      result: 'allowed',
      reason: 'batch_simulation_deferred_to_bundler',
      metadata: expect.objectContaining({
        chainId: 8453,
        executionMode: 'session_key',
        apiKeyPrefix: context.apiKeyPrefix,
        interactionCount: 2,
        simulationMode: 'bundler_batch',
      }),
    });
  });

  it('rejects failed simulations without logging full calldata', async () => {
    const fullCalldata = `0x${'11'.repeat(64)}`;
    mockCall.mockRejectedValueOnce(new Error(`execution reverted with calldata ${fullCalldata}`));
    const service = new TransactionSimulationService(securityEvents as any);

    await expect(
      service.assertSimulatable(
        { ...dto, interactions: [{ ...dto.interactions[0], data: fullCalldata }] },
        context,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'security',
        message: 'Transaction simulation rejected request',
        reason: expect.stringContaining('[hex]'),
        interactionIndex: 0,
      }),
    );
    expect(securityEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'transaction.simulation_denied',
        result: 'denied',
        riskLevel: 'high',
        reason: expect.stringContaining('[hex]'),
        metadata: expect.objectContaining({ interactionIndex: 0 }),
      }),
    );
    expect(JSON.stringify(loggerWarnSpy.mock.calls)).not.toContain(fullCalldata);
    expect(JSON.stringify(securityEvents.record.mock.calls)).not.toContain(fullCalldata);
  });

  describe('simulateAssetFlowEvidence', () => {
    const owner = '0x2222222222222222222222222222222222222222';
    const rpcUrl = 'https://rpc.example.invalid/v1/base';
    const token = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const blockHash = `0x${'cd'.repeat(32)}`;

    const baseInput = {
      interactions: [
        {
          to: '0x1111111111111111111111111111111111111111',
          data: '0x12345678',
          value: '0',
        },
      ],
      ownerAddress: owner,
      chainId: 8453,
      executionMode: 'session_key' as const,
      rpcUrl,
    };

    function mockSuccessPayload(overrides: Record<string, unknown> = {}) {
      return {
        results: [{ status: 'success', data: '0xdead', gasUsed: 21000n, logs: [] }],
        assetChanges: [
          {
            token: { address: token, decimals: 6, symbol: 'USDC' },
            value: { pre: 10n, post: 25n, diff: 15n },
          },
        ],
        block: {
          number: 42n,
          hash: blockHash,
        },
        ...overrides,
      };
    }

    it('calls simulateCalls with owner account, calls, and asset/transfer traces over explicit rpc', async () => {
      mockSimulateCalls.mockResolvedValueOnce(mockSuccessPayload());
      const service = new TransactionSimulationService(securityEvents as any);

      const evidence = await service.simulateAssetFlowEvidence(baseInput);

      expect(mockHttp).toHaveBeenCalledWith(rpcUrl);
      expect(mockCreatePublicClient).toHaveBeenCalledWith(
        expect.objectContaining({
          transport: `http-transport:${rpcUrl}`,
        }),
      );
      expect(mockSimulateCalls).toHaveBeenCalledWith({
        account: owner,
        calls: [
          {
            to: baseInput.interactions[0].to,
            data: baseInput.interactions[0].data,
            value: 0n,
          },
        ],
        traceAssetChanges: true,
        traceTransfers: true,
      });

      expect(evidence.simulationMode).toBe('eth_simulateV1_non_atomic');
      expect(evidence.binding.schemaVersion).toBe(ASSET_FLOW_EVIDENCE_SCHEMA_VERSION);
      expect(evidence.binding.ruleVersion).toBe(ASSET_FLOW_RULE_VERSION);
      expect(evidence.binding.chainId).toBe(8453);
      expect(evidence.binding.executionMode).toBe('session_key');
      expect(evidence.binding.ownerAddress.toLowerCase()).toBe(owner.toLowerCase());
      expect(evidence.binding.planDigest).toBe(
        computeAssetFlowPlanDigest({
          ownerAddress: owner,
          chainId: 8453,
          executionMode: 'session_key',
          interactions: baseInput.interactions,
        }),
      );
      expect(evidence.binding.simulatedBlock).toEqual({
        number: 42n,
        hash: blockHash.toLowerCase(),
      });
      // M3: base must stay unavailable — never copied from simulated.
      expect(evidence.binding.baseBlock).toEqual({ number: null, hash: null });
      expect(evidence.coverage.assetObservation.completeness).not.toBe('complete');
      expect(evidence.coverage.internalCalls).toEqual({
        completeness: 'unknown',
        observed: false,
      });
      expect(evidence.coverage.permissions.completeness).toBe('unknown');
      expect(evidence.relations).toEqual([]);
      expect(evidence.results).toEqual([{ status: 'success' }]);
      expect(evidence.results[0]).not.toHaveProperty('data');
      expect(evidence.assetChanges).toHaveLength(1);
      expect(evidence.assetChanges[0].kind).toBe('erc20');
      expect(evidence.assetChanges[0].diff).toBe(15n);
      expect(evidence.assetChanges[0].entryId).toMatch(/^obs:/);
      expect(hasTrustedAssetFlowEvidenceAuthority(evidence)).toBe(false);
    });

    it('marks empty assetChanges as incomplete coverage (not complete zero-change)', async () => {
      mockSimulateCalls.mockResolvedValueOnce(
        mockSuccessPayload({
          assetChanges: [],
        }),
      );
      const service = new TransactionSimulationService(securityEvents as any);
      const evidence = await service.simulateAssetFlowEvidence(baseInput);

      expect(evidence.assetChanges).toEqual([]);
      expect(evidence.coverage.assetObservation.completeness).toBe('incomplete');
      expect(evidence.simulationMode).toBe('eth_simulateV1_non_atomic');

      // Verifier must fail closed on production adapter evidence.
      const verdict = verifyTransactionAssetFlow({
        ownerAddress: owner,
        chainId: 8453,
        executionMode: 'session_key',
        interactions: baseInput.interactions,
        evidence,
      });
      expect(verdict.status).toBe('unknown');
    });

    it('marks missing assetChanges field as unknown asset coverage', async () => {
      mockSimulateCalls.mockResolvedValueOnce({
        results: [{ status: 'success' }],
        block: { number: 1n, hash: blockHash },
        // assetChanges absent
      });
      const service = new TransactionSimulationService(securityEvents as any);
      const evidence = await service.simulateAssetFlowEvidence(baseInput);

      expect(evidence.coverage.assetObservation.completeness).toBe('unknown');
      expect(evidence.assetChanges).toEqual([]);
    });

    it('supports multi-interaction batches in one simulateCalls invocation', async () => {
      mockSimulateCalls.mockResolvedValueOnce({
        results: [
          { status: 'success', data: '0x' },
          { status: 'success', data: '0x' },
        ],
        assetChanges: [],
        block: { number: 1n, hash: blockHash },
      });
      const service = new TransactionSimulationService(securityEvents as any);

      const evidence = await service.simulateAssetFlowEvidence({
        ...baseInput,
        interactions: [
          baseInput.interactions[0],
          {
            to: '0x3333333333333333333333333333333333333333',
            data: '0xabcdef12',
            value: '1',
          },
        ],
      });

      expect(mockSimulateCalls).toHaveBeenCalledWith(
        expect.objectContaining({
          account: owner,
          calls: [
            expect.objectContaining({ value: 0n }),
            expect.objectContaining({
              to: '0x3333333333333333333333333333333333333333',
              value: 1n,
            }),
          ],
          traceAssetChanges: true,
          traceTransfers: true,
        }),
      );
      expect(evidence.results).toHaveLength(2);
      expect(evidence.simulationMode).toBe('eth_simulateV1_non_atomic');
    });

    it('records native asset under native kind using eth sentinel', async () => {
      mockSimulateCalls.mockResolvedValueOnce(
        mockSuccessPayload({
          assetChanges: [
            {
              token: { address: ethAddress, decimals: 18, symbol: 'ETH' },
              value: { pre: 5n, post: 3n, diff: -2n },
            },
          ],
        }),
      );
      const service = new TransactionSimulationService(securityEvents as any);
      const evidence = await service.simulateAssetFlowEvidence(baseInput);

      expect(evidence.assetChanges[0].kind).toBe('native');
      expect(evidence.assetChanges[0].assetKey).toBe('native');
    });

    it('throws fixed unavailable error when simulateCalls fails without leaking provider text', async () => {
      const fullCalldata = `0x${'aa'.repeat(64)}`;
      const shortCalldata = '0x12345678';
      const nonHexSecret = 'super-secret-provider-token-xyz';
      mockSimulateCalls.mockRejectedValue(
        new Error(
          `provider exploded with ${fullCalldata} and ${shortCalldata} secret=${nonHexSecret} at https://secret-rpc.internal`,
        ),
      );
      const service = new TransactionSimulationService(securityEvents as any);

      await expect(service.simulateAssetFlowEvidence(baseInput)).rejects.toBeInstanceOf(
        AssetFlowSimulationUnavailableError,
      );
      await expect(service.simulateAssetFlowEvidence(baseInput)).rejects.toMatchObject({
        code: 'ASSET_FLOW_SIMULATION_UNAVAILABLE',
        category: 'asset_flow_simulation_unavailable',
        message: 'Asset flow simulation unavailable',
      });

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'security',
          message: 'Asset flow simulation unavailable',
          category: 'asset_flow_simulation_unavailable',
          chainId: 8453,
          interactionCount: 1,
        }),
      );
      // Fixed-category log only — no reason/provider body field.
      const warnArg = loggerWarnSpy.mock.calls.find(
        (c) => c[0]?.message === 'Asset flow simulation unavailable',
      )?.[0];
      expect(warnArg).not.toHaveProperty('reason');
      const logged = JSON.stringify(loggerWarnSpy.mock.calls);
      expect(logged).not.toContain(fullCalldata);
      expect(logged).not.toContain(shortCalldata);
      expect(logged).not.toContain(nonHexSecret);
      expect(logged).not.toContain('https://secret-rpc.internal');
      expect(logged).not.toContain('[hex]');
      expect(logged).not.toContain(fullCalldata.slice(2, 20));
    });

    it('throws when rpcUrl is missing or blank', async () => {
      const service = new TransactionSimulationService(securityEvents as any);

      await expect(
        service.simulateAssetFlowEvidence({ ...baseInput, rpcUrl: '' }),
      ).rejects.toBeInstanceOf(AssetFlowSimulationUnavailableError);
      await expect(
        service.simulateAssetFlowEvidence({ ...baseInput, rpcUrl: '   ' }),
      ).rejects.toBeInstanceOf(AssetFlowSimulationUnavailableError);
      expect(mockSimulateCalls).not.toHaveBeenCalled();
      expect(mockHttp).not.toHaveBeenCalled();
    });

    it('throws when simulateCalls is not available on the client', async () => {
      mockCreatePublicClient.mockImplementationOnce(
        () =>
          ({
            call: mockCall,
          }) as any,
      );
      const service = new TransactionSimulationService(securityEvents as any);

      await expect(service.simulateAssetFlowEvidence(baseInput)).rejects.toBeInstanceOf(
        AssetFlowSimulationUnavailableError,
      );
    });

    it('throws on malformed provider payload (results length mismatch)', async () => {
      mockSimulateCalls.mockResolvedValueOnce({
        results: [],
        assetChanges: [],
        block: { number: 1n, hash: blockHash },
      });
      const service = new TransactionSimulationService(securityEvents as any);

      await expect(service.simulateAssetFlowEvidence(baseInput)).rejects.toBeInstanceOf(
        AssetFlowSimulationUnavailableError,
      );
    });

    it('throws on inconsistent asset diff from provider', async () => {
      mockSimulateCalls.mockResolvedValueOnce(
        mockSuccessPayload({
          assetChanges: [
            {
              token: { address: token },
              value: { pre: 1n, post: 2n, diff: 99n },
            },
          ],
        }),
      );
      const service = new TransactionSimulationService(securityEvents as any);

      await expect(service.simulateAssetFlowEvidence(baseInput)).rejects.toBeInstanceOf(
        AssetFlowSimulationUnavailableError,
      );
    });

    it('throws on duplicate asset keys from provider', async () => {
      mockSimulateCalls.mockResolvedValueOnce(
        mockSuccessPayload({
          assetChanges: [
            {
              token: { address: token },
              value: { pre: 1n, post: 2n, diff: 1n },
            },
            {
              token: { address: token },
              value: { pre: 3n, post: 4n, diff: 1n },
            },
          ],
        }),
      );
      const service = new TransactionSimulationService(securityEvents as any);

      await expect(service.simulateAssetFlowEvidence(baseInput)).rejects.toBeInstanceOf(
        AssetFlowSimulationUnavailableError,
      );
    });

    it('throws on negative pre balance from provider', async () => {
      mockSimulateCalls.mockResolvedValueOnce(
        mockSuccessPayload({
          assetChanges: [
            {
              token: { address: token },
              value: { pre: -1n, post: 2n, diff: 3n },
            },
          ],
        }),
      );
      const service = new TransactionSimulationService(securityEvents as any);

      await expect(service.simulateAssetFlowEvidence(baseInput)).rejects.toBeInstanceOf(
        AssetFlowSimulationUnavailableError,
      );
    });

    it('throws when block identity is missing', async () => {
      mockSimulateCalls.mockResolvedValueOnce({
        results: [{ status: 'success' }],
        assetChanges: [],
        block: {},
      });
      const service = new TransactionSimulationService(securityEvents as any);

      await expect(service.simulateAssetFlowEvidence(baseInput)).rejects.toBeInstanceOf(
        AssetFlowSimulationUnavailableError,
      );
    });

    it('does not use the default public http() transport for asset-flow evidence', async () => {
      mockSimulateCalls.mockResolvedValueOnce(mockSuccessPayload());
      const service = new TransactionSimulationService(securityEvents as any);

      await service.assertSimulatable(dto, context);
      expect(mockHttp).toHaveBeenCalledWith(undefined);

      mockHttp.mockClear();
      mockCreatePublicClient.mockClear();
      mockSimulateCalls.mockResolvedValueOnce(mockSuccessPayload());

      await service.simulateAssetFlowEvidence(baseInput);

      expect(mockHttp).toHaveBeenCalledWith(rpcUrl);
      expect(mockHttp).not.toHaveBeenCalledWith(undefined);
      expect(mockCreatePublicClient).toHaveBeenCalledTimes(1);
    });

    it('never forges complete coverage, relations, or producer authority from raw simulateCalls', async () => {
      mockSimulateCalls.mockResolvedValueOnce(mockSuccessPayload());
      const service = new TransactionSimulationService(securityEvents as any);
      const evidence = await service.simulateAssetFlowEvidence(baseInput);

      expect(evidence.coverage.assetObservation.completeness).toBe('incomplete');
      expect(evidence.coverage.internalCalls.observed).toBe(false);
      expect(evidence.relations).toEqual([]);
      expect(evidence.simulationMode).toBe('eth_simulateV1_non_atomic');
      expect(hasTrustedAssetFlowEvidenceAuthority(evidence)).toBe(false);

      const verdict = verifyTransactionAssetFlow({
        ownerAddress: owner,
        chainId: 8453,
        executionMode: 'session_key',
        interactions: baseInput.interactions,
        evidence,
      });
      // Production path is fail-closed unknown — expected Gate 1 safety result.
      expect(verdict.status).toBe('unknown');
      expect(verdict.rule).not.toMatch(/verified/);
      expect([
        'non_atomic_simulation_mode',
        'incomplete_asset_coverage',
        'incomplete_internal_call_coverage',
        'incomplete_permission_coverage',
        'incomplete_log_coverage',
        'missing_producer_authority',
      ]).toContain(verdict.rule);
    });

    it('does not leak non-hex log/calldata blobs into sealed evidence', async () => {
      const evil = 'SECRET_CALLDATA_0x' + 'ff'.repeat(32);
      mockSimulateCalls.mockResolvedValueOnce({
        results: [
          {
            status: 'success',
            data: evil,
            logs: [{ data: evil, topics: [evil] }],
          },
        ],
        assetChanges: [
          {
            token: { address: token },
            value: { pre: 0n, post: 1n, diff: 1n },
          },
        ],
        block: { number: 9n, hash: blockHash },
      });
      const service = new TransactionSimulationService(securityEvents as any);
      const evidence = await service.simulateAssetFlowEvidence(baseInput);
      const serialized = JSON.stringify(evidence, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      );

      expect(serialized).not.toContain(evil);
      expect(serialized).not.toContain('SECRET_CALLDATA');
      expect(evidence.results[0]).toEqual({ status: 'success' });
      expect(evidence.logs.completeness).toBe('incomplete');
      expect(evidence.logs.count).toBe(1);
    });
  });
});
