import { getAddress } from 'viem';
import {
  ERC20_TRANSFER_FROM_SELECTOR,
  ERC20_TRANSFER_SELECTOR,
  extractDirectTransferIntents,
  uniqueDirectTransferDestinations,
} from './direct-transfer-intents';

const OWNER = '0x1111111111111111111111111111111111111111';
const EXTERNAL = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function padAddress(addr: string): string {
  return addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function padUint(n: bigint): string {
  return n.toString(16).padStart(64, '0');
}

function transferData(to: string, amount = 1n): string {
  return `${ERC20_TRANSFER_SELECTOR}${padAddress(to)}${padUint(amount)}`;
}

function transferFromData(from: string, to: string, amount = 1n): string {
  return `${ERC20_TRANSFER_FROM_SELECTOR}${padAddress(from)}${padAddress(to)}${padUint(amount)}`;
}

describe('extractDirectTransferIntents', () => {
  it('extracts transfer destinations that are not the execution owner', () => {
    const result = extractDirectTransferIntents(
      [{ to: TOKEN, data: transferData(EXTERNAL), value: '0' }],
      OWNER,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fullyProvenDirectEgress).toBe(true);
    expect(result.notProven).toEqual([]);
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0]).toMatchObject({
      kind: 'erc20_transfer',
      recipient: getAddress(EXTERNAL).toLowerCase(),
      interactionIndex: 0,
    });
  });

  it('ignores self-transfer (recipient === execution owner)', () => {
    const result = extractDirectTransferIntents(
      [{ to: TOKEN, data: transferData(OWNER), value: '0' }],
      OWNER,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intents).toEqual([]);
    expect(result.fullyProvenDirectEgress).toBe(false);
    expect(result.notProven).toEqual([{ interactionIndex: 0, reason: 'self_transfer' }]);
  });

  it('extracts transferFrom only when from === execution owner', () => {
    const owned = extractDirectTransferIntents(
      [{ to: TOKEN, data: transferFromData(OWNER, EXTERNAL), value: '0' }],
      OWNER,
    );
    expect(owned.ok).toBe(true);
    if (!owned.ok) return;
    expect(owned.intents).toHaveLength(1);
    expect(owned.intents[0]!.kind).toBe('erc20_transfer_from');
    expect(owned.intents[0]!.recipient).toBe(getAddress(EXTERNAL).toLowerCase());

    const foreign = extractDirectTransferIntents(
      [{ to: TOKEN, data: transferFromData(OTHER, EXTERNAL), value: '0' }],
      OWNER,
    );
    expect(foreign.ok).toBe(true);
    if (!foreign.ok) return;
    expect(foreign.intents).toEqual([]);
    expect(foreign.fullyProvenDirectEgress).toBe(false);
    expect(foreign.notProven).toEqual([
      { interactionIndex: 0, reason: 'non_owner_transfer_from' },
    ]);
  });

  it('rejects known-selector transfer with wrong length (trailing data)', () => {
    const trailing = transferData(EXTERNAL) + '00';
    const result = extractDirectTransferIntents([{ to: TOKEN, data: trailing }], OWNER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('malformed_direct_transfer');
    expect(result.message).toMatch(/invalid length/i);
  });

  it('rejects transfer with non-zero address padding', () => {
    // Corrupt the leading 12 bytes of the address word.
    const bad =
      ERC20_TRANSFER_SELECTOR +
      '000000000000000000000001' +
      EXTERNAL.toLowerCase().replace(/^0x/, '') +
      padUint(1n);
    const result = extractDirectTransferIntents([{ to: TOKEN, data: bad }], OWNER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/invalid word encoding/i);
  });

  it('classifies empty calldata and unknown selectors as not proven (never safe)', () => {
    const empty = extractDirectTransferIntents([{ to: TOKEN, data: '0x', value: '0' }], OWNER);
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(empty.intents).toEqual([]);
    expect(empty.fullyProvenDirectEgress).toBe(false);
    expect(empty.notProven).toEqual([{ interactionIndex: 0, reason: 'empty_calldata' }]);

    const approve = extractDirectTransferIntents(
      [{ to: TOKEN, data: '0x095ea7b3' + padAddress(EXTERNAL) + padUint(1n), value: '0' }],
      OWNER,
    );
    expect(approve.ok).toBe(true);
    if (!approve.ok) return;
    expect(approve.intents).toEqual([]);
    expect(approve.fullyProvenDirectEgress).toBe(false);
    expect(approve.notProven).toEqual([{ interactionIndex: 0, reason: 'unknown_selector' }]);

    // Incomplete selector is not a full known transfer selector.
    const incomplete = extractDirectTransferIntents([{ to: TOKEN, data: '0xa9059c' }], OWNER);
    expect(incomplete.ok).toBe(true);
    if (!incomplete.ok) return;
    expect(incomplete.intents).toEqual([]);
    expect(incomplete.fullyProvenDirectEgress).toBe(false);
    expect(incomplete.notProven).toEqual([{ interactionIndex: 0, reason: 'incomplete_selector' }]);
  });

  it('marks a pure external transfer batch as fully proven direct egress', () => {
    const result = extractDirectTransferIntents(
      [
        { to: TOKEN, data: transferData(EXTERNAL), value: '0' },
        { to: TOKEN, data: transferFromData(OWNER, OTHER), value: '0' },
      ],
      OWNER,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fullyProvenDirectEgress).toBe(true);
    expect(result.notProven).toEqual([]);
    expect(result.intents).toHaveLength(2);
  });

  it('mixed proven transfer + unknown selector is not fully proven', () => {
    const result = extractDirectTransferIntents(
      [
        { to: TOKEN, data: transferData(EXTERNAL), value: '0' },
        { to: TOKEN, data: '0xdeadbeef', value: '0' },
      ],
      OWNER,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fullyProvenDirectEgress).toBe(false);
    expect(result.intents).toHaveLength(1);
    expect(result.notProven).toEqual([{ interactionIndex: 1, reason: 'unknown_selector' }]);
  });

  it('empty interaction list is not fully proven (intents.length === 0 is never safe)', () => {
    const result = extractDirectTransferIntents([], OWNER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intents).toEqual([]);
    expect(result.fullyProvenDirectEgress).toBe(false);
    expect(result.notProven).toEqual([]);
  });

  it('rejects known transfer selector with non-hex body', () => {
    const result = extractDirectTransferIntents(
      [{ to: TOKEN, data: `${ERC20_TRANSFER_SELECTOR}zzzz` }],
      OWNER,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('malformed_direct_transfer');
    expect(result.message).toMatch(/not valid hex/i);
  });

  it('rejects known transfer selector with odd-length body', () => {
    const result = extractDirectTransferIntents(
      [{ to: TOKEN, data: `${ERC20_TRANSFER_SELECTOR}abc` }],
      OWNER,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/not valid hex/i);
  });

  it('rejects known transfer selector with truncated body', () => {
    const truncated = transferData(EXTERNAL).slice(0, 20);
    const result = extractDirectTransferIntents([{ to: TOKEN, data: truncated }], OWNER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/invalid length/i);
  });

  it('rejects known transferFrom selector with truncated body', () => {
    const truncated = transferFromData(OWNER, EXTERNAL).slice(0, 40);
    const result = extractDirectTransferIntents([{ to: TOKEN, data: truncated }], OWNER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/invalid length/i);
  });

  it('accepts lowercase, correct checksum, and wrong mixed-case interaction.to equally', () => {
    const lower = TOKEN.toLowerCase();
    const checksummed = getAddress(TOKEN);
    // Force a non-checksum mixed-case form (DTO still accepts 40 hex digits).
    const mixed =
      '0x' +
      checksummed
        .slice(2)
        .split('')
        .map((c, i) => (i % 2 === 0 ? c.toLowerCase() : c.toUpperCase()))
        .join('');

    for (const to of [lower, checksummed, mixed]) {
      const result = extractDirectTransferIntents(
        [{ to, data: transferData(EXTERNAL), value: '0' }],
        OWNER,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.intents).toHaveLength(1);
      expect(result.intents[0]!.recipient).toBe(getAddress(EXTERNAL).toLowerCase());
      expect(result.intents[0]!.contract).toBe(getAddress(TOKEN).toLowerCase());
    }
  });

  it('malforms known transfer when interaction.to is not a 20-byte hex address', () => {
    const result = extractDirectTransferIntents(
      [{ to: '0xnotanaddress', data: transferData(EXTERNAL), value: '0' }],
      OWNER,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('malformed_direct_transfer');
    expect(result.message).toMatch(/target address is invalid/i);
  });

  it('batch with mixed-case token still extracts destination (no silent skip)', () => {
    const mixed =
      '0x' +
      getAddress(TOKEN)
        .slice(2)
        .split('')
        .map((c, i) => (i % 3 === 0 ? c.toUpperCase() : c.toLowerCase()))
        .join('');
    const result = extractDirectTransferIntents(
      [
        { to: mixed, data: transferData(EXTERNAL), value: '0' },
        { to: TOKEN, data: '0xdeadbeef', value: '0' },
      ],
      OWNER,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intents.map((i) => i.recipient)).toEqual([getAddress(EXTERNAL).toLowerCase()]);
    expect(result.fullyProvenDirectEgress).toBe(false);
  });

  it('uniqueDirectTransferDestinations de-dupes while preserving order', () => {
    const result = extractDirectTransferIntents(
      [
        { to: TOKEN, data: transferData(EXTERNAL) },
        { to: TOKEN, data: transferData(OTHER) },
        { to: TOKEN, data: transferData(EXTERNAL) },
      ],
      OWNER,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(uniqueDirectTransferDestinations(result.intents)).toEqual([
      getAddress(EXTERNAL).toLowerCase(),
      getAddress(OTHER).toLowerCase(),
    ]);
  });
});
