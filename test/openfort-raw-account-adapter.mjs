#!/usr/bin/env node
import assert from 'node:assert/strict';
import axios from 'axios';
import Openfort, { getAccountsV2 } from '@openfort/openfort-node';

// Configure the actual SDK client, but route its request through an in-memory adapter.
const rawAccounts = [
  { id: 'acc_valid_123', chainType: 'EVM', custody: 'Developer', address: '0x1111111111111111111111111111111111111111' },
  { id: 'acc_wrong_chain', chainType: 'SOLANA', custody: 'Developer', address: '0x2222222222222222222222222222222222222222' },
  { id: 'acc_wrong_custody', chainType: 'EVM', custody: 'User', address: '0x3333333333333333333333333333333333333333' },
  { id: 'acc_bad_address', chainType: 'EVM', custody: 'Developer', address: 'not-an-address' },
];
const originalAdapter = axios.defaults.adapter;
let seen;
axios.defaults.adapter = async (config) => {
  assert.equal(config.baseURL, 'http://openfort-sdk.test');
  assert.equal(config.url, '/v2/accounts');
  assert.equal(config.method, 'get');
  seen = config.params;
  return { data: { data: rawAccounts, total: rawAccounts.length }, status: 200, statusText: 'OK', headers: {}, config };
};

try {
  // Instantiation exercises the installed SDK's real client constructor/configuration.
  new Openfort('sk_test_adapter_only', { basePath: 'http://openfort-sdk.test' });
  const response = await getAccountsV2({ chainType: 'EVM', custody: 'Developer', limit: 100, skip: 0 });
  assert.deepEqual(seen, { chainType: 'EVM', custody: 'Developer', limit: 100, skip: 0 });
  assert.deepEqual(response, { data: rawAccounts, total: 4 });
  assert.deepEqual(Object.keys(response.data[0]).sort(), ['address', 'chainType', 'custody', 'id']);

  // Mirrors recovery's exact-ID selection and bindProvisionedAccount identity checks.
  const find = (id) => {
    const matches = response.data.filter((account) => account?.id === id);
    assert.equal(matches.length, 1, 'account ID must occur exactly once');
    return matches[0];
  };
  const valid = find('acc_valid_123');
  assert.equal(valid.chainType, 'EVM');
  assert.equal(valid.custody, 'Developer');
  assert.match(valid.address, /^0x[0-9a-fA-F]{40}$/);
  assert.throws(() => find('missing-account'), /exactly once/);
  assert.throws(() => { if (find('acc_wrong_chain').chainType !== 'EVM') throw Error('wrong chain'); }, /wrong chain/);
  assert.throws(() => { if (find('acc_wrong_custody').custody !== 'Developer') throw Error('wrong custody'); }, /wrong custody/);
  assert.throws(() => { if (find('acc_valid_123').id !== 'different-id') throw Error('ID mismatch'); }, /ID mismatch/);
  assert.throws(() => { if (!/^0x[0-9a-fA-F]{40}$/.test(find('acc_bad_address').address)) throw Error('invalid address'); }, /invalid address/);
  assert.notEqual(valid.address.toLowerCase(), '0x4444444444444444444444444444444444444444');
  console.log('Openfort SDK raw-account adapter checks passed (no network requests).');
} finally {
  axios.defaults.adapter = originalAdapter;
}
