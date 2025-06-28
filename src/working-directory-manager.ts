import { WorkingDirectoryConfig } from './types';
import { Logger } from './logger';
import { config } from './config';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

interface PersistenceData {
  version: string;
  directories: Record<string, {
    type: 'channel' | 'dm' | 'thread';
    channelId: string;
    threadTs?: string;
    userId?: string;
    directory: string;
    setAt: string;
    setBy?: string;
  }>;
}

export class WorkingDirectoryManager {
  private configs: Map<string, WorkingDirectoryConfig> = new Map();
  private logger = new Logger('WorkingDirectoryManager');
  private persistencePath: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly SAVE_DEBOUNCE_MS = 1000;
  private readonly PERSISTENCE_VERSION = '1.0';

  constructor() {
    this.persistencePath = config.persistencePath || path.join(process.cwd(), 'data', 'working-directories.json');
    this.loadFromDisk();
  }

  getConfigKey(channelId: string, threadTs?: string, userId?: string): string {
    if (threadTs) {
      return `${channelId}-${threadTs}`;
    }
    if (userId && channelId.startsWith('D')) { // Direct message
      return `${channelId}-${userId}`;
    }
    return channelId;
  }

  setWorkingDirectory(channelId: string, directory: string, threadTs?: string, userId?: string): { success: boolean; resolvedPath?: string; error?: string } {
    try {
      const resolvedPath = this.resolveDirectory(directory);
      
      if (!resolvedPath) {
        return { 
          success: false, 
          error: `Directory not found: "${directory}"${config.baseDirectory ? ` (checked in base directory: ${config.baseDirectory})` : ''}` 
        };
      }

      const stats = fs.statSync(resolvedPath);
      
      if (!stats.isDirectory()) {
        this.logger.warn('Path is not a directory', { directory: resolvedPath });
        return { success: false, error: 'Path is not a directory' };
      }

      const key = this.getConfigKey(channelId, threadTs, userId);
      const workingDirConfig: WorkingDirectoryConfig = {
        channelId,
        threadTs,
        userId,
        directory: resolvedPath,
        setAt: new Date(),
      };

      this.configs.set(key, workingDirConfig);
      this.logger.info('Working directory set', {
        key,
        directory: resolvedPath,
        originalInput: directory,
        isThread: !!threadTs,
        isDM: channelId.startsWith('D'),
      });

      this.scheduleSave();
      return { success: true, resolvedPath };
    } catch (error) {
      this.logger.error('Failed to set working directory', error);
      return { success: false, error: 'Directory does not exist or is not accessible' };
    }
  }

  private resolveDirectory(directory: string): string | null {
    // If it's an absolute path, use it directly
    if (path.isAbsolute(directory)) {
      if (fs.existsSync(directory)) {
        return path.resolve(directory);
      }
      return null;
    }

    // If we have a base directory configured, try relative to base directory first
    if (config.baseDirectory) {
      const baseRelativePath = path.join(config.baseDirectory, directory);
      if (fs.existsSync(baseRelativePath)) {
        this.logger.debug('Found directory relative to base', { 
          input: directory,
          baseDirectory: config.baseDirectory,
          resolved: baseRelativePath 
        });
        return path.resolve(baseRelativePath);
      }
    }

    // Try relative to current working directory
    const cwdRelativePath = path.resolve(directory);
    if (fs.existsSync(cwdRelativePath)) {
      this.logger.debug('Found directory relative to cwd', { 
        input: directory,
        resolved: cwdRelativePath 
      });
      return cwdRelativePath;
    }

    return null;
  }

  getWorkingDirectory(channelId: string, threadTs?: string, userId?: string): string | undefined {
    // Priority: Thread > Channel/DM
    if (threadTs) {
      const threadKey = this.getConfigKey(channelId, threadTs);
      const threadConfig = this.configs.get(threadKey);
      if (threadConfig) {
        this.logger.debug('Using thread-specific working directory', {
          directory: threadConfig.directory,
          threadTs,
        });
        return threadConfig.directory;
      }
    }

    // Fall back to channel or DM config
    const channelKey = this.getConfigKey(channelId, undefined, userId);
    const channelConfig = this.configs.get(channelKey);
    if (channelConfig) {
      this.logger.debug('Using channel/DM working directory', {
        directory: channelConfig.directory,
        channelId,
      });
      return channelConfig.directory;
    }

    this.logger.debug('No working directory configured', { channelId, threadTs });
    return undefined;
  }

  removeWorkingDirectory(channelId: string, threadTs?: string, userId?: string): boolean {
    const key = this.getConfigKey(channelId, threadTs, userId);
    const result = this.configs.delete(key);
    if (result) {
      this.logger.info('Working directory removed', { key });
      this.scheduleSave();
    }
    return result;
  }

  listConfigurations(): WorkingDirectoryConfig[] {
    return Array.from(this.configs.values());
  }

