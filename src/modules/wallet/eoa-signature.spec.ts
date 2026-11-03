import { recoverAddress } from 'viem';
import { normalizeEoaSignature } from './eoa-signature';

// Public SDK golden vector; no provider credentials or private key required.
const rs = '0x5003cfe77edce84164f4637ecf8d8617d796e7b00ba89e45b0033bca19f9c27e7a0ec44704aa98042a55c5d9262bccd0ce02a1a4186c9420daaa360ab80591e6';
const hash = '0x3167778c1760864922d4150ea0f51e408db4f61ce8585d5ddde8194dd33b7eef';

describe('EOA signature output format', () => {
  it.each([
    ['00', '1b', '0xdace8d253148e0d7ce0ca418c68509d8709bcc32'],
    ['01', '1c', '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'],
    ['1b', '1b', '0xdace8d253148e0d7ce0ca418c68509d8709bcc32'],
    ['1c', '1c', '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'],
  ])('canonicalizes v=%s without changing signer', async (input, canonical, signer) => {
    const signature = normalizeEoaSignature(`${rs}${input}`);
    expect(signature).toBe(`${rs}${canonical}`);
    expect((await recoverAddress({ hash, signature })).toLowerCase()).toBe(signer);
  });

  it('rejects every unsupported recovery byte', () => {
    for (let v = 0; v < 256; v++) {
      if ([0, 1, 27, 28].includes(v)) continue;
      expect(() => normalizeEoaSignature(`${rs}${v.toString(16).padStart(2, '0')}`)).toThrow('Invalid EOA signature recovery value');
    }
  });

  it.each(['0x1234', `${rs}1b00`, `${rs}zz`, `0x${'gg'.repeat(64)}1b`, `${rs.slice(2)}1b`])('rejects malformed signature %s', signature => {
    expect(() => normalizeEoaSignature(signature)).toThrow('Expected a 65-byte EOA signature');
  });
});
