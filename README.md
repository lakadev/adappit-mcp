# adappit-mcp

MCP server for [AdAppIt](https://adappit.app) — publish HTML5 games and apps as real Android APKs directly from your AI assistant.

## Tools

| Tool | Description |
|------|-------------|
| `publish` | Submits a game/app for Android packaging. Accepts a ZIP or single HTML file. |
| `check_build_status` | Polls the build status (building / done / failed). |
| `get_links` | Returns the web page URL, APK download link, and optional owner management URL. |

## Setup

### Claude.ai (claude.ai/settings → Integrations)

Add a new MCP server with:

```
npx adappit-mcp
```

Or if you prefer a fixed version:

```
npx adappit-mcp@1.0.0
```

### Cursor / VS Code (via MCP extension)

Add to your MCP config file:

```json
{
  "mcpServers": {
    "adappit": {
      "command": "npx",
      "args": ["adappit-mcp"]
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json` (see location below):

```json
{
  "mcpServers": {
    "adappit": {
      "command": "npx",
      "args": ["adappit-mcp"]
    }
  }
}
```

**Config file locations:**
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

### Any MCP client (generic)

```json
{
  "mcpServers": {
    "adappit": {
      "command": "npx",
      "args": ["adappit-mcp"]
    }
  }
}
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ADAPPIT_API_URL` | `https://api.adappit.app` | AdAppIt API base URL. Override for self-hosted instances. |

## Example usage

Once connected, you can ask your AI assistant:

> "Publish my game to AdAppIt. Here is the ZIP: [URL]. Use this icon: [URL]. Name it 'Space Shooter', author 'My Studio', email me at contact@example.com."

The assistant will:
1. Call `publish` → returns a build ID
2. Call `check_build_status` every minute until done
3. Call `get_links` → returns the web page and APK download link

## Testing with MCP Inspector

```bash
npx @modelcontextprotocol/inspector npx adappit-mcp
```

Or clone and run locally:

```bash
git clone https://github.com/lakadev/adappit-mcp.git
cd adappit-mcp
npm install
npx @modelcontextprotocol/inspector node index.js
```

## License

MIT