  parseSetCommand(text: string): string | null {
    const cwdMatch = text.match(/^cwd\s+(.+)$/i);
    if (cwdMatch) {
      return cwdMatch[1].trim();
    }

    const setMatch = text.match(/^set\s+(?:cwd|dir|directory|working[- ]?directory)\s+(.+)$/i);
    if (setMatch) {
      return setMatch[1].trim();
    }

    return null;
  }

  isGetCommand(text: string): boolean {
    return /^(get\s+)?(cwd|dir|directory|working[- ]?directory)(\?)?$/i.test(text.trim());
  }

  formatDirectoryMessage(directory: string | undefined, context: string): string {
    if (directory) {
      let message = `Current working directory for ${context}: \`${directory}\``;
      if (config.baseDirectory) {
        message += `\n\nBase directory: \`${config.baseDirectory}\``;
        message += `\nYou can use relative paths like \`cwd project-name\` or absolute paths.`;
      }
      return message;
    }
    
    let message = `No working directory set for ${context}. Please set one using:`;
    if (config.baseDirectory) {
      message += `\n\`cwd project-name\` (relative to base directory)`;
      message += `\n\`cwd /absolute/path/to/directory\` (absolute path)`;
      message += `\n\nBase directory: \`${config.baseDirectory}\``;
    } else {
      message += `\n\`cwd /path/to/directory\` or \`set directory /path/to/directory\``;
    }
    return message;
  }

  getChannelWorkingDirectory(channelId: string): string | undefined {
    const key = this.getConfigKey(channelId);
    const config = this.configs.get(key);
    return config?.directory;
  }

  hasChannelWorkingDirectory(channelId: string): boolean {
    return !!this.getChannelWorkingDirectory(channelId);
  }

  formatChannelSetupMessage(channelId: string, channelName: string): string {
    const hasBaseDir = !!config.baseDirectory;
    
    let message = `🏠 **Channel Working Directory Setup**\n\n`;
    message += `Please set the default working directory for #${channelName}:\n\n`;
    
    if (hasBaseDir) {
      message += `**Options:**\n`;
      message += `• \`cwd project-name\` (relative to: \`${config.baseDirectory}\`)\n`;
      message += `• \`cwd /absolute/path/to/project\` (absolute path)\n\n`;
    } else {
      message += `**Usage:**\n`;
      message += `• \`cwd /path/to/project\`\n`;
      message += `• \`set directory /path/to/project\`\n\n`;
    }
    
    message += `This becomes the default for all conversations in this channel.\n`;
    message += `Individual threads can override this by mentioning me with a different \`cwd\` command.`;
    
    return message;
  }

  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveToDisk();
    }, this.SAVE_DEBOUNCE_MS);
  }

  private async saveToDisk(): Promise<void> {
    try {
      const data: PersistenceData = {
        version: this.PERSISTENCE_VERSION,
        directories: {}
      };

      for (const [key, config] of this.configs.entries()) {
        let type: 'channel' | 'dm' | 'thread';
        if (config.threadTs) {
          type = 'thread';
        } else if (config.channelId.startsWith('D')) {
          type = 'dm';
        } else {
          type = 'channel';
        }

        data.directories[key] = {
          type,
          channelId: config.channelId,
          threadTs: config.threadTs,
          userId: config.userId,
          directory: config.directory,
          setAt: config.setAt.toISOString(),
        };
      }

      const dir = path.dirname(this.persistencePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const tmpFile = `${this.persistencePath}.tmp.${process.pid}.${Date.now()}`;
      await fs.promises.writeFile(tmpFile, JSON.stringify(data, null, 2), 'utf8');
      await fs.promises.rename(tmpFile, this.persistencePath);
      
      this.logger.debug('Working directories persisted to disk', {
        path: this.persistencePath,
        count: this.configs.size
      });
    } catch (error) {
      this.logger.error('Failed to save working directories to disk', error);
    }
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.persistencePath)) {
        this.logger.info('No persistence file found, starting fresh', {
          path: this.persistencePath
        });
        return;
      }

      const content = fs.readFileSync(this.persistencePath, 'utf8');
      const data: PersistenceData = JSON.parse(content);

      if (data.version !== this.PERSISTENCE_VERSION) {
        this.logger.warn('Persistence file version mismatch, starting fresh', {
          expected: this.PERSISTENCE_VERSION,
          found: data.version
        });
        return;
      }

      this.configs.clear();
      
      for (const [key, entry] of Object.entries(data.directories)) {
        const config: WorkingDirectoryConfig = {
          channelId: entry.channelId,
          threadTs: entry.threadTs,
          userId: entry.userId,
          directory: entry.directory,
          setAt: new Date(entry.setAt)
        };

        if (fs.existsSync(config.directory)) {
          this.configs.set(key, config);
        } else {
          this.logger.warn('Skipping non-existent directory from persistence', {
            key,
            directory: config.directory
          });
        }
      }

      this.logger.info('Working directories loaded from disk', {
        path: this.persistencePath,
        count: this.configs.size
      });
    } catch (error) {
      this.logger.error('Failed to load working directories from disk', error);
      this.logger.info('Starting with empty configuration');
    }
  }
}