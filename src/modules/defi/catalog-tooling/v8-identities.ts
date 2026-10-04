import { createEnsoStaticWeirollScope } from '../execution/enso-identity';

export const V8_ASSEMBLY_PLAN_PATH = 'data/defi-catalog/v8/assembly-plan.json' as const;
export const V8_SOURCE_PATHS = Object.freeze(['data/defi-catalog/v8/sources/enso.json'] as const);
export const V8_BASELINE_PATH = 'data/defi-catalog/v7/catalog.json' as const;
export const V8_BASELINE_RAW_SHA256 = '498c1c0d564472f2e585fba0ed3d46372f5f08e205f3e429163b7a1d9bedc570' as const;
export const V8_BASELINE_MANIFEST_HASH = '0x32baaa989d966a12bf1b38f95d7bdc859ca2779b495ae27abbe40f0e95381533' as const;
export const V8_SOURCE_CANONICAL_SHA256 = 'e497e4e31b7f82990e966c44d2a3abcf36c0a7174a15f8f100098094fdd2b7de' as const;

export const V8_ROOT_IDENTITY = Object.freeze({
  sourcePath: V8_SOURCE_PATHS[0],
  familyId: 'enso',
  familyVersion: 'router-static-weiroll-v1@c032c8f9',
  chainId: 1,
  contract: '0xf75584ef6673ad213a685a1b58cc0330b8ea22cf',
  contractName: 'Enso Router (Ethereum)',
  functionName: 'routeSingle',
  signature: 'routeSingle((uint8,bytes),bytes)',
  selector: '0xb94c3609',
  capabilityId: 'enso:router-static-weiroll-v1:1:0xf75584ef6673ad213a685a1b58cc0330b8ea22cf:route-single',
  abiHash: '0xe3045106c2f667460faa9d5d67104b5f7f70c24186421cf1dbc7a2f03624c5c9',
  sourceRefs: Object.freeze([
    'enso-router-full-verified-abi',
    'enso-router-verified-source',
    'enso-pinned-weiroll-vm',
    'enso-pinned-command-builder',
    'enso-router-deployment-record',
  ]),
  sourceRef: 'enso-router-full-verified-abi',
  executionScope: createEnsoStaticWeirollScope(),
  executionScopeHash: '0xf55170b87634460f24a5f4ced30d21b134bf950327078b5f31e0bfe2074959e5',
});
