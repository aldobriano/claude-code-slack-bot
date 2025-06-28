import { App } from '@slack/bolt';
import { config, validateConfig } from './config';
import { ClaudeHandler } from './claude-handler';
import { SlackHandler } from './slack-handler';
import { McpManager } from './mcp-manager';
import { Logger } from './logger';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const logger = new Logger('Main');

async function checkClaudeAuth(): Promise<boolean> {
  try {
    const { stdout } = await execAsync('claude auth status');
    return stdout.includes('Authenticated');
  } catch (error) {
    logger.error('Failed to check Claude authentication status', error);
    return false;
  }
}

async function start() {
  try {
    // Validate configuration
    validateConfig();

    // Check Claude CLI authentication
    const isAuthenticated = await checkClaudeAuth();
    if (!isAuthenticated) {
      logger.error('Claude CLI is not authenticated. Please run "claude auth" to authenticate.');
      process.exit(1);
    }
    logger.info('Claude CLI authentication verified');

    logger.info('Starting Claude Slack bot', {
      debug: config.debug,
      useBedrock: config.claude.useBedrock,
      useVertex: config.claude.useVertex,
    });

    // Initialize Slack app
    const app = new App({
      token: config.slack.botToken,
      signingSecret: config.slack.signingSecret,
      socketMode: true,
      appToken: config.slack.appToken,
    });

    // Initialize MCP manager
    const mcpManager = new McpManager();
    const mcpConfig = mcpManager.loadConfiguration();
    
    // Initialize handlers
    const claudeHandler = new ClaudeHandler(mcpManager);
    const slackHandler = new SlackHandler(app, claudeHandler, mcpManager);

    // Setup event handlers
    slackHandler.setupEventHandlers();

    // Start the app
    await app.start();
    logger.info('⚡️ Claude Slack bot is running!');
    logger.info('Configuration:', {
      usingBedrock: config.claude.useBedrock,
      usingVertex: config.claude.useVertex,
      usingAnthropicAPI: !config.claude.useBedrock && !config.claude.useVertex,
      debugMode: config.debug,
      baseDirectory: config.baseDirectory || 'not set',
      mcpServers: mcpConfig ? Object.keys(mcpConfig.mcpServers).length : 0,
      mcpServerNames: mcpConfig ? Object.keys(mcpConfig.mcpServers) : [],
    });
  } catch (error) {
    logger.error('Failed to start the bot', error);
    process.exit(1);
  }
}

start();