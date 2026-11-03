import { isAddress, parseAbiItem, toFunctionSelector } from 'viem';

type Evidence = Readonly<{ sourceRef: string; verifiedAt: string; chainId: number; address: string }>;
export type AbiInventoryInput = Readonly<{
  chainId: number;
  address: string;
  protocol: string;
  deploymentEvidence: Evidence;
  abiEvidence: Evidence;
  abi: readonly unknown[];
}>;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function canonicalType(input: Record<string, unknown>, label: string): string {
  if (typeof input.type !== 'string') throw new Error(`${label}.type must be a string`);
  if (!input.type.startsWith('tuple')) return input.type;
  if (!Array.isArray(input.components)) throw new Error(`${label}.components must be an array for tuple types`);
  return `(${input.components.map((child, index) => canonicalType(object(child, `${label}.components[${index}]`), `${label}.components[${index}]`)).join(',')})${input.type.slice(5)}`;
}

function cleanParam(value: unknown, label: string): Record<string, unknown> {
  const param = object(value, label);
  if (typeof param.name !== 'string' || typeof param.type !== 'string') throw new Error(`${label} must have string name and type`);
  const unexpected = Object.keys(param).filter((key) => !['name', 'type', 'components', 'internalType'].includes(key));
  if (unexpected.length) throw new Error(`${label} contains unsupported fields: ${unexpected.join(', ')}`);
  if (param.internalType !== undefined && typeof param.internalType !== 'string') throw new Error(`${label}.internalType must be a string`);
  const cleaned: Record<string, unknown> = { name: param.name, type: param.type };
  if (param.internalType !== undefined) cleaned.internalType = param.internalType;
  if (param.components !== undefined) {
    if (!Array.isArray(param.components)) throw new Error(`${label}.components must be an array`);
    cleaned.components = param.components.map((child, index) => cleanParam(child, `${label}.components[${index}]`));
  }
  return cleaned;
}

function evidence(value: unknown, label: string, chainId: number, address: string): Evidence {
  const item = object(value, label);
  if (typeof item.sourceRef !== 'string' || !item.sourceRef.trim()) throw new Error(`${label}.sourceRef is required`);
  if (item.chainId !== chainId || typeof item.chainId !== 'number') throw new Error(`${label}.chainId must match the inventory chainId`);
  if (typeof item.address !== 'string' || item.address.toLowerCase() !== address.toLowerCase()) throw new Error(`${label}.address must match the inventory address`);
  if (typeof item.verifiedAt !== 'string' || !Number.isFinite(Date.parse(item.verifiedAt))) throw new Error(`${label}.verifiedAt must be a valid date`);
  return item as unknown as Evidence;
}

/** Enumerate an ABI into schema-v1, always-inactive catalog function drafts. */
export function inventoryAbi(input: unknown): { schemaVersion: 1; chains: unknown[] } {
  const value = object(input, 'Inventory input');
  if (!Number.isSafeInteger(value.chainId) || (value.chainId as number) <= 0) throw new Error('chainId must be a positive safe integer');
  if (typeof value.address !== 'string' || !isAddress(value.address)) throw new Error('address must be a valid EVM address');
  if (typeof value.protocol !== 'string' || !value.protocol.trim()) throw new Error('protocol is required');
  const protocol = value.protocol.trim();
  if (!Array.isArray(value.abi)) throw new Error('abi must be an array');
  const chainId = value.chainId as number;
  const address = value.address;
  const deployment = evidence(value.deploymentEvidence, 'deploymentEvidence', chainId, address);
  const abiEvidence = evidence(value.abiEvidence, 'abiEvidence', chainId, address);
  const selectors = new Map<string, string>();
  const seen = new Set<string>();
  const functions: Record<string, unknown>[] = [];

  value.abi.forEach((entry, index) => {
    const item = object(entry, `abi[${index}]`);
    if (item.type !== 'function') return;
    if (typeof item.name !== 'string' || !Array.isArray(item.inputs) || !Array.isArray(item.outputs)
      || !['pure', 'view', 'nonpayable', 'payable'].includes(String(item.stateMutability))) {
      throw new Error(`abi[${index}] is a malformed function entry`);
    }
    const inputs = item.inputs.map((param, paramIndex) => cleanParam(param, `abi[${index}].inputs[${paramIndex}]`));
    const outputs = item.outputs.map((param, paramIndex) => cleanParam(param, `abi[${index}].outputs[${paramIndex}]`));
    const inputTypes = inputs.map((param, paramIndex) => canonicalType(param, `abi[${index}].inputs[${paramIndex}]`));
    const outputTypes = outputs.map((param, paramIndex) => canonicalType(param, `abi[${index}].outputs[${paramIndex}]`));
    const signature = `${item.name}(${inputTypes.join(',')})`;
    const selector = toFunctionSelector(parseAbiItem(`function ${signature}`) as never).toLowerCase();
    if (seen.has(signature)) throw new Error(`Duplicate ABI function signature: ${signature}`);
    seen.add(signature);
    const collision = selectors.get(selector);
    if (collision) throw new Error(`ABI selector collision: ${collision} and ${signature} (${selector})`);
    selectors.set(selector, signature);
    // Parse the full declaration to validate types and retain output/mutability semantics;
    // use the source ABI fragment itself so argument names and tuple components are retained.
    const full = parseAbiItem(`function ${signature} ${item.stateMutability}${outputTypes.length ? ` returns (${outputTypes.join(',')})` : ''}`) as Record<string, unknown>;
    const abi = {
      ...full,
      inputs,
      outputs,
    };
    const protocolSlug = protocol.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
    const capabilityId = `${protocolSlug || 'protocol'}:inventory:v1:${chainId}:${address.toLowerCase()}:${selector.slice(2)}`;
    functions.push({
      capabilityId, type: 'contract_call', chainId, contract: address,
      functionName: item.name, signature, abi, status: 'inactive',
      provenance: { sourceRef: `deployment: ${deployment.sourceRef}; ABI: ${abiEvidence.sourceRef}`, verifiedAt: deployment.verifiedAt > abiEvidence.verifiedAt ? deployment.verifiedAt : abiEvidence.verifiedAt, status: 'candidate' },
      protocol,
      label: `${protocol} ${item.name}`,
      description: `Unreviewed ABI inventory draft for ${signature}. ABI enumeration is not execution-safety review.`,
      inactiveReason: 'ABI inventory draft: requires explicit per-function security and execution review before activation.',
    });
  });

  return { schemaVersion: 1, chains: [{ chainId, status: 'inactive', contracts: [{ address, status: 'inactive', functions }] }] };
}
