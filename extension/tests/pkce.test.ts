import { describe, expect, it } from 'vitest'
import { b64urlEncode, generateCodeChallenge, generateCodeVerifier, generateState } from '../src/lib/oauth/pkce'
import { createHash } from 'node:crypto'

function nodeB64url(input: string): string {
  return createHash('sha256').update(input).digest('base64url')
}

describe('b64urlEncode', () => {
  it('encodes without padding and url-safe alphabet', () => {
    const out = b64urlEncode(new TextEncoder().encode('subjects?'))
    expect(out).not.toMatch(/[+/=]/)
    // 'subjects?' → base64 c3ViamVjdHM+ then url-safe
    expect(out).toBe('c3ViamVjdHM_')
  })

  it('handles empty input', () => {
    expect(b64urlEncode(new Uint8Array(0))).toBe('')
  })
})

describe('generateCodeVerifier', () => {
  it('is 43 chars (32 bytes base64url) and unique', async () => {
    const a = await generateCodeVerifier()
    const b = await generateCodeVerifier()
    expect(a).toHaveLength(43)
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('generateCodeChallenge', () => {
  it('matches the RFC 7636 S256 test vector', async () => {
    // Appendix B of RFC 7636
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const challenge = await generateCodeChallenge(verifier)
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('agrees with an independent sha256 implementation', async () => {
    const verifier = await generateCodeVerifier()
    expect(await generateCodeChallenge(verifier)).toBe(nodeB64url(verifier))
  })
})

describe('generateState', () => {
  it('produces url-safe values of expected entropy', () => {
    const s = generateState()
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(s.length).toBeGreaterThanOrEqual(21)
  })
})
