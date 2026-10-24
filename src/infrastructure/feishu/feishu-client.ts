import type { FeishuSummary, FeishuPort } from '../../application/ports.js';
import crypto from 'node:crypto';

export interface FeishuConfig {
  enabled: boolean;
  webhookUrl?: string;
  secret?: string;
  timeoutMs: number;
}

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class FeishuClient implements FeishuPort {
  readonly enabled: boolean;

  constructor(private readonly config: FeishuConfig, private readonly fetcher: Fetcher = fetch) {
    this.enabled = config.enabled;
  }

  async sendSummary(summary: FeishuSummary): Promise<void> {
    if (!this.config.enabled) return;
    if (!this.config.webhookUrl) throw new Error('Feishu webhook URL is missing');
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const body: Record<string, unknown> = {
      msg_type: 'text',
      content: {
        text: [
          '代码审核发现中高风险问题',
          `仓库：${summary.repository}`,
          `发起人：${summary.author}`,
          `风险统计：高 ${summary.high} · 中 ${summary.medium} · 低 ${summary.low}`,
          `MR：${summary.mrUrl}`,
        ].join('\n'),
      },
    };
    if (this.config.secret) {
      body.timestamp = timestamp;
      body.sign = crypto.createHmac('sha256', `${timestamp}\n${this.config.secret}`).update('').digest('base64');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetcher(this.config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Feishu HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const result = await response.json() as { code?: number; msg?: string };
      if (result.code !== undefined && result.code !== 0) throw new Error(`Feishu API ${result.code}: ${result.msg ?? 'unknown error'}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
