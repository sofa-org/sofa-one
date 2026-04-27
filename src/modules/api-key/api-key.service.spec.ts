import * as argon2 from 'argon2';
import { ApiKeyService } from './api-key.service';
import { API_KEY_PREFIX_LENGTH } from '../../common/api-key/api-key-prefix';

jest.mock('argon2', () => ({
  argon2id: 2,
  hash: jest.fn(),
}));

describe('ApiKeyService', () => {
  const prisma = {
    apiKey: {
      count: jest.fn(),
      create: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.apiKey.count.mockResolvedValue(0);
    jest.mocked(argon2.hash).mockResolvedValue('argon2-hash' as never);
  });

  it('stores a 27-character prefix for newly generated API keys', async () => {
    prisma.apiKey.create.mockImplementation(async ({ data }) => ({
      id: 'key-1',
      ...data,
      createdAt: new Date('2026-04-27T00:00:00.000Z'),
    }));
    const service = new ApiKeyService(prisma as any);

    const result = await service.createApiKey('user-1', 'Production key');

    expect(result.rawKey).toMatch(/^sk_[a-f0-9]{64}$/);
    expect(result.keyPrefix).toHaveLength(API_KEY_PREFIX_LENGTH);
    expect(result.keyPrefix).toBe(result.rawKey.substring(0, API_KEY_PREFIX_LENGTH));
    expect(prisma.apiKey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          keyPrefix: result.keyPrefix,
          apiKeyHash: 'argon2-hash',
        }),
      }),
    );
  });
});
