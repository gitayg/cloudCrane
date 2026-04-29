import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { parseLine } from './streamJsonParser.js';
import log from '../../utils/logger.js';

const CODER_MODEL   = process.env.APPSTUDIO_CODER_MODEL || 'claude-sonnet-4-6';
const CODER_TIMEOUT = parseInt(process.env.CODER_TIMEOUT_MS || '1800000', 10);

/**
 * Run `docker exec` with Claude Code inside the coder container.
 * Emits: 'data' (StreamEvent), 'result' (tokens/cost), 'error' (Error), 'exit' (code)
 *
 * Call stop() to kill the process group (not just the exec wrapper).
 */
export class ClaudeRunner extends EventEmitter {
  constructor({ containerId, workspaceDir, prompt, apiKeyPath }) {
    super();
    this._containerId   = containerId;
    this._workspaceDir  = workspaceDir;
    this._prompt        = prompt;
    this._apiKeyPath    = apiKeyPath;
    this._child         = null;
    this._stopped       = false;
    this._timer         = null;
  }

  start() {
    const args = [
      'exec', '-i',
      '--workdir', '/workspace',
      '-e', `ANTHROPIC_API_KEY_FILE=${this._apiKeyPath}`,
      '-e', `HOME=/home/studio`,
      this._containerId,
      'sh', '-c',
      `ANTHROPIC_API_KEY=$(cat ${this._apiKeyPath}) claude -p ${shellQuote(this._prompt)} --model ${CODER_MODEL} --dangerously-skip-permissions --output-format stream-json --verbose --add-dir /workspace`,
    ];

    // detached: true gives us a process group leader so we can kill the whole group
    this._child = spawn('docker', args, { stdio: 'pipe', detached: true });

    this._timer = setTimeout(() => {
      this.stop();
      this.emit('error', new Error('Coder timed out'));
    }, CODER_TIMEOUT);

    let buf = '';
    this._child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete line
      for (const line of lines) {
        const ev = parseLine(line);
        if (!ev) continue;
        if (ev.type === 'result') {
          this.emit('result', ev);
        } else if (ev.type !== 'system') {
          this.emit('data', ev);
        }
      }
    });

    this._child.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) log.debug(`[coder] stderr: ${text}`);
    });

    this._child.on('error', (err) => {
      clearTimeout(this._timer);
      this.emit('error', err);
    });

    this._child.on('close', (code) => {
      clearTimeout(this._timer);
      if (!this._stopped) {
        this.emit('exit', code);
      }
    });

    // Unref so the process doesn't block Node exit if parent dies
    this._child.unref();
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._timer);
    if (this._child?.pid) {
      try {
        // Kill process group (negative PID) to catch grandchildren
        process.kill(-this._child.pid, 'SIGTERM');
      } catch (_) {}
    }
  }
}

function shellQuote(str) {
  // Single-quote the prompt for the sh -c wrapper, escaping any single quotes inside
  return "'" + str.replace(/'/g, "'\\''") + "'";
}
