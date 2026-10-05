import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { authorizationUrl, refreshAccessToken, startOAuth } from '../apps/desktop/src/main/oauth'

const clientId = 'test-client.apps.googleusercontent.com'

/** A token endpoint that records the request and answers with a canned token. */
const tokenEndpoint = (response: Record<string, unknown>) => {
  const calls: URLSearchParams[] = []
  const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(new URLSearchParams(String(init?.body || '')))
    return new Response(JSON.stringify(response), {
      status: response.error ? 400 : 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fake, calls }
}

/** Waits until the flow has handed an authorization URL to the browser. */
async function waitForUrl(url: () => string): Promise<string> {
  for (let i = 0; i < 100 && !url(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(url(), 'the flow never opened a browser').toBeTruthy()
  return url()
}

/** Fetches the loopback redirect exactly as a browser would. */
async function redirect(url: string) {
  const response = await fetch(url, { redirect: 'manual' })
  return { status: response.status, body: await response.text() }
}

beforeEach(() => {
  process.env.INLARK_GOOGLE_CLIENT_ID = clientId
})
afterEach(() => {
  delete process.env.INLARK_GOOGLE_CLIENT_ID
  delete process.env.INLARK_MICROSOFT_CLIENT_ID
})

describe('OAuth authorization', () => {
  it('asks for a PKCE challenge on a loopback redirect', () => {
    const url = new URL(
      authorizationUrl('google', {
        redirectUri: 'http://127.0.0.1:51234/callback',
        state: 'st',
        codeChallenge: 'ch',
      }),
    )
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe('ch')
    expect(url.searchParams.get('state')).toBe('st')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:51234/callback')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('client_id')).toBe(clientId)
    // No client secret is ever involved: this is a public desktop client.
    expect(url.search).not.toContain('secret')
  })

  it('exchanges the code for tokens and binds only to loopback', async () => {
    const { fake, calls } = tokenEndpoint({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
      token_type: 'Bearer',
    })
    let opened = ''
    const flow = startOAuth('google', { open: (url) => void (opened = url), fetch: fake })
    // The flow must not resolve until the redirect arrives.
    let done = false
    void flow.then(() => (done = true))
    await new Promise((r) => setTimeout(r, 20))
    expect(done).toBe(false)

    const challenge = new URL(opened).searchParams.get('code_challenge')!
    const state = new URL(opened).searchParams.get('state')!
    const redirectUri = new URL(opened).searchParams.get('redirect_uri')!
    // The browser is sent to the provider, which redirects only to this machine.
    expect(new URL(opened).hostname).toBe('accounts.google.com')
    expect(redirectUri.startsWith('http://127.0.0.1:')).toBe(true)
    const page = await redirect(
      redirectUri + '?code=the-code&state=' + encodeURIComponent(state),
    )
    expect(page.status).toBe(200)
    expect(page.body).not.toContain('the-code')

    const tokens = await flow
    expect(tokens.accessToken).toBe('access-1')
    expect(tokens.refreshToken).toBe('refresh-1')
    expect(Date.parse(tokens.expiresAt!)).toBeGreaterThan(Date.now())
    const sent = calls[0]
    expect(sent.get('grant_type')).toBe('authorization_code')
    expect(sent.get('code')).toBe('the-code')
    expect(sent.get('redirect_uri')).toBe(redirectUri)
    expect(sent.get('client_id')).toBe(clientId)
    expect(sent.get('secret')).toBeNull()
    // The verifier sent to the server must hash to the challenge shown in the browser.
    expect(createHash('sha256').update(sent.get('code_verifier')!).digest('base64url')).toBe(
      challenge,
    )
  })

  it('refuses a redirect that did not come from its own request', async () => {
    const { fake, calls } = tokenEndpoint({ access_token: 'never' })
    let opened = ''
    const flow = startOAuth('google', { open: (url) => void (opened = url), fetch: fake })
    // The flow can fail the moment the browser is answered, before the assertion attaches.
    void flow.catch(() => undefined)
    const redirectUri = new URL(await waitForUrl(() => opened)).searchParams.get('redirect_uri')!
    const page = await redirect(redirectUri + '?code=the-code&state=someone-elses-state')
    expect(page.status).toBe(400)
    await expect(flow).rejects.toThrow(/did not come from Inlark/)
    expect(calls).toHaveLength(0)
  })

  it('reports a refused sign-in without exchanging anything', async () => {
    const { fake, calls } = tokenEndpoint({ access_token: 'x' })
    let opened = ''
    const flow = startOAuth('google', { open: (url) => void (opened = url), fetch: fake })
    void flow.catch(() => undefined)
    const redirectUri = new URL(await waitForUrl(() => opened)).searchParams.get('redirect_uri')!
    const page = await redirect(redirectUri + '?error=access_denied&error_description=No+thanks')
    expect(page.status).toBe(400)
    expect(page.body).toContain('No thanks')
    await expect(flow).rejects.toThrow(/No thanks/)
    expect(calls).toHaveLength(0)
  })

  it('names a provider that is not configured instead of failing obscurely', () => {
    delete process.env.INLARK_GOOGLE_CLIENT_ID
    expect(() =>
      authorizationUrl('google', { redirectUri: 'x', state: 'y', codeChallenge: 'z' }),
    ).toThrow(/not configured in this build/)
  })

  it('mints a new token from a refresh token without asking the user again', async () => {
    const { fake, calls } = tokenEndpoint({ access_token: 'access-2', token_type: 'Bearer' })
    const tokens = await refreshAccessToken('google', 'refresh-1', fake)
    expect(tokens.accessToken).toBe('access-2')
    expect(calls[0].get('grant_type')).toBe('refresh_token')
    expect(calls[0].get('refresh_token')).toBe('refresh-1')
    // No code was involved, so no verifier and no redirect may be sent.
    expect(calls[0].get('code_verifier')).toBeNull()
    expect(calls[0].get('redirect_uri')).toBeNull()
  })
})