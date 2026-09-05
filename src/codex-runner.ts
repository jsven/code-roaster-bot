import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { CodexApprovalPolicy, CodexReasoningEffort, CodexSandbox } from './config.js';

export interface CodexRunnerConfig {
  command: string;
  args: string[];
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  sandbox?: CodexSandbox;
  approvalPolicy?: CodexApprovalPolicy;
  profile?: string;
  ephemeral?: boolean;
  outputSchema?: string;
  promptFile: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export class CodexRunner {
  constructor(private readonly config: CodexRunnerConfig) {}

  async run(diff: string, cwd?: string): Promise<string> {
    const prompt = await fs.readFile(this.config.promptFile, 'utf8');
    const input = `${prompt}\n\n以下是本次变更：\n\n${diff}`;
    const args = [...this.config.args];
    if (this.config.model) args.push('--model', this.config.model);
    if (this.config.reasoningEffort) args.push('--config', `model_reasoning_effort="${this.config.reasoningEffort}"`);
    if (this.config.sandbox) args.push('--sandbox', this.config.sandbox);
    if (this.config.approvalPolicy) args.push('--ask-for-approval', this.config.approvalPolicy);
    if (this.config.profile) args.push('--profile', this.config.profile);
    if (this.config.ephemeral) args.push('--ephemeral');
    if (this.config.outputSchema) args.push('--output-schema', this.config.outputSchema);
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.config.command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
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
