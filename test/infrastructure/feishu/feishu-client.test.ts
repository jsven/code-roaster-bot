import { describe, expect, it, vi } from 'vitest';
import { FeishuClient } from '../../../src/infrastructure/feishu/feishu-client.js';

describe('FeishuClient', () => {
  it('sends a signed summary message to a custom bot webhook', async () => {
    const fetcher = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.msg_type).toBe('text');
      expect(body.content.text).toContain('group/demo');
      expect(body.timestamp).toMatch(/^\d+$/);
      expect(body.sign).toEqual(expect.any(String));
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    });
    const client = new FeishuClient({ enabled: true, webhookUrl: 'https://open.feishu.cn/hook', secret: 'secret', timeoutMs: 1000 }, fetcher);
    await expect(client.sendSummary({ repository: 'group/demo', mrUrl: 'https://gitlab/mr/7', author: 'alice', high: 1, medium: 2, low: 0 })).resolves.toBeUndefined();
  });

  it('does not send when disabled', async () => {
    const fetcher = vi.fn();
    const client = new FeishuClient({ enabled: false, timeoutMs: 1000 }, fetcher);
    await client.sendSummary({ repository: 'group/demo', mrUrl: 'url', author: 'alice', high: 0, medium: 0, low: 1 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
