#!/usr/bin/env node
/**
 * AdAppIt MCP Server
 * Publishes HTML5 games/apps as real Android apps via AdAppIt.
 * https://adappit.app
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import fs from 'fs'
import path from 'path'
// FormData et Blob sont globaux dans Node 18+

const API_URL = (process.env.ADAPPIT_API_URL || 'https://api.adappit.app').replace(/\/$/, '')
const APP_URL = (process.env.ADAPPIT_APP_URL || 'https://adappit.app').replace(/\/$/, '')

// ── Helpers ───────────────────────────────────────────────────────────────────

async function apiFetch(path_, options = {}) {
  const url = `${API_URL}${path_}`
  let response
  try {
    response = await fetch(url, options)
  } catch (err) {
    throw new Error(`Network error — please retry. (${err.message})`)
  }
  const body = await response.text()
  let json
  try { json = JSON.parse(body) } catch { json = { error: body } }
  if (!response.ok) {
    throw new Error(json.error || json.message || `API error ${response.status}`)
  }
  return json
}

function mimeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.png')  return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.zip')  return 'application/zip'
  if (ext === '.html' || ext === '.htm') return 'text/html'
  return 'application/octet-stream'
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'adappit',
  version: '1.1.0',
})

// ── Tool: upload_file ─────────────────────────────────────────────────────────

server.tool(
  'upload_file',
  [
    'Uploads a local file to AdAppIt and returns a temporary upload_id (valid 10 minutes).',
    'Use this BEFORE calling publish when the game file or icon is a local path on disk.',
    'Supported formats: ZIP, HTML, PNG, JPEG, WebP.',
    'IMPORTANT: use this tool instead of reading the file yourself, converting to base64, or calling the API directly.',
    'After uploading, pass the returned upload_id to the publish tool as zip_upload_id or icon_upload_id.',
  ].join('\n'),
  {
    file_path: z.string().describe('Absolute local path to the file to upload (e.g. C:/Games/mygame.zip or /home/user/game.zip).'),
  },
  async ({ file_path }) => {
    // Validate file exists
    if (!fs.existsSync(file_path)) {
      return { content: [{ type: 'text', text: `Error: File not found: ${file_path}` }] }
    }

    const fileBytes = fs.readFileSync(file_path)
    const mime      = mimeFromPath(file_path)
    const filename  = path.basename(file_path)

    const formData = new FormData()
    formData.append('file', new Blob([fileBytes], { type: mime }), filename)

    let result
    try {
      result = await apiFetch('/uploads/v1/file', { method: 'POST', body: formData })
    } catch (err) {
      return { content: [{ type: 'text', text: `Upload failed: ${err.message}` }] }
    }

    return { content: [{ type: 'text', text: [
      `✅ File uploaded successfully.`,
      `**upload_id:** ${result.upload_id}`,
      `Valid for: ${result.expires_in_seconds / 60} minutes.`,
      ``,
      `Pass this upload_id to \`publish\` as zip_upload_id or icon_upload_id.`,
    ].join('\n') }] }
  }
)

// ── Tool: publish ─────────────────────────────────────────────────────────────

server.tool(
  'publish',
  [
    'Publishes an HTML5 game or app to AdAppIt.',
    'Generates a real Android APK, a hosted web page, and a shareable link.',
    'The free version includes a short AdAppIt splash on launch, removable via a paid upgrade.',
    'Use ONLY when the user explicitly asks to publish, distribute, or convert a game/app to Android.',
    '',
    'To provide game files, use ONE of:',
    '  - zip_url / icon_url: public HTTPS URLs (directly downloadable, no login)',
    '  - zip_upload_id / icon_upload_id: IDs returned by upload_file (for local files)',
    'Do NOT read files yourself, convert to base64, or call the API directly.',
    '',
    'author: use the real author or studio name — NEVER use "AdAppIt" or the platform name.',
    'email: required — used to send the owner management link to the creator.',
  ].join('\n'),
  {
    zip_url:        z.string().url().optional().describe('Public HTTPS URL to the game ZIP or single HTML file.'),
    zip_upload_id:  z.string().optional().describe('upload_id from upload_file (for local ZIP/HTML files).'),
    icon_url:       z.string().url().optional().describe('Public HTTPS URL to a square cover image (PNG/JPEG/WebP, min 512×512 px).'),
    icon_upload_id: z.string().optional().describe('upload_id from upload_file (for local icon file).'),
    name:           z.string().describe('Game or app name (max 50 characters).'),
    author:         z.string().optional().describe('Real author or studio name. Do NOT use "AdAppIt" or any platform name.'),
    description:    z.string().optional().describe('Short description, max 200 characters.'),
    email:          z.string().email().describe('Creator email address — receives the owner management link.'),
  },
  async ({ zip_url, zip_upload_id, icon_url, icon_upload_id, name, author, description, email }) => {
    if (!zip_url && !zip_upload_id) {
      return { content: [{ type: 'text', text: 'Error: Provide either zip_url (public URL) or zip_upload_id (from upload_file).' }] }
    }
    if (!icon_url && !icon_upload_id) {
      return { content: [{ type: 'text', text: 'Error: Provide either icon_url (public URL) or icon_upload_id (from upload_file).' }] }
    }

    if (name.length > 50) name = name.slice(0, 50)
    if (description && description.length > 200) description = description.slice(0, 200)

    const formData = new FormData()
    formData.append('appName',     name)
    formData.append('authorName',  author || '')
    formData.append('description', description || '')
    formData.append('email',       email)

    // ZIP source
    if (zip_upload_id) {
      formData.append('zip_upload_id', zip_upload_id)
    } else {
      let zipBytes
      try {
        const res = await fetch(zip_url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        zipBytes = Buffer.from(await res.arrayBuffer())
      } catch (err) {
        return { content: [{ type: 'text', text: `Error downloading zip_url: ${err.message}\n\nIf the file is local, use upload_file first.` }] }
      }
      const ext = zip_url.split('?')[0].split('.').pop().toLowerCase()
      const mime = ext === 'html' || ext === 'htm' ? 'text/html' : 'application/zip'
      formData.append('zip', new Blob([zipBytes], { type: mime }), `game.${ext}`)
    }

    // Icon source
    if (icon_upload_id) {
      formData.append('icon_upload_id', icon_upload_id)
    } else {
      let iconBytes
      try {
        const res = await fetch(icon_url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        iconBytes = Buffer.from(await res.arrayBuffer())
      } catch (err) {
        return { content: [{ type: 'text', text: `Error downloading icon_url: ${err.message}\n\nIf the file is local, use upload_file first.` }] }
      }
      const ext = icon_url.split('?')[0].split('.').pop().toLowerCase()
      const mime = ['jpg','jpeg'].includes(ext) ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png'
      formData.append('icon', new Blob([iconBytes], { type: mime }), `icon.${ext || 'png'}`)
    }

    let result
    try {
      result = await apiFetch('/builds/v2/zip', { method: 'POST', body: formData })
    } catch (err) {
      return { content: [{ type: 'text', text: `Publish failed: ${err.message}` }] }
    }

    const buildId  = result.buildId || result.build_id || result.id
    const slug     = result.slug || buildId
    const token    = result.ownerToken || result.owner_token || ''
    const ownerUrl = token ? `${APP_URL}/game/${slug}?owner=${token}` : null

    return { content: [{ type: 'text', text: [
      `✅ Build submitted! It will be ready in 2–5 minutes.`,
      ``,
      `**Build ID:** ${buildId}`,
      ownerUrl ? `🔑 **Owner link (save this):** ${ownerUrl}` : '',
      ``,
      `Use \`check_build_status\` with build_id="${buildId}" to follow progress.`,
    ].filter(Boolean).join('\n') }] }
  }
)

// ── Tool: check_build_status ──────────────────────────────────────────────────

server.tool(
  'check_build_status',
  'Checks the current status of a game/app build on AdAppIt. Returns status (building/done/failed) and links when done.',
  {
    build_id: z.string().describe('The build ID returned by publish.'),
  },
  async ({ build_id }) => {
    let result
    try {
      result = await apiFetch(`/builds/v2/${build_id}/status`)
    } catch (err) {
      return { content: [{ type: 'text', text: `Error checking status: ${err.message}` }] }
    }

    const status   = result.status || 'unknown'
    const slug     = result.slug || build_id
    const errorMsg = result.error || result.error_msg || ''

    if (status === 'done') {
      return { content: [{ type: 'text', text: [
        `✅ Build complete!`,
        ``,
        `🎮 **Play in browser:** ${APP_URL}/game/${slug}`,
        `📱 **Android APK:** ${API_URL}/builds/v2/${build_id}/apk`,
        ``,
        `Use \`get_links\` with the owner token to get the full management link.`,
      ].join('\n') }] }
    }

    if (status === 'build_error' || status === 'error' || status === 'failed') {
      return { content: [{ type: 'text', text: [
        `❌ Build failed.`,
        errorMsg ? `**Reason:** ${errorMsg}` : 'No details available.',
        `Please check the game files and try publishing again.`,
      ].join('\n') }] }
    }

    return { content: [{ type: 'text', text: [
      `⏳ Build in progress… (status: ${status})`,
      `Check again in 30–60 seconds.`,
    ].join('\n') }] }
  }
)

// ── Tool: get_links ───────────────────────────────────────────────────────────

server.tool(
  'get_links',
  'Returns all public links for a published game/app: shareable web page, Android APK download, and owner management page.',
  {
    build_id:    z.string().describe('The build ID returned by publish.'),
    owner_token: z.string().optional().describe('Owner token returned by publish. Provide it to get the management link.'),
  },
  async ({ build_id, owner_token }) => {
    let status
    try {
      status = await apiFetch(`/builds/v2/${build_id}/status`)
    } catch (err) {
      return { content: [{ type: 'text', text: `Error fetching build info: ${err.message}` }] }
    }

    if (status.status !== 'done') {
      return { content: [{ type: 'text', text: `Build is not ready yet (status: ${status.status}). Use check_build_status to wait for completion.` }] }
    }

    const slug = status.slug || build_id
    const lines = [
      `🎮 **Play in browser:** ${APP_URL}/game/${slug}`,
      `📱 **Android APK:** ${API_URL}/builds/v2/${build_id}/apk`,
    ]

    if (owner_token) {
      lines.push(`🔑 **Owner link:** ${APP_URL}/game/${slug}?owner=${owner_token}`)
    }

    lines.push(``)
    lines.push(`Use the owner link to manage your creation (update files, remove branding, etc.)`)

    return { content: [{ type: 'text', text: lines.join('\n') }] }
  }
)

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
