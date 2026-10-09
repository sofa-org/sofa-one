import { ServiceUnavailableException } from '@nestjs/common';
import { createPublicClient, keccak256, toBytes } from 'viem';
import { PolymarketDepositWalletVerifierService } from './polymarket-deposit-wallet-verifier.service';
import { validatePolymarketClobOrder } from '../defi/signing/polymarket-clob-order';

const mockGetChainId = jest.fn();
const mockGetCode = jest.fn();
const mockReadContract = jest.fn();
jest.mock('viem', () => ({ ...jest.requireActual('viem'), createPublicClient: jest.fn(() => ({ getChainId: mockGetChainId, getCode: mockGetCode, readContract: mockReadContract })) }));

const AGENT = '0x2222222222222222222222222222222222222222';
const DEPOSIT = '0x1111111111111111111111111111111111111111';
const CODE = '0x6001600055';
const HASH = keccak256(toBytes(CODE));
function payload() {
  const fields = (values: string[]) => values.map((x) => { const [name, type] = x.split(':'); return { name, type }; });
  return validatePolymarketClobOrder({ domain:{ name:'Polymarket CTF Exchange', version:'2', chainId:137, verifyingContract:'0xE111180000d2663C0091e4f400237545B87B996B' }, types:{ Order:fields(['salt:uint256','maker:address','signer:address','tokenId:uint256','makerAmount:uint256','takerAmount:uint256','side:uint8','signatureType:uint8','timestamp:uint256','metadata:bytes32','builder:bytes32']), TypedDataSign:fields(['contents:Order','name:string','version:string','chainId:uint256','verifyingContract:address','salt:bytes32']) }, primaryType:'TypedDataSign', message:{ contents:{ salt:'1',maker:DEPOSIT,signer:DEPOSIT,tokenId:'2',makerAmount:'3',takerAmount:'4',side:0,signatureType:3,timestamp:'1700000000000',metadata:`0x${'00'.repeat(32)}`,builder:`0x${'00'.repeat(32)}` },name:'DepositWallet',version:'1',chainId:137,verifyingContract:DEPOSIT,salt:`0x${'00'.repeat(32)}` } }, 1700000000000);
}

describe('PolymarketDepositWalletVerifierService', () => {
  let rpc: string | undefined;
  const config = { get: jest.fn(() => rpc) } as any;
  let service: PolymarketDepositWalletVerifierService;
  beforeEach(() => {
    jest.clearAllMocks();
    rpc = 'https://polygon.example/rpc';
    config.get.mockImplementation(() => rpc);
    mockGetChainId.mockResolvedValue(137);
    mockGetCode.mockResolvedValue(CODE);
    mockReadContract.mockResolvedValue('0x1626ba7e');
    service = new PolymarketDepositWalletVerifierService(config);
  });

  it('always observes Polygon runtime code without requiring an operator binding and validates ERC-1271', async () => {
    const typed = payload();
    const evidence = await service.verify(AGENT, typed);
    expect(evidence).toMatchObject({ agent:AGENT.toLowerCase(), deposit:DEPOSIT.toLowerCase(), codeHash:HASH });
    expect(createPublicClient).toHaveBeenCalled();
    expect(mockGetChainId).toHaveBeenCalledWith();
    expect(mockGetCode).toHaveBeenCalledWith({ address:DEPOSIT });
    service.assertFresh(evidence, AGENT, typed);
    await service.verify1271(typed, `0x${'11'.repeat(32)}`, '0x1234');
    expect(mockReadContract).toHaveBeenCalledWith(expect.objectContaining({ address:DEPOSIT, functionName:'isValidSignature', args:[`0x${'11'.repeat(32)}`, '0x1234'] }));
    mockReadContract.mockResolvedValueOnce('0xffffffff');
    await expect(service.verify1271(typed, `0x${'11'.repeat(32)}`, '0x1234')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects missing RPC, wrong chain, absent code, and RPC errors', async () => {
    const typed = payload();
    rpc = undefined;
    await expect(service.verify(AGENT, typed)).rejects.toBeInstanceOf(ServiceUnavailableException);
    rpc = 'https://polygon.example/rpc';
    mockGetChainId.mockResolvedValueOnce(1);
    await expect(service.verify(AGENT, typed)).rejects.toBeInstanceOf(ServiceUnavailableException);
    mockGetChainId.mockResolvedValue(137);
    mockGetCode.mockResolvedValueOnce('0x');
    await expect(service.verify(AGENT, typed)).rejects.toBeInstanceOf(ServiceUnavailableException);
    mockGetCode.mockRejectedValueOnce(new Error('provider failure'));
    await expect(service.verify(AGENT, typed)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects stale evidence, different agent/deposit, and RPC configuration changes', async () => {
    const typed = payload();
    const evidence = await service.verify(AGENT, typed);
    expect(() => service.assertFresh(evidence, '0x3333333333333333333333333333333333333333', typed)).toThrow(ServiceUnavailableException);
    expect(() => service.assertFresh(evidence, AGENT, payloadWithDifferentDeposit())).toThrow(ServiceUnavailableException);
    expect(() => service.assertFresh({ ...evidence, checkedAt:Date.now() - 15_001 }, AGENT, typed)).toThrow(ServiceUnavailableException);
    rpc = 'https://other-polygon.example/rpc';
    expect(() => service.assertFresh(evidence, AGENT, typed)).toThrow(ServiceUnavailableException);
  });

  it('re-observes and exposes code changes so wallet acceptance can reject changed runtime code', async () => {
    const typed = payload();
    const preflight = await service.verify(AGENT, typed);
    mockGetCode.mockResolvedValueOnce('0x6002600055');
    const final = await service.verify(AGENT, typed);
    expect(final.codeHash).not.toBe(preflight.codeHash);
  });
});

function payloadWithDifferentDeposit() {
  const typed = payload();
  return { ...typed, message:{ ...typed.message, verifyingContract:'0x3333333333333333333333333333333333333333' } } as typeof typed;
}
