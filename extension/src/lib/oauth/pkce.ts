export function b64urlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

/** RFC 7636: verifier is 43-128 chars of unreserved characters. */
export async function generateCodeVerifier(): Promise<string> {
  return b64urlEncode(randomBytes(32))
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return b64urlEncode(new Uint8Array(digest))
}

/** OAuth state parameter; also used for the anti-CSRF check on redirect. */
export function generateState(): string {
  return b64urlEncode(randomBytes(16))
}
