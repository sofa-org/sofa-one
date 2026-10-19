import type { AbiFunction, AbiParameter } from 'viem';
import type { DefiFunctionPolicy } from '../defi.types';
import type { DefiRegistryFragment } from '../registry/defi-manifest.types';

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

type PublicContract = { address: string; protocol: string; abi: AbiFunction[] };

function publicParameter(parameter: AbiParameter): AbiParameter {
  return {
    name: parameter.name ?? '',
    type: parameter.type,
    ...('components' in parameter ? { components: parameter.components.map(publicParameter) } : {}),
  } as AbiParameter;
}

function publicFunction(abi: AbiFunction): AbiFunction {
  return {
    type: 'function',
    name: abi.name,
    stateMutability: abi.stateMutability,
    inputs: abi.inputs.map(publicParameter),
    outputs: abi.outputs.map(publicParameter),
  };
}

/** Static reviewed metadata only; runtime grants, pauses and execution scopes still apply. */
export function renderProtocolsJson(fragment: DefiRegistryFragment): string {
  const output: Record<string, PublicContract[]> = {};
  for (const chain of [...fragment.chains].sort((left, right) => left.chainId - right.chainId)) {
    if (chain.status !== 'active') continue;
    const groups = new Map<string, { address: string; protocol: string; functions: DefiFunctionPolicy[] }>();
    for (const contract of chain.contracts) {
      if (contract.status !== 'active') continue;
      const address = contract.address.toLowerCase();
      for (const fn of contract.functions) {
        if (fn.status !== 'active' || fn.provenance.status !== 'verified' || fn.type !== 'contract_call') continue;
        if (!fn.protocol) throw new Error(`Public protocol export requires a protocol label for ${fn.capabilityId}`);
        const key = JSON.stringify([address, fn.protocol]);
        let group = groups.get(key);
        if (!group) {
          group = { address, protocol: fn.protocol, functions: [] };
          groups.set(key, group);
        }
        group.functions.push(fn);
      }
    }
    if (groups.size > 0) {
      output[String(chain.chainId)] = [...groups.values()]
        .sort((left, right) => compare(left.address, right.address) || compare(left.protocol, right.protocol))
        .map(({ address, protocol, functions }) => ({
          address,
          protocol,
          abi: functions.sort((left, right) => compare(left.signature, right.signature)).map((fn) => publicFunction(fn.abi)),
        }));
    }
  }
  return `${JSON.stringify(output, null, 2)}\n`;
}
