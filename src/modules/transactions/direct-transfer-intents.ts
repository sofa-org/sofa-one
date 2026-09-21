/**
 * Strict extraction of direct ERC-20-shaped transfer destinations from a send
 * interaction batch. Used only for API-key destination/cooldown policy (BILL-016).
 *
 * In scope:
 *   - transfer(address,uint256)  selector 0xa9059cbb
 *   - transferFrom(address,address,uint256) selector 0x23b872dd when `from`
 *     equals the server-side execution owner (conservative: NFT-shared selector
 *     still treated as a destination intent; we never claim ERC-20 authenticity)
 *
 * Out of scope (no intent emitted): approvals, routers, multicalls, unknown
 * selectors, transferFrom where from ≠ execution owner, self-transfers.
 *
 * Known selectors with wrong length/padding/trailing bytes → stable malformed
 * error (HTTP 400 at the call site). Native non-zero value remains rejected by
 * TransactionPolicyService; empty/native-only interactions produce no intents.
 */
import { getAddress, isAddress } from 'viem';

export const ERC20_TRANSFER_SELECTOR = '0xa9059cbb';
export const ERC20_TRANSFER_FROM_SELECTOR = '0x23b872dd';

/** 0x + 4-byte selector + two 32-byte words. */
const TRANSFER_HEX_LEN = 138;
/** 0x + 4-byte selector + three 32-byte words. */
const TRANSFER_FROM_HEX_LEN = 202;

export type DirectTransferIntent = {
  kind: 'erc20_transfer' | 'erc20_transfer_from';
  /** Lowercase checksum-normalized recipient. */
  recipient: string;
  /** Interaction index in the original batch. */
  interactionIndex: number;
  /** Contract `to` (lowercase checksum-normalized). */
  contract: string;
};

export type DirectTransferExtractOk = {
  ok: true;
  /** Non-self direct transfer destinations (execution owner excluded). */
  intents: DirectTransferIntent[];
};

export type DirectTransferExtractErr = {
  ok: false;
  code: 'malformed_direct_transfer';
  message: string;
  interactionIndex: number;
};

export type DirectTransferExtractResult = DirectTransferExtractOk | DirectTransferExtractErr;

type InteractionLike = {
  to: string;
  data?: string;
  value?: string;
};

/**
 * Parse every interaction. Returns all non-self direct-transfer intents, or a
 * stable malformed error for known selectors that fail strict layout checks.
 */
export function extractDirectTransferIntents(
  interactions: ReadonlyArray<InteractionLike>,
  executionOwnerRaw: string,
): DirectTransferExtractResult {
  const owner = normalizeAddress(executionOwnerRaw);
  if (!owner) {
    return {
      ok: false,
      code: 'malformed_direct_transfer',
      message: 'Execution owner address is invalid',
      interactionIndex: -1,
    };
  }

  const intents: DirectTransferIntent[] = [];

  for (let i = 0; i < interactions.length; i++) {
    const interaction = interactions[i]!;
    const parsed = parseOneInteraction(interaction, i, owner);
    if (parsed.ok === false) {
      return parsed;
    }
    if (parsed.intent) {
      intents.push(parsed.intent);
    }
  }

  return { ok: true, intents };
}

/**
 * Unique lowercase destinations from intents (order-stable first-seen).
 */
export function uniqueDirectTransferDestinations(
  intents: readonly DirectTransferIntent[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const intent of intents) {
    if (seen.has(intent.recipient)) continue;
    seen.add(intent.recipient);
    out.push(intent.recipient);
  }
  return out;
}

function parseOneInteraction(
  interaction: InteractionLike,
  index: number,
  owner: string,
): { ok: true; intent: DirectTransferIntent | null } | DirectTransferExtractErr {
  const dataRaw = interaction.data ?? '0x';
  if (typeof dataRaw !== 'string') {
    return malformed(index, 'Interaction calldata must be a hex string');
  }

  // Preserve original casing only for the leading selector probe; body checks
  // use lowercase hex so length/padding rules are case-insensitive.
  const trimmed = dataRaw.trim();
  if (trimmed === '' || trimmed === '0x' || trimmed === '0X') {
    return { ok: true, intent: null };
  }
  if (!trimmed.startsWith('0x') && !trimmed.startsWith('0X')) {
    // Not hex-prefixed calldata — out of scope for destination intents.
    return { ok: true, intent: null };
  }

  // Incomplete selector (0x + fewer than 8 hex chars) is out of scope, not malformed.
  if (trimmed.length < 10) {
    return { ok: true, intent: null };
  }

  const selector = trimmed.slice(0, 10).toLowerCase();
  const isKnownTransfer =
    selector === ERC20_TRANSFER_SELECTOR || selector === ERC20_TRANSFER_FROM_SELECTOR;

  // Resolve interaction.to with the same 20-byte hex acceptance as SendTransactionDto
  // (case-insensitive; not EIP-55 strict). Known direct-transfer selectors cannot
  // silently skip destination policy when `to` is unparseable.
  const contract = normalizeAddress(interaction.to);
  if (isKnownTransfer && !contract) {
    return malformed(index, `Interaction ${index + 1}: transfer target address is invalid`);
  }
  if (!contract) {
    // Unknown selector + unusable to: out of scope (DTO usually rejects earlier).
    return { ok: true, intent: null };
  }

  if (isKnownTransfer) {
    // Known transfer selector: any non-canonical remainder is malformed (400).
    // Covers non-hex body, odd nibble length, truncation, and trailing bytes.
    const body = trimmed.slice(2).toLowerCase();
    if (!/^[0-9a-f]*$/.test(body) || body.length % 2 !== 0) {
      return malformed(
        index,
        `Interaction ${index + 1}: ${
          selector === ERC20_TRANSFER_SELECTOR ? 'transfer' : 'transferFrom'
        } calldata is not valid hex`,
      );
    }
    const data = `0x${body}`;
    if (selector === ERC20_TRANSFER_SELECTOR) {
      return parseTransfer(data, index, owner, contract);
    }
    return parseTransferFrom(data, index, owner, contract);
  }

  // Unknown / incomplete-as-unknown selectors: no destination intent.
  return { ok: true, intent: null };
}

