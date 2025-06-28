import { spawn, ChildProcess } from 'child_process';
import { createInterface, Interface } from 'readline';
import { ConversationSession } from './types';
import { Logger } from './logger';
import { McpManager, McpServerConfig } from './mcp-manager';

export interface SDKMessage {
  type: string;
  subtype?: string;
  content?: string;
  tool?: string;
  tool_call_id?: string;
  arguments?: any;
  output?: any;
  session_id?: string;
  [key: string]: any;
}

export class ClaudeHandler {
  private sessions: Map<string, ConversationSession> = new Map();
  private logger = new Logger('ClaudeHandler');
  private mcpManager: McpManager;

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
  }

  getSessionKey(userId: string, channelId: string, threadTs?: string): string {
    return `${userId}-${channelId}-${threadTs || 'direct'}`;
  }

  getSession(userId: string, channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.sessions.get(this.getSessionKey(userId, channelId, threadTs));
  }

  createSession(userId: string, channelId: string, threadTs?: string): ConversationSession {
    const session: ConversationSession = {
      userId,
      channelId,
      threadTs,
      isActive: true,
      lastActivity: new Date(),
    };
    this.sessions.set(this.getSessionKey(userId, channelId, threadTs), session);
    return session;
  }

  async *streamQuery(
    prompt: string,
    session?: ConversationSession,
    abortController?: AbortController,
    workingDirectory?: string,
    slackContext?: { channel: string; threadTs?: string; user: string }
  ): AsyncGenerator<SDKMessage, void, unknown> {
    const args: string[] = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose'
    ];

    // Add working directory if specified
    if (workingDirectory) {
      args.push('--cwd', workingDirectory);
    }

    // Add permission mode
    const permissionMode = slackContext ? 'default' : 'bypassPermissions';
    args.push('--permission-mode', permissionMode);

    // Handle MCP servers
    const mcpServers = this.mcpManager.getServerConfiguration();
    let finalMcpServers = mcpServers || {};

    // Add permission prompt server if we have Slack context
    if (slackContext) {
      const permissionServer = {
        'permission-prompt': {
          command: 'npx',
          args: ['tsx', `${process.cwd()}/src/permission-mcp-server.ts`],
          env: {
            SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN!,
            SLACK_CONTEXT: JSON.stringify(slackContext)
          }
        }
      };
      finalMcpServers = { ...finalMcpServers, ...permissionServer };
      args.push('--permission-prompt-tool-name', 'mcp__permission-prompt__permission_prompt');
      this.logger.debug('Added permission prompt tool for Slack integration', slackContext);
    }

    // Add MCP servers if any
    if (Object.keys(finalMcpServers).length > 0) {
      args.push('--mcp-config', JSON.stringify({ mcpServers: finalMcpServers }));
      
      // Add allowed tools
      const defaultMcpTools = this.mcpManager.getDefaultAllowedTools();
      if (slackContext) {
        defaultMcpTools.push('mcp__permission-prompt');
      }
      if (defaultMcpTools.length > 0) {
        args.push('--allowedTools', ...defaultMcpTools);
      }
      
      this.logger.debug('Added MCP configuration', {
        serverCount: Object.keys(finalMcpServers).length,
        servers: Object.keys(finalMcpServers),
        allowedTools: defaultMcpTools,
        hasSlackContext: !!slackContext,
      });
    }

    // Add session resume if available
    if (session?.sessionId) {
      args.push('--resume', session.sessionId);
      this.logger.debug('Resuming session', { sessionId: session.sessionId });
    } else {
      this.logger.debug('Starting new Claude conversation');
    }

    // Add the prompt as the last argument
    args.push(prompt);

    this.logger.debug('Claude CLI arguments', { args: args.slice(0, -1), promptLength: prompt.length });

    let childProcess: ChildProcess | null = null;
    let readlineInterface: Interface | null = null;

    try {
      // Spawn the Claude CLI process
      childProcess = spawn('claude', args, {
        cwd: workingDirectory || process.cwd(),
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Handle process errors
      childProcess.on('error', (error) => {
        this.logger.error('Failed to spawn Claude CLI', error);
        throw new Error(`Failed to spawn Claude CLI: ${error.message}`);
      });

      // Create readline interface for stdout
      readlineInterface = createInterface({ 
        input: childProcess.stdout!,
        crlfDelay: Infinity 
      });

      // Handle stderr for debugging
      childProcess.stderr?.on('data', (data) => {
        const errorText = data.toString();
        this.logger.debug('Claude CLI stderr', { stderr: errorText });
      });

      // Set up abort handling
      if (abortController) {
        abortController.signal.addEventListener('abort', () => {
          if (childProcess) {
            childProcess.kill('SIGTERM');
          }
        });
      }

      // Process each line of output
      for await (const line of readlineInterface) {
        if (line.trim()) {
          try {
            const message = JSON.parse(line) as SDKMessage;
            
            // Handle session initialization
            if (message.type === 'system' && message.subtype === 'init' && session) {
              session.sessionId = message.session_id;
              this.logger.info('Session initialized', { 
                sessionId: message.session_id,
                model: message.model,
                tools: message.tools?.length || 0,
              });
            }
            
            yield message;
          } catch (parseError) {
            this.logger.error('Failed to parse Claude output', { line, error: parseError });
            // Continue processing other lines
          }
        }
      }

      // Wait for process to complete
      await new Promise<void>((resolve, reject) => {
        childProcess!.on('close', (code) => {
          if (code === 0 || code === null) {
            resolve();
          } else {
            reject(new Error(`Claude CLI exited with code ${code}`));
          }
        });
      });

    } catch (error) {
      this.logger.error('Error in Claude query', error);
      throw error;
    } finally {
      // Clean up resources
      if (readlineInterface) {
        readlineInterface.close();
      }
      if (childProcess && !childProcess.killed) {
        childProcess.kill('SIGTERM');
      }
    }
  }

  cleanupInactiveSessions(maxAge: number = 30 * 60 * 1000) {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.lastActivity.getTime() > maxAge) {
        this.sessions.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.info(`Cleaned up ${cleaned} inactive sessions`);
    }
  }
}