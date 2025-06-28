# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Development Commands

### Build and Run
```bash
npm install           # Install dependencies
npm run dev          # Development mode with hot reload (tsx watch)
npm run build        # Compile TypeScript to JavaScript (tsc)
npm run prod         # Run production build (node dist/index.js)
npm start            # Run TypeScript directly with tsx
```

### TypeScript Configuration
- **Target**: ES2020 with CommonJS modules
- **Strict Mode**: Enabled for type safety
- **Source Maps**: Enabled for debugging
- **Output**: Compiled to `dist/` directory

### Testing and Validation
Currently, no test framework or linting is configured. When implementing tests or linting:
- Ask the user for preferred test framework (Jest, Vitest, etc.)
- Ask for linting preferences if adding ESLint

## Architecture Overview

### Core Flow
1. **Slack Events** → `slack-handler.ts` receives and processes messages
2. **Session Management** → `claude-handler.ts` maintains per-conversation Claude Code sessions
3. **Working Directory** → `working-directory-manager.ts` resolves project paths
4. **Tool Execution** → Claude Code SDK executes tools with proper context
5. **Response Streaming** → Real-time updates sent back to Slack

### Session Architecture
- Sessions are keyed by: `userId-channelId-threadTs`
- Each conversation maintains its own Claude Code instance
- Sessions auto-cleanup after 30 minutes of inactivity
- MCP servers are injected per-session from `mcp-servers.json`

### Message Processing Pattern
1. **Append-Only**: Each tool use creates a new Slack message (not edits)
2. **Streaming Updates**: Messages update live as Claude generates responses
3. **Status Reactions**: Original message gets emoji reactions showing progress
4. **Tool Formatting**: Special formatting for Edit, Write, Bash, and other tools

### Working Directory Hierarchy
1. **Thread-specific** (highest priority): Set with `@bot cwd path` in thread
2. **Channel default**: Set when bot joins channel
3. **DM-specific**: Set in direct message conversation
4. **Base directory**: Optional prefix for relative paths (e.g., `/Users/username/Code/`)

### File Handling Strategy
- **Text files**: Content embedded directly in Claude's prompt
- **Images**: Saved to temp directory, path passed to Claude's Read tool
- **Binary files**: Basic metadata provided
- **Cleanup**: Automatic deletion after processing

### MCP Integration Pattern
- Servers configured in `mcp-servers.json`
- Tools named as `mcp__serverName__toolName`
- All tools allowed by default (no allowedTools filtering)
- Dynamic reload with `mcp reload` command

## Key Implementation Details

### Slack API Usage
- **Socket Mode**: Real-time events via WebSocket
- **Message Updates**: Rate-limited to prevent API exhaustion
- **Reactions API**: Used for status indicators
- **File Downloads**: Authenticated with bot token

### Error Handling Approach
- User-friendly messages for common errors
- Detailed logging with `logger.ts` for debugging
- Graceful fallbacks for API failures
- Session cleanup on errors

### Security Practices
- No persistent storage of user data
- Temporary files cleaned up immediately
- Environment variables for secrets
- File type/size validation

### Performance Considerations
- Streaming responses to show progress
- Lazy session initialization
- Efficient message batching
- Smart update detection in todo manager

## Working with This Codebase

### Adding New Features
1. Check existing patterns in similar files
2. Maintain TypeScript strict mode compliance
3. Use existing utilities (logger, config, types)
4. Follow append-only message pattern for Slack

### Modifying Slack Interactions
- All Slack events handled in `slack-handler.ts`
- Tool formatting in `formatToolUse()` method
- Status reactions in `updateMessageStatus()`
- Working directory commands in `handleMessage()`

### Extending Claude Integration
- Session options in `claude-handler.ts`
- MCP server configuration in `MCPManager`
- Tool permissions in `getSessionOptions()`
- Custom prompts can be added to query handling

### Debugging Tips
- Enable `DEBUG=true` in `.env` for verbose logging
- Check session keys for context issues
- Monitor Slack rate limits in logs
- Use `logger.debug()` for development logging