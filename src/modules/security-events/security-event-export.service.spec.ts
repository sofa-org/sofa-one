import { SecurityEventExportService } from './security-event-export.service';

describe('SecurityEventExportService', () => {
  const originalEnv = process.env;
  const fetchMock = jest.fn();
  let service: SecurityEventExportService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.SECURITY_EVENTS_SIEM_WEBHOOK_URL;
    delete process.env.SECURITY_EVENTS_SIEM_WEBHOOK_SECRET;
    global.fetch = fetchMock as never;
    service = new SecurityEventExportService();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('does nothing when SIEM webhook is not configured', async () => {
    await service.exportSecurityEvent({ id: 'event-1', eventType: 'api_key.created' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts a safe security-event payload to the configured SIEM webhook', async () => {
    process.env.SECURITY_EVENTS_SIEM_WEBHOOK_URL = 'https://siem.example.com/events';
    process.env.SECURITY_EVENTS_SIEM_WEBHOOK_SECRET = 'siem-secret';
    fetchMock.mockResolvedValue({ ok: true });

    await service.exportSecurityEvent({
      id: 'event-2',
      actorType: 'api_key',
      userId: 'user-1',
      apiKeyId: 'key-1',
      walletId: 'wallet-1',
      eventType: 'transaction.policy_denied',
      riskLevel: 'high',
      result: 'denied',
      reason: 'blocked_selector',
      requestId: 'req-1',
      ip: '203.0.113.10',
      userAgent: 'agent',
      createdAt: new Date('2026-05-29T00:00:00.000Z'),
      metadata: {
        selector: '0xd505accf',
        calldata: `0x${'ab'.repeat(64)}`,
        nested: { token: 'secret-token', url: 'https://internal.example.local/path' },
      },
    });

    expect(fetchMock).toHaveBeenCalledWith('https://siem.example.com/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'sofa-one-security-events/1.0',
        Authorization: 'Bearer siem-secret',
      },
      body: expect.any(String),
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, any>;
    expect(body).toEqual(
      expect.objectContaining({
        type: 'security_event',
        id: 'event-2',
        createdAt: '2026-05-29T00:00:00.000Z',
        eventType: 'transaction.policy_denied',
        riskLevel: 'high',
      }),
    );
    expect(body.metadata.calldata).toBe('[redacted]');
    expect(body.metadata.nested.token).toBe('[redacted]');
    expect(JSON.stringify(body)).not.toContain('ab'.repeat(64));
    expect(JSON.stringify(body)).not.toContain('https://internal.example.local');
  });

  it('logs but does not throw when SIEM delivery fails', async () => {
    process.env.SECURITY_EVENTS_SIEM_WEBHOOK_URL = 'https://siem.example.com/events';
    fetchMock.mockResolvedValue({ ok: false, status: 502 });
    const errorSpy = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);

    await expect(
      service.exportSecurityEvent({ id: 'event-3', eventType: 'api_key_frozen' }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      'SecurityEvent SIEM webhook returned 502: eventType=api_key_frozen, eventId=event-3',
    );
  });
});
