import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { OAuthProviderId } from '@inlark/core'

/**
 * Authorization-code flow with PKCE over a loopback redirect. Desktop client IDs are public
 * identifiers read from the environment, so nothing secret lives in the repository and no
 * client secret is involved (public client + PKCE).
 * ponytail: two hosted providers; add an entry here for a third, and per-provider consent
 * only when a provider demands it.
 */
interface ProviderConfig {
  label: string
  clientId: string
  authorize: string
  token: string
  scope: string
  authorizeParams: Record<string, string>
  refreshParams: Record<string, string>
}

/** Only loopback is ever bound; a listener reachable from the LAN could be hijacked. */
export const LOOPBACK_HOST = '127.0.0.1'
const CALLBACK_PATH = '/callback'

const providers: Record<OAuthProviderId, ProviderConfig> = {
  google: {
    label: 'Google',
    clientId: '',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    // Full Gmail access covers IMAP, SMTP and offline refresh in one scope.
    scope: 'https://mail.google.com/',
    authorizeParams: { access_type: 'offline', prompt: 'consent' },
    refreshParams: {},
  },
  microsoft: {
    label: 'Microsoft',
    clientId: '',
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: [
      'offline_access',
      'openid',
      'email',
      'https://outlook.office.com/IMAP.AccessAsUser.All',
      'https://outlook.office.com/SMTP.Send',
    ].join(' '),
    authorizeParams: { response_mode: 'query' },
    refreshParams: {},
  },
}

export function providerConfig(provider: OAuthProviderId): ProviderConfig {
  // Read at call time so a build-time injection cannot leak into the module graph.
  const config = providers[provider]
  const clientId = process.env[clientIdVariable(provider)] || ''
  if (!clientId)
    throw new Error(
      'Sign-in with ' +
        config.label +
        ' is not configured in this build. Use a password or app password instead.',
    )
  return { ...config, clientId }
}
const clientIdVariable = (provider: OAuthProviderId) =>
  'INLARK_' + provider.toUpperCase() + '_CLIENT_ID'

interface Challenge {
  redirectUri: string
  state: string
  codeChallenge: string
}

/** The authorization URL to open in the user's browser. */
export function authorizationUrl(provider: OAuthProviderId, challenge: Challenge): string {
  const config = providerConfig(provider)
  const url = new URL(config.authorize)
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: challenge.redirectUri,
    response_type: 'code',
    scope: config.scope,
    state: challenge.state,
    code_challenge: challenge.codeChallenge,
    code_challenge_method: 'S256',
    ...config.authorizeParams,
  }).toString()
  return url.toString()
}

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => '&' + ({ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#39' })[c]!,
  )
const page = (title: string, body: string) =>
  '<!doctype html><meta charset="utf-8"><title>' +
  escape(title) +
  '</title><body style="font:15px system-ui;margin:4rem auto;max-width:32rem"><h1 style="font-size:1.2rem">' +
  escape(title) +
  '</h1><p>' +
  escape(body) +
  '</p></body>'

const pageFor = (status: number, title: string, body: string) => ({
  status,
  html: page(title, body),
})

export interface StartOAuthOptions {
  /** Opens the authorization URL; the flow itself never touches the UI. */
  open(url: string): void
  timeoutMs?: number
  /** Tests only. */
  fetch?: typeof fetch
}

interface TokenResponse {
  accessToken: string
  refreshToken?: string
  expiresAt?: string
  account?: string
}

/**
 * Runs the whole flow: binds a loopback listener, opens the browser and resolves once the
 * redirect carries a code that exchanges for tokens. Exactly one request on the exact path is
 * accepted, `state` is verified, and the listener then closes.
 */
export function startOAuth(
  provider: OAuthProviderId,
  options: StartOAuthOptions,
): Promise<TokenResponse> {
  const config = providerConfig(provider)
  const state = base64url(randomBytes(32))
  const verifier = base64url(randomBytes(32))
  const codeChallenge = base64url(createHash('sha256').update(verifier).digest())
  const requestFetch = options.fetch || fetch
  let server: Server | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  return new Promise<TokenResponse>((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer)
      // A kept-alive socket would keep close() waiting forever and the listener would leak.
      server?.closeAllConnections()
      server?.close()
      server = undefined
    }
    timer = setTimeout(
      () => {
        stop()
        reject(new Error('Sign-in took too long and was cancelled. Try again when ready.'))
      },
      options.timeoutMs ?? 5 * 60_000,
    )
    server = createServer((request: IncomingMessage, response) => {
      const url = new URL(request.url || '/', 'http://' + LOOPBACK_HOST)
      const done = (page: { status: number; html: string }) => {
        response.writeHead(page.status, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'close',
        })
        response.end(page.html)
      }
      /** Answers the browser with the reason, then fails the flow with the same words. */
      const finish = (page: { status: number; html: string }, error: Error) => {
        // The page must reach the browser before the listener goes away, so the stop and the
        // rejection wait for the response to be flushed.
        response.writeHead(page.status, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'close',
        })
        response.end(page.html, () => {
          stop()
          reject(error)
        })
      }
      // Anything but the callback path is refused without consuming the one-shot flow.
      if (url.pathname !== CALLBACK_PATH)
        return done(pageFor(404, 'Not found', 'Nothing here.'))
      if (request.method !== 'GET')
        return done(pageFor(405, 'Method not allowed', 'Sign-in needs a browser redirect.'))
      const denial = url.searchParams.get('error')
      if (denial)
        return finish(
          pageFor(
            400,
            'Sign-in was not completed',
            url.searchParams.get('error_description') || 'The provider refused the sign-in.',
          ),
          new Error(
            'The sign-in was not completed: ' +
              (url.searchParams.get('error_description') || 'the provider refused it') +
              '. Nothing was saved.',
          ),
        )
      if (url.searchParams.get('state') !== state)
        return finish(
          pageFor(
            400,
            'Sign-in was not completed',
            'This redirect did not come from the request Inlark started. Nothing was saved.',
          ),
          new Error(
            'This sign-in redirect did not come from Inlark. Nothing was saved. Try signing in again.',
          ),
        )
      const code = url.searchParams.get('code')
      if (!code)
        return finish(
          pageFor(400, 'Sign-in was not completed', 'The provider sent no authorization code.'),
          new Error('The sign-in returned no authorization code. Nothing was saved.'),
        )
      done(pageFor(200, 'Signed in', 'You can close this tab and return to Inlark.'))
      exchange(code, verifier, server!.address() as { port: number }).then(
        (tokens) => {
          stop()
          resolve(tokens)
        },
        (error: Error) => {
          stop()
          reject(error)
        },
      )
    })
    server.on('error', (error) => {
      stop()
      reject(new Error('The sign-in page could not be opened: ' + error.message))
    })
    // Loopback only, on an ephemeral port so concurrent sign-ins never collide.
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server!.address()
      if (!address || typeof address === 'string') {
        stop()
        return reject(new Error('Sign-in could not start.'))
      }
      options.open(
        authorizationUrl(provider, {
          redirectUri: redirectUri(address.port),
          state,
          codeChallenge,
        }),
      )
    })
    function exchange(code: string, codeVerifier: string, address: { port: number }) {
      return tokenRequest(
        config,
        {
          grant_type: 'authorization_code',
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri(address.port),
          client_id: config.clientId,
        },
        requestFetch,
      )
    }
  })
}

