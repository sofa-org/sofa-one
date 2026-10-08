import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateApiKeyDto, PatchApiKeyCapabilitiesDto } from './create-api-key.dto';

describe('CreateApiKeyDto', () => {
  const validateDto = (input: Record<string, unknown>) => validate(plainToInstance(CreateApiKeyDto, input));

  it('trims name and accepts it after trim', async () => {
    const dto = plainToInstance(CreateApiKeyDto, { name: '  My API Key  ' });

    expect(dto.name).toBe('My API Key');

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('rejects blank and whitespace-only names', async () => {
    const errors = await validateDto({ name: '   ' });

    expect(errors.some((error) => error.property === 'name')).toBe(true);
  });

  it('requires expiresAt to be ISO8601 when present', async () => {
    const errors = await validateDto({ name: 'Valid key', expiresAt: 'not-an-iso-date' });

    expect(errors.some((error) => error.property === 'expiresAt')).toBe(true);
  });

  it('accepts IPv4, IPv6, and CIDR allowedIps entries', async () => {
    const errors = await validateDto({
      name: 'Valid key',
      allowedIps: ['192.168.1.10', '10.0.0.0/24', '2001:db8::1', '2001:db8::/64'],
    });

    expect(errors).toHaveLength(0);
  });

  it('rejects invalid allowedIps values', async () => {
    const invalidValues = [
      ['10.0.0.0/24extra'],
      ['2001:db8::/129'],
      ['not-an-ip'],
    ];

    for (const allowedIps of invalidValues) {
      const errors = await validateDto({ name: 'Valid key', allowedIps });

      expect(errors.some((error) => error.property === 'allowedIps')).toBe(true);
    }
  });

  it('accepts boolean permissions', async () => {
    const errors = await validateDto({
      name: 'Valid key',
      permissions: { canSign: true, canSendTransaction: false, canReadTransactionStatus: true },
    });

    expect(errors).toHaveLength(0);
  });

  it('rejects non-boolean permissions', async () => {
    const errors = await validateDto({
      name: 'Valid key',
      permissions: { canSign: 'yes' },
    });

    expect(errors.some((error) => error.property === 'permissions')).toBe(true);
  });

  it('accepts grant lists larger than 100 and rejects null/invalid grant lists', async () => {
    expect(await validateDto({ name: 'Valid', allowedCapabilityIds: ['cap:a:v1'] })).toHaveLength(0);
    expect(await validateDto({ name: 'Valid', allowedCapabilityIds: Array.from({ length: 101 }, (_, index) => `cap:${index}:v1`) })).toHaveLength(0);
    for (const allowedCapabilityIds of [null, [''], ['x'.repeat(161)], ['x', 'x']]) {
      const errors = await validateDto({ name: 'Valid', allowedCapabilityIds: allowedCapabilityIds as any });
      expect(errors.some((error) => error.property === 'allowedCapabilityIds')).toBe(true);
    }
  });

  it('validates create all/custom pair rules and omitted-versus-null fields', async () => {
    for (const input of [
      { name: 'a' }, { name: 'a', capabilityMode: 'all' },
      { name: 'a', capabilityMode: 'all', allowedCapabilityIds: [] },
      { name: 'a', capabilityMode: 'custom', allowedCapabilityIds: [] },
      { name: 'a', allowedCapabilityIds: [] },
    ]) expect(await validateDto(input)).toHaveLength(0);
    for (const input of [
      { name: 'a', capabilityMode: null }, { name: 'a', capabilityMode: 'future' },
      { name: 'a', capabilityMode: 'custom' }, { name: 'a', capabilityMode: 'all', allowedCapabilityIds: ['x'] },
      { name: 'a', allowedCapabilityIds: null },
    ]) expect(await validateDto(input as any)).not.toHaveLength(0);
  });

  it('validates PATCH full-replacement semantics and requires at least one field', async () => {
    const validatePatch = (input: Record<string, unknown>) => validate(plainToInstance(PatchApiKeyCapabilitiesDto, input));
    for (const input of [{ allowedCapabilityIds: [] }, { capabilityMode: 'all' }, { capabilityMode: 'custom', allowedCapabilityIds: [] }]) expect(await validatePatch(input)).toHaveLength(0);
    for (const input of [{}, { capabilityMode: null }, { capabilityMode: 'future' }, { capabilityMode: 'custom' }, { capabilityMode: 'all', allowedCapabilityIds: ['x'] }, { allowedCapabilityIds: null }]) expect(await validatePatch(input as any)).not.toHaveLength(0);
  });

  it('does not accept removed legacy grant arrays', async () => {
    const errors = await validate(plainToInstance(CreateApiKeyDto, { name: 'Valid', allowedContracts: [], allowedFunctionSelectors: [] }), { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.map((error) => error.property)).toEqual(expect.arrayContaining(['allowedContracts', 'allowedFunctionSelectors']));
  });
});
