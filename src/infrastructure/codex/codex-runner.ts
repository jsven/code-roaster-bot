import type { CodexPort } from '../../application/ports.js';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { CodexApprovalPolicy, CodexReasoningEffort, CodexSandbox } from '../../config/config.js';

export interface CodexRunnerConfig {
  command: string;
  args: string[];
  model?: string;
  apiKey?: string;
  apiBaseUrl?: string;
  reasoningEffort?: CodexReasoningEffort;
  sandbox?: CodexSandbox;
  approvalPolicy?: CodexApprovalPolicy;
  profile?: string;
  ephemeral?: boolean;
  outputSchema?: string;
  promptFile: string;
  timeoutMs: number;
  maxOutputBytes: number;
  isolatedEnvironment?: boolean;
  configDirectory?: string;
}

export class CodexRunner implements CodexPort {
  constructor(private readonly config: CodexRunnerConfig) {}

  async run(diff: string, cwd?: string): Promise<string> {
    const prompt = await fs.readFile(this.config.promptFile, 'utf8');
    const input = `${prompt}\n\n以下是本次变更：\n\n${diff}`;
    const args = [...this.config.args];
    if (this.config.model) args.push('--model', this.config.model);
    if (this.config.reasoningEffort) args.push('--config', `model_reasoning_effort="${this.config.reasoningEffort}"`);
    if (this.config.sandbox) args.push('--sandbox', this.config.sandbox);
    if (this.config.approvalPolicy) args.push('--config', `approval_policy="${this.config.approvalPolicy}"`);
    if (this.config.profile) args.push('--profile', this.config.profile);
    if (this.config.ephemeral) args.push('--ephemeral');
    if (this.config.outputSchema) args.push('--output-schema', this.config.outputSchema);
    const env: NodeJS.ProcessEnv = this.config.isolatedEnvironment
      ? Object.fromEntries(Object.entries(process.env).filter(([name]) => [
        'PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'CODEX_HOME',
        'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
        'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
        'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
      ].includes(name)))
      : { ...process.env };
    if (this.config.configDirectory) env.CODEX_HOME = this.config.configDirectory;
    if (this.config.apiKey) {
      // Use explicit API credentials instead of inheriting a desktop login or provider.
      // The key is passed only through the environment, never command-line arguments.
      env.CODE_REVIEW_API_KEY = this.config.apiKey;
      const provider = 'model_providers.code_review';
      args.push(
        '--config', 'model_provider="code_review"',
        '--config', `${provider}.name="Code Review API"`,
        '--config', `${provider}.base_url=${JSON.stringify(this.config.apiBaseUrl ?? 'https://api.openai.com/v1')}`,
        '--config', `${provider}.env_key="CODE_REVIEW_API_KEY"`,
        '--config', `${provider}.wire_api="responses"`,
        '--config', `${provider}.requires_openai_auth=false`,
      );
    }
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.config.command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      let errorOutput = '';
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(() => reject(new Error(`codex timeout after ${this.config.timeoutMs}ms`)));
      }, this.config.timeoutMs);
      child.stdout.on('data', (chunk: Buffer | string) => {
        output += chunk.toString();
        if (Buffer.byteLength(output) > this.config.maxOutputBytes) {
          child.kill('SIGKILL');
          finish(() => reject(new Error(`codex output exceeded ${this.config.maxOutputBytes} bytes`)));
        }
      });
      child.stderr.on('data', (chunk: Buffer | string) => { errorOutput += chunk.toString(); });
      child.on('error', (error) => finish(() => reject(error)));
      child.on('close', (code) => {
        finish(() => {
          if (code !== 0) reject(new Error(`codex exit code ${code}: ${errorOutput.slice(0, 500)}`));
          else resolve(output);
        });
      });
      child.stdin.write(input);
      child.stdin.end();
    });
  }
}
