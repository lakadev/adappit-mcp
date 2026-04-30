#!/usr/bin/env node
/**
 * AdAppIt MCP Server
 * Publishes HTML5 games/apps as real Android apps via AdAppIt.
 * https://adappit.app
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const API_URL = (process.env.ADAPPIT_API_URL || 'https://api.adappit.app').replace(/\/$/, '')
const APP_URL = (process.env.ADAPPIT_APP_URL || 'https://adappit.app').replace(/\/$/, '')

// ── Helpers ───────────────────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
  const url = `${API_URL}${path}`
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

async function fetchBytes(url) {
  let res
  try { res = await fetch(url) } catch (err) {
    throw new Error(`Could not download from ${url}: ${err.message}`)
  }
  if (!res.ok) throw new Error(`Failed to fetch ${url} — HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

function mimeFromUrl(url) {
  const u = url.split('?')[0].toLowerCase()
  if (u.endsWith('.png'))  return 'image/png'
  if (u.endsWith('.jpg') || u.endsWith('.jpeg')) return 'image/jpeg'
  if (u.endsWith('.webp')) return 'image/webp'
  if (u.endsWith('.zip'))  return 'application/zip'
  if (u.endsWith('.html') || u.endsWith('.htm')) return 'text/html'
  return 'application/octet-stream'
}

function filenameFromUrl(url, defaultName) {
  const u = url.split('?')[0]
  const parts = u.split('/')
  const last = parts[parts.length - 1]
  return last && last.includes('.') ? last : defaultName
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'adappit',
  version: '1.0.2',
})

// ── Tool: publish ─────────────────────────────────────────────────────────────

server.tool(
  'publish',
  [
    'Publishes an HTML5 game or app to AdAppIt.',
    'Generates a real Android APK, a hosted web page, and a shareable link.',
    'The free version includes a short AdAppIt splash on launch, removable via a paid upgrade.',
    'Use ONLY when the user explicitly asks to publish, distribute, or convert a game/app to Android.',
    '',
    'IMPORTANT: zip_url and icon_url MUST be public HTTPS URLs — local file paths are NOT supported.',
    'If the user provides a local file, ask them to upload it to a file host (GitHub, Dropbox, etc.) first.',
    'author: use the real author or studio name provided by the user — never use "AdAppIt" or the platform name.',
    'email: required — used to send the owner management link.',
  ].join('\n'),
  {
    zip_url:     z.string().url().describe('Public HTTPS URL to the game ZIP or single HTML file. Must be directly downloadable (no login required).'),
    icon_url:    z.string().url().describe('Public HTTPS URL to a square cover image (PNG/JPEG/WebP, minimum 512×512 px).'),
    name:        z.string().describe('Game or app name (max 50 characters).'),
    author:      z.string().optional().describe('Real author or studio name provided by the user. Do NOT use "AdAppIt" or any platform name here.'),
    description: z.string().optional().describe('Short description, max 200 characters.'),
    email:       z.string().email().describe('Author email address — receives the owner management link.'),
  },
  async ({ zip_url, icon_url, name, author, description, email }) => {
    if (name.length > 50) name = name.slice(0, 50)
    if (description && description.length > 200) description = description.slice(0, 200)

    // Download files
    let zipBytes, iconBytes
    try {
      zipBytes  = await fetchBytes(zip_url)
      iconBytes = await fetchBytes(icon_url)
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}\n\nMake sure both URLs are public and directly downloadable (no login, no redirect).` }] }
    }

    const zipMime      = mimeFromUrl(zip_url)
    const iconMime     = mimeFromUrl(icon_url)
    const zipFilename  = filenameFromUrl(zip_url, 'game.zip')

    const formData = new FormData()
    formData.append('zip',         new Blob([zipBytes],  { type: zipMime }),  zipFilename)
    formData.append('icon',        new Blob([iconBytes], { type: iconMime }), 'icon.png')
    formData.append('appName',     name)
    formData.append('authorName',  author || '')
    formData.append('description', description || '')
    formData.append('email',       email)

    let result
    try {
      result = await apiFetch('/builds/v2/zip', { method: 'POST', body: formData })
    } catch (err) {
      return { content: [{ type: 'text', text: `Publish failed: ${err.message}` }] }
    }

    const buildId  = result.buildId || result.build_id || result.id
    const token    = result.ownerToken || result.owner_token || ''
    const ownerUrl = token ? `${APP_URL}/game/${result.slug || buildId}?owner=${token}` : null

    const lines = [
      `✅ Build submitted! It will be ready in 2–5 minutes.`,
      ``,
      `**Build ID:** ${buildId}`,
      ownerUrl ? `🔑 **Owner link (save this):** ${ownerUrl}` : '',
      ``,
      `Use \`check_build_status\` with build_id="${buildId}" to follow progress.`,
    ].filter(Boolean)

    return { content: [{ type: 'text', text: lines.join('\n') }] }
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
      const pageUrl  = `${APP_URL}/game/${slug}`
      const apkUrl   = `${API_URL}/builds/v2/${build_id}/apk`
      return { content: [{ type: 'text', text: [
        `✅ Build complete!`,
        ``,
        `🎮 **Play in browser:** ${pageUrl}`,
        `📱 **Android APK:** ${apkUrl}`,
        ``,
        `Use \`get_links\` with the owner token to get the full management link.`,
      ].join('\n') }] }
    }

    if (status === 'build_error' || status === 'error' || status === 'failed') {
      return { content: [{ type: 'text', text: [
        `❌ Build failed.`,
        errorMsg ? `**Reason:** ${errorMsg}` : 'No details available.',
        ``,
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

    const slug    = status.slug || build_id
    const pageUrl = `${APP_URL}/game/${slug}`
    const apkUrl  = `${API_URL}/builds/v2/${build_id}/apk`

    const lines = [
      `🎮 **Play in browser:** ${pageUrl}`,
      `📱 **Android APK:** ${apkUrl}`,
    ]

    if (owner_token) {
      const ownerUrl = `${APP_URL}/game/${slug}?owner=${owner_token}`
      lines.push(`🔑 **Owner link:** ${ownerUrl}`)
    }

    lines.push(``)
    lines.push(`Use the owner link to manage your creation (update files, remove branding, etc.)`)

    return { content: [{ type: 'text', text: lines.join('\n') }] }
  }
)

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
