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

/**
 * Download a URL and return a Buffer.
 * Also accepts a data: URI or raw base64 string.
 */
async function fetchBytes(urlOrBase64) {
  // data: URI
  if (urlOrBase64.startsWith('data:')) {
    const b64 = urlOrBase64.split(',')[1]
    return Buffer.from(b64, 'base64')
  }
  // raw base64 (no scheme, contains only base64 chars)
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(urlOrBase64) && !urlOrBase64.startsWith('http')) {
    return Buffer.from(urlOrBase64, 'base64')
  }
  // HTTP(S) URL
  let res
  try { res = await fetch(urlOrBase64) } catch (err) {
    throw new Error(`Could not download file from ${urlOrBase64}: ${err.message}. Please retry or provide a direct URL.`)
  }
  if (!res.ok) throw new Error(`Failed to fetch ${urlOrBase64} — HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

function mimeFromUrl(url) {
  const u = url.split('?')[0].toLowerCase()
  if (u.endsWith('.png'))  return 'image/png'
  if (u.endsWith('.jpg') || u.endsWith('.jpeg')) return 'image/jpeg'
  if (u.endsWith('.webp')) return 'image/webp'
  if (u.endsWith('.zip'))  return 'application/zip'
  if (u.endsWith('.html') || u.endsWith('.htm')) return 'text/html'
  // data: URI
  const m = url.match(/^data:([^;,]+)/)
  if (m) return m[1]
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
  version: '1.0.1',
})

// ── Tool: publish ─────────────────────────────────────────────────────────────

server.tool(
  'publish',
  'Publishes an HTML5 game/app to AdAppIt. Generates a real Android app, a hosted web page, and a shareable link. The free version includes a short AdAppIt splash on launch, removable via a paid upgrade. Use only when the user explicitly asks to transform/publish or distribute a game/app (HTML) as a mobile app.',
  {
    zip_url:     z.string().describe('Public URL to the ZIP or HTML file (also accepts base64 or data: URI).'),
    icon_url:    z.string().describe('Public URL to a square cover image, minimum 512×512 px (PNG, JPEG, or WebP). Also accepts base64 or data: URI.'),
    name:        z.string().describe('Game or app name (max 50 characters).'),
    author:      z.string().optional().describe('Author or studio name.'),
    description: z.string().optional().describe('Short description, max 200 characters.'),
    email:       z.string().describe('Email address to receive the owner management link.'),
  },
  async ({ zip_url, icon_url, name, author, description, email }) => {
    // Validate inputs
    if (!zip_url)  return { content: [{ type: 'text', text: 'Error: zip_url is required.' }] }
    if (!icon_url) return { content: [{ type: 'text', text: 'Error: icon_url is required.' }] }
    if (!name)     return { content: [{ type: 'text', text: 'Error: name is required.' }] }
    if (!email)    return { content: [{ type: 'text', text: 'Error: email is required.' }] }
    if (name.length > 50) name = name.slice(0, 50)
    if (description && description.length > 200) description = description.slice(0, 200)

    // Download files
    let zipBytes, iconBytes, iconMime, zipFilename
    try {
      zipBytes    = await fetchBytes(zip_url)
      iconBytes   = await fetchBytes(icon_url)
      iconMime    = mimeFromUrl(icon_url)
      zipFilename = filenameFromUrl(zip_url, 'game.zip')
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] }
    }

    // Determine zip mime/filename
    const zipMime = mimeFromUrl(zip_url)

    // Build multipart form
    const formData = new FormData()
    formData.append('zip',         new Blob([zipBytes],  { type: zipMime }),  zipFilename)
    formData.append('icon',        new Blob([iconBytes], { type: iconMime }), 'icon.png')
    formData.append('appName',     name)
    formData.append('authorName',  author || '')
    formData.append('description', description || '')
    formData.append('email',       email)

    let result
    try {
      result = await apiFetch('/builds/v2/zip', {
        method: 'POST',
        body: formData,
      })
    } catch (err) {
      return { content: [{ type: 'text', text: `Publish failed: ${err.message}` }] }
    }

    const buildId  = result.buildId || result.build_id || result.id
    const slug      = result.slug || ''
    const token     = result.ownerToken || result.owner_token || ''
    const ownerUrl  = token ? `${API_URL}/owner/v1/verify?token=${encodeURIComponent(token)}` : null

    const lines = [
      `✅ Build submitted successfully!`,
      ``,
      `**Build ID:** ${buildId}`,
      ``,
      `Use \`check_build_status\` with build_id="${buildId}" to follow progress.`,
      `Build typically takes 2–5 minutes.`,
      ownerUrl ? `\n🔑 **Owner link (save this):** ${ownerUrl}` : '',
    ].filter(Boolean)

    return { content: [{ type: 'text', text: lines.join('\n') }] }
  }
)

// ── Tool: check_build_status ──────────────────────────────────────────────────

server.tool(
  'check_build_status',
  'Checks the current status of a game/app build on AdAppIt. Returns status (building/done/failed) and details when done.',
  {
    build_id: z.string().describe('The build ID returned by publish.'),
  },
  async ({ build_id }) => {
    if (!build_id) return { content: [{ type: 'text', text: 'Error: build_id is required.' }] }

    let result
    try {
      result = await apiFetch(`/builds/v2/${build_id}/status`)
    } catch (err) {
      return { content: [{ type: 'text', text: `Error checking status: ${err.message}` }] }
    }

    const status    = result.status || 'unknown'
    const slug      = result.slug || ''
    const errorMsg  = result.error || result.error_msg || ''

    let text
    if (status === 'done') {
      text = [
        `✅ Build complete!`,
        ``,
        `**Status:** done`,
        slug ? `**Slug:** ${slug}` : '',
        ``,
        `Use \`get_links\` with build_id="${build_id}" to get all download and sharing links.`,
      ].filter(l => l !== undefined).join('\n')
    } else if (status === 'build_error' || status === 'error' || status === 'failed') {
      text = [
        `❌ Build failed.`,
        errorMsg ? `**Reason:** ${errorMsg}` : 'No additional details available.',
        ``,
        `Please check the game files and try publishing again.`,
      ].join('\n')
    } else {
      text = [
        `⏳ Build in progress…`,
        `**Status:** ${status}`,
        ``,
        `Check again in 30–60 seconds.`,
      ].join('\n')
    }

    return { content: [{ type: 'text', text: text }] }
  }
)

// ── Tool: get_links ───────────────────────────────────────────────────────────

server.tool(
  'get_links',
  'Returns all public links for a published game/app: web page, Android app download, and owner management page.',
  {
    build_id:    z.string().describe('The build ID returned by publish.'),
    owner_token: z.string().optional().describe('Optional owner token returned by publish. Required to get the management link.'),
  },
  async ({ build_id, owner_token }) => {
    if (!build_id) return { content: [{ type: 'text', text: 'Error: build_id is required.' }] }

    // Get status to retrieve slug
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
    const baseUrl = API_URL

    const pageUrl  = `${baseUrl}/play/${slug}`
    const apkUrl   = `${baseUrl}/builds/v2/${build_id}/apk`
    const ownerUrl = owner_token ? `${baseUrl}/owner/v1/verify?token=${encodeURIComponent(owner_token)}` : null

    const lines = [
      `🎮 **Play in browser:** ${pageUrl}`,
      `📱 **Android APK:** ${apkUrl}`,
    ]

    if (ownerUrl) {
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