function parseTransfer(
  data: string,
  index: number,
  owner: string,
  contract: string,
): { ok: true; intent: DirectTransferIntent | null } | DirectTransferExtractErr {
  if (data.length !== TRANSFER_HEX_LEN) {
    return malformed(
      index,
      `Interaction ${index + 1}: transfer(address,uint256) calldata has invalid length`,
    );
  }

  const toWord = data.slice(10, 74);
  const amountWord = data.slice(74, 138);
  if (!isStrictAddressWord(toWord) || !isStrictUintWord(amountWord)) {
    return malformed(
      index,
      `Interaction ${index + 1}: transfer(address,uint256) calldata has invalid word encoding`,
    );
  }

  const recipient = wordToAddress(toWord);
  if (!recipient) {
    return malformed(index, `Interaction ${index + 1}: transfer recipient address is invalid`);
  }

  // Self-transfer: no destination policy.
  if (recipient === owner) {
    return { ok: true, intent: null };
  }

  return {
    ok: true,
    intent: {
      kind: 'erc20_transfer',
      recipient,
      interactionIndex: index,
      contract,
    },
  };
}

function parseTransferFrom(
  data: string,
  index: number,
  owner: string,
  contract: string,
): { ok: true; intent: DirectTransferIntent | null } | DirectTransferExtractErr {
  if (data.length !== TRANSFER_FROM_HEX_LEN) {
    return malformed(
      index,
      `Interaction ${index + 1}: transferFrom(address,address,uint256) calldata has invalid length`,
    );
  }

  const fromWord = data.slice(10, 74);
  const toWord = data.slice(74, 138);
  const amountWord = data.slice(138, 202);
  if (
    !isStrictAddressWord(fromWord) ||
    !isStrictAddressWord(toWord) ||
    !isStrictUintWord(amountWord)
  ) {
    return malformed(
      index,
      `Interaction ${index + 1}: transferFrom(address,address,uint256) calldata has invalid word encoding`,
    );
  }

  const from = wordToAddress(fromWord);
  const recipient = wordToAddress(toWord);
  if (!from || !recipient) {
    return malformed(index, `Interaction ${index + 1}: transferFrom address argument is invalid`);
  }

  // Only execution-owner-sourced transferFrom is treated as direct egress.
  // (Conservative for NFT-shared selector: still policy the recipient.)
  if (from !== owner) {
    return { ok: true, intent: null };
  }

  if (recipient === owner) {
    return { ok: true, intent: null };
  }

  return {
    ok: true,
    intent: {
      kind: 'erc20_transfer_from',
      recipient,
      interactionIndex: index,
      contract,
    },
  };
}

/** Address ABI word: 12 leading zero bytes + 20-byte address. */
function isStrictAddressWord(word: string): boolean {
  if (word.length !== 64 || !/^[0-9a-f]{64}$/.test(word)) return false;
  return word.slice(0, 24) === '000000000000000000000000';
}

function isStrictUintWord(word: string): boolean {
  return word.length === 64 && /^[0-9a-f]{64}$/.test(word);
}

function wordToAddress(word: string): string | null {
  const hex = `0x${word.slice(24)}`;
  return normalizeAddress(hex);
}

/**
 * Accept any 20-byte hex address the DTO allows (case-insensitive, not EIP-55
 * checksum-strict). Canonicalize to lowercase checksum via getAddress after a
 * non-strict isAddress check so mixed-case non-checksum forms still parse.
 */
function normalizeAddress(address: string): string | null {
  if (!address || typeof address !== 'string') return null;
  const trimmed = address.trim();
  // Match InteractionDto: 0x + 40 hex digits (any case).
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return null;
  if (!isAddress(trimmed, { strict: false })) return null;
  try {
    // getAddress accepts non-checksum mixed-case when isAddress(strict:false) passed.
    return getAddress(trimmed).toLowerCase();
  } catch {
    // Last resort: lowercase the hex body (safe once regex + isAddress passed).
    return `0x${trimmed.slice(2).toLowerCase()}`;
  }
}

function malformed(interactionIndex: number, message: string): DirectTransferExtractErr {
  return {
    ok: false,
    code: 'malformed_direct_transfer',
    message,
    interactionIndex,
  };
}
