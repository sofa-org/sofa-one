import { BadRequestException } from '@nestjs/common';
import { parseCapabilityIds } from './capability-query';
import { DefiCapabilityQueryController } from './defi-capability-query.controller';
import { ApiKeyAuthGuard } from '../../common/guards/api-key-auth.guard';
import { GUARDS_METADATA } from '@nestjs/common/constants';

describe('parseCapabilityIds', () => {
  it.each([
    undefined,
    '',
    ',x',
    'x,,y',
    'x,x',
    `${'a'.repeat(257)}`,
    Array(101).fill('id').join(','),
    ['x'],
  ])('rejects invalid IDs input', (input) => {
    expect(() => parseCapabilityIds(input)).toThrow(BadRequestException);
  });

  it('accepts 100 arbitrary catalog IDs in order after trimming', () => {
    const ids = Array.from({ length: 100 }, (_, index) => `catalog-id:${index}`);
    expect(parseCapabilityIds(` ${ids.join(' , ')} `)).toEqual(ids);
  });
});

describe('DefiCapabilityQueryController', () => {
  it('uses only API key authentication and delegates validated IDs with no-store', async () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, DefiCapabilityQueryController)).toEqual([
      ApiKeyAuthGuard,
    ]);
    const result = { capabilities: [{ capabilityId: 'x', status: 'paused' }], unknownIds: [] };
    const catalog = { listMetadataByIds: jest.fn().mockResolvedValue(result) };
    const response = { setHeader: jest.fn() };
    await expect(
      new DefiCapabilityQueryController(catalog as any).getCapabilities(' x ', response),
    ).resolves.toBe(result);
    expect(catalog.listMetadataByIds).toHaveBeenCalledWith(['x']);
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });
});