/**
 * Mints a new access token from a stored refresh token. A rotated refresh token is returned so
 * the caller can replace the stored one; Microsoft keeps the same token, Google may not send it.
 */
export function refreshAccessToken(
  provider: OAuthProviderId,
  refreshToken: string,
  requestFetch: typeof fetch = fetch,
): Promise<TokenResponse> {
  const config = providerConfig(provider)
  return tokenRequest(
    config,
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.clientId,
      ...config.refreshParams,
    },
    requestFetch,
  )
}

const base64url = (bytes: Buffer) => bytes.toString('base64url')
const redirectUri = (port: number) => 'http://' + LOOPBACK_HOST + ':' + port + CALLBACK_PATH

async function tokenRequest(
  config: ProviderConfig,
  body: Record<string, string>,
  requestFetch: typeof fetch,
): Promise<TokenResponse> {
  let response: Response
  try {
    response = await requestFetch(config.token, {
      method: 'POST',
      redirect: 'manual',
      cache: 'no-store',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw new Error('The sign-in provider could not be reached. Check your connection.')
  }
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : ''
  if (!response.ok || !accessToken) throw new Error(tokenRefusal(payload, response.status))
  if (typeof payload.token_type === 'string' && payload.token_type.toLowerCase() !== 'bearer')
    throw new Error('The sign-in returned an unsupported token type.')
  const expiresIn = Number(payload.expires_in)
  const account = typeof payload.id_token === 'string' ? accountFromIdToken(payload.id_token) : undefined
  return {
    accessToken,
    ...(typeof payload.refresh_token === 'string' && payload.refresh_token
      ? { refreshToken: payload.refresh_token }
      : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0
      ? { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() }
      : {}),
    ...(account ? { account } : {}),
  }
}

/** The provider's own words, trimmed, so the user knows whether to retry or fix a grant. */
function tokenRefusal(payload: Record<string, unknown>, status: number): string {
  const detail =
    (typeof payload.error_description === 'string' && payload.error_description) ||
    (typeof payload.error === 'string' && payload.error) ||
    ''
  return detail
    ? 'The sign-in was refused: ' + detail.slice(0, 300)
    : 'The sign-in did not return an access token (HTTP ' +
        status +
        '). Check that this build is allowed to sign in, then try again.'
}

/** Only the address claim is read, and only to show which account was chosen. */
function accountFromIdToken(idToken: string): string | undefined {
  const part = idToken.split('.')[1]
  if (!part) return undefined
  try {
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf-8')) as {
      email?: string
      preferred_username?: string
    }
    const address = claims.email || claims.preferred_username
    return address && /^[^@\s]+@[^@\s]+$/.test(address) ? address : undefined
  } catch {
    return undefined
  }
}

