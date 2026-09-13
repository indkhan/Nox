import { describe, expect, it } from 'vitest'
import manifest from '../manifest.config'

describe('extension-page content security policy', () => {
  it('allows only packaged resources and the verified Notion MCP endpoint', () => {
    const policy = (manifest as { content_security_policy?: { extension_pages?: string } }).content_security_policy?.extension_pages
    expect(policy).toContain("default-src 'self'")
    expect(policy).toContain("img-src 'self'")
    expect(policy).toContain("media-src 'none'")
    expect(policy).toContain("object-src 'none'")
    expect(policy).toContain("frame-src 'none'")
    expect(policy).toContain('connect-src https://mcp.notion.com')
    // No unverified upload origin: the MCP ticket envelope has no live
    // fixture, so no upload destination may be allowlisted (Epoch 08).
    expect(policy).not.toContain('uploads.notion.com')
    expect(policy).not.toContain("script-src 'unsafe-inline'")
    expect(policy).not.toContain("script-src 'unsafe-eval'")
  })
})
