import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { AlertCircle, ArrowLeft, Check, LockKeyhole, PenLine, X as Cross } from '@inlark/ui/icons'
import { Button, Checkbox, Spinner } from '@inlark/ui'
import {
  accountSchema,
  friendlyError,
  type Account,
  type Bootstrap,
  type ConnectInput,
  type ConnectionCheck,
  type ConnectionConfig,
  type ConnectionSettings,
  type ConnectionTest,
  type DiscoveryCandidate,
  type DiscoveryResult,
  type DiscoverySource,
  type FolderMappingReview,
  type FolderMappings,
  type OAuthProviderId,
  type OAuthSignIn,
  type Protocol,
  type ServerSettings,
  type TransportSecurity,
} from '@inlark/core'
import { api, isDemo } from './api'
import { queryClient } from './cache'
import { SegmentedControl } from './SegmentedControl'
import { FolderMappingEditor, initialFolderChoices, needsFolderReview } from './FolderMappings'

/** `signIn` repeats a saved connection's login; `edit` opens its server settings for changes. */
export type SetupMode = 'add' | 'signIn' | 'edit'
type ServerKind = 'incoming' | 'outgoing'
type ServerFields = { host: string; port: string; security: TransportSecurity }
interface Fields {
  protocol: Protocol
  serverUrl: string
  incoming: ServerFields
  outgoing: ServerFields
  username: string
  outgoingUsername: string
  sameLogin: boolean
}
/** Where the settings on screen came from, so the user can judge them before signing in. */
type Origin = { kind: 'candidate'; index: number } | { kind: 'saved' } | { kind: 'manual' }

const defaultPorts = {
  incoming: { tls: 993, starttls: 143 },
  outgoing: { tls: 465, starttls: 587 },
} as const
const securityOptions = [
  { value: 'tls', label: 'SSL/TLS' },
  { value: 'starttls', label: 'STARTTLS' },
] as const
const protocolOptions = [
  { value: 'imap', label: 'IMAP and SMTP' },
  { value: 'jmap', label: 'JMAP' },
] as const
const securityLabel = { tls: 'SSL/TLS', starttls: 'STARTTLS' } as const
const sourceLabels: Record<DiscoverySource, string> = {
  'jmap-srv': 'Found in the domain’s DNS records',
  'jmap-well-known': 'Found at the domain’s JMAP address',
  autoconfig: 'From the domain’s published configuration',
  'imap-srv': 'Found in the domain’s DNS records',
  directory: 'From a public directory of mail providers',
}
const sourceLabel = (candidate: DiscoveryCandidate) =>
  candidate.protocol === 'imap' && candidate.provider
    ? 'From ' + candidate.provider + '’s published configuration'
    : sourceLabels[candidate.source]

const blankServer = (kind: ServerKind): ServerFields => ({
  host: '',
  port: String(defaultPorts[kind].tls),
  security: 'tls',
})
const blankFields = (email: string): Fields => ({
  protocol: 'imap',
  serverUrl: '',
  incoming: blankServer('incoming'),
  outgoing: blankServer('outgoing'),
  username: email,
  outgoingUsername: email,
  sameLogin: true,
})
function fieldsFrom(source: ConnectionConfig | DiscoveryCandidate, email: string): Fields {
  if (source.protocol === 'jmap')
    return {
      ...blankFields(email),
      protocol: 'jmap',
      serverUrl: source.serverUrl,
      username: source.username || email,
      outgoingUsername: source.username || email,
    }
  const server = (s: ServerSettings): ServerFields => ({
    host: s.host,
    port: String(s.port),
    security: s.security,
  })
  const username = source.incoming.username || email
  const outgoingUsername = source.outgoing.username || username
  return {
    protocol: 'imap',
    serverUrl: '',
    incoming: server(source.incoming),
    outgoing: server(source.outgoing),
    username,
    outgoingUsername,
    sameLogin:
      'outgoingSameCredentials' in source
        ? source.outgoingSameCredentials
        : outgoingUsername === username,
  }
}
const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
const candidateTitle = (c: DiscoveryCandidate) =>
  c.protocol === 'jmap' ? hostOf(c.serverUrl) : c.provider || c.incoming.host
const emailSchema = z.email()
/** Only the hosted providers Inlark has client IDs for. Everything else uses a password. */
const oauthDomains: Record<string, OAuthProviderId> = {
  'gmail.com': 'google',
  'googlemail.com': 'google',
  'outlook.com': 'microsoft',
  'hotmail.com': 'microsoft',
  'live.com': 'microsoft',
  'msn.com': 'microsoft',
}
const oauthLabels: Record<OAuthProviderId, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
}
const oauthFor = (address: string, saved?: OAuthProviderId): OAuthProviderId | undefined =>
  saved || oauthDomains[(address.split('@')[1] || '').toLowerCase()]
/**
 * Built-in IMAP/SMTP settings for the hosted providers, used when discovery publishes
 * nothing (Gmail/Outlook have no autoconfig/SRV records). No backend change: these become
 * ordinary candidates the existing test/connection flow verifies with XOAUTH2.
 */
const oauthPreset = (address: string): DiscoveryCandidate | undefined => {
  const domain = (address.split('@')[1] || '').toLowerCase()
  const provider = oauthDomains[domain]
  if (!provider || !address.includes('@')) return undefined
  const servers =
    provider === 'google'
      ? {
          incoming: { host: 'imap.gmail.com', port: 993, security: 'tls' as const },
          outgoing: { host: 'smtp.gmail.com', port: 587, security: 'starttls' as const },
          label: 'Google',
        }
      : {
          incoming: { host: 'outlook.office365.com', port: 993, security: 'tls' as const },
          outgoing: { host: 'smtp-mail.outlook.com', port: 587, security: 'starttls' as const },
          label: 'Microsoft',
        }
  return {
    protocol: 'imap',
    source: 'directory',
    incoming: { ...servers.incoming, username: address },
    outgoing: { ...servers.outgoing, username: address },
    provider: servers.label,
  }
}
/** True when the error means this build has no OAuth client ID for the provider. */
const missingClientId = (message: string) => /not configured in this build/i.test(message)

/** The multicolor "G" used on the Google button. Decorative; the label carries the meaning. */
function GoogleMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M23.5 12.3c0-.9-.1-1.5-.3-2.3H12v4.3h6.5c0 1.1-.7 2.7-2.1 3.8l-.1.1 3 2.4.1.1c1.9-1.8 3.1-4.4 3.1-8.4z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.8-2.9c-1 .7-2.4 1.2-4.1 1.2-3.1 0-5.8-2.1-6.8-5l-.1.1-3.1 2.4-.1.1C3.9 21.3 7.7 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.2 14.4c-.2-.7-.4-1.5-.4-2.4s.1-1.7.4-2.4l-.1-.1-3.1-2.4-.1.1C.7 9.4 0 10.6 0 12s.7 2.6 1.9 3.7l3.3-1.3z"
      />
      <path
        fill="#EA4335"
        d="M12 4.7c1.8 0 3 .8 3.7 1.4l3.3-3.2C17.9 1.1 15.2 0 12 0 7.7 0 3.9 2.7 1.9 6.9l3.3 2.8c1-2.9 3.7-5 6.8-5z"
      />
    </svg>
  )
}

function TextField({
  label,
  error,
  hint,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string
  error?: string
  hint?: ReactNode
}) {
  const id = useId()
  return (
    <label className={'form-field' + (className ? ' ' + className : '')}>
      {label}
      <input
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? id : undefined}
        {...props}
      />
      {error ? (
        <span id={id} className="field-error">
          {error}
        </span>
      ) : (
        hint && (
          <span id={id} className="field-hint">
            {hint}
          </span>
        )
      )}
    </label>
  )
}

function CheckRow({
  label,
  host,
  check,
  pending,
}: {
  label: string
  host: string
  check?: ConnectionCheck
  pending: boolean
}) {
  return (
    <li className={'connection-check ' + (check ? (check.ok ? 'ok' : 'failed') : 'pending')}>
      <span className="connection-check-icon">
        {check ? (
          check.ok ? (
            <Check size={13} />
          ) : (
            <Cross size={13} />
          )
        ) : pending ? (
          <Spinner size={12} />
        ) : null}
      </span>
      <strong>{label}</strong>
      <span className="connection-check-host">{host}</span>
      <span className="connection-check-result">
        {check
          ? check.ok
            ? 'Signed in'
            : check.error || 'Sign-in failed'
          : pending
            ? 'Checking…'
            : 'Not checked'}
      </span>
    </li>
  )
}

/** The server settings of a discovered or saved configuration, shown before any password is sent. */
function ServerSummary({ fields }: { fields: Fields }) {
  return fields.protocol === 'jmap' ? (
    <dl className="server-summary">
      <div>
        <dt>Server · JMAP</dt>
        <dd>
          <span className="server-host">{fields.serverUrl}</span>
        </dd>
      </div>
    </dl>
  ) : (
    <dl className="server-summary">
      {(['incoming', 'outgoing'] as const).map((kind) => (
        <div key={kind}>
          <dt>{kind === 'incoming' ? 'Incoming · IMAP' : 'Outgoing · SMTP'}</dt>
          <dd>
            <span className="server-host">{fields[kind].host}</span>
            <span className="server-meta">
              Port {fields[kind].port} · {securityLabel[fields[kind].security]}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function AccountSetup({
  bootstrap,
  existing,
  mode = existing ? 'signIn' : 'add',
  onDone,
  onBack,
}: {
  bootstrap: Bootstrap
  existing?: Account
  mode?: SetupMode
  onDone: (message: string) => void
  onBack: () => void
}) {
  const [phase, setPhase] = useState<'email' | 'server' | 'folders'>(existing ? 'server' : 'email')
  const [email, setEmail] = useState(existing?.email || '')
  const [emailError, setEmailError] = useState('')
  const [discovering, setDiscovering] = useState(false)
  const [discovery, setDiscovery] = useState<DiscoveryResult>()
  const [notice, setNotice] = useState('')
  const [origin, setOrigin] = useState<Origin>({ kind: 'manual' })
  const [editing, setEditing] = useState(mode === 'edit')
  const [fields, setFields] = useState<Fields>(() => blankFields(existing?.email || ''))
  const [password, setPassword] = useState('')
  const [oauth, setOauth] = useState<OAuthSignIn>()
  const [outgoingPassword, setOutgoingPassword] = useState('')
  const [remember, setRemember] = useState(bootstrap.secureStorage)
  const [name, setName] = useState(existing?.name || '')
  const [senderName, setSenderName] = useState(existing?.senderName || '')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'testing' | 'connecting' | 'oauth'>()
  const [test, setTest] = useState<ConnectionTest>()
  const [review, setReview] = useState<FolderMappingReview>()
  const [choices, setChoices] = useState<FolderMappings>({})
  const pending = useRef<ConnectInput>(undefined)
  const lookup = useRef(0)
  const form = useRef<HTMLFormElement>(null)
  const saved = useQuery({
    queryKey: ['connection-settings', existing?.connectionId],
    queryFn: () => api.connectionSettings(existing!.connectionId),
    enabled: !!existing,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })
  const savedSettings: ConnectionSettings | undefined = saved.data
  useEffect(() => {
    if (!existing) return
    if (savedSettings) {
      const address =
        savedSettings.config.protocol === 'imap' ? savedSettings.config.email : existing.email
      setEmail(address)
      setFields(fieldsFrom(savedSettings.config, address))
      setOrigin({ kind: 'saved' })
      setRemember(savedSettings.remember)
      setName(savedSettings.name || existing.name)
    } else if (saved.isError) {
      // Without saved settings, the user can still enter them again.
      setFields({ ...blankFields(existing.email), protocol: existing.protocol || 'jmap' })
      setEditing(true)
      setNotice('The saved server settings couldn’t be loaded. Enter them again below.')
    }
  }, [savedSettings, saved.isError])
  const loadingSaved = !!existing && saved.isPending
  useEffect(() => {
    // The folder step replaces the focused button, so move focus to its first choice.
    if (phase === 'folders')
      requestAnimationFrame(() => document.getElementById('folder-role-sent')?.focus())
  }, [phase])
  const domain = email.split('@')[1] || 'example.com'
  const candidates = discovery?.candidates || []
  const oauthProvider = oauthFor(email, savedSettings?.oauthProvider || oauth?.provider)
  /** The provider for the typed address, so OAuth is offered before any server step. */
  const emailProvider = oauthFor(email.trim())

  /** Any change invalidates an earlier connection check and the message it produced. */
  const changed = (...keys: string[]) => {
    setTest(undefined)
    setError('')
    if (keys.some((key) => errors[key]))
      setErrors((current) => {
        const next = { ...current }
        for (const key of keys) delete next[key]
        return next
      })
  }
  const update = (patch: Partial<Fields>, ...keys: string[]) => {
    setFields((current) => ({ ...current, ...patch }))
    changed(...keys)
  }
  const updateServer = (kind: ServerKind, patch: Partial<ServerFields>, ...keys: string[]) => {
    setFields((current) => ({ ...current, [kind]: { ...current[kind], ...patch } }))
    changed(...keys.map((key) => 'config.' + kind + '.' + key))
  }
  const setSecurity = (kind: ServerKind, security: TransportSecurity) =>
    setFields((current) => {
      const server = current[kind]
      // Follow the standard port unless the user entered their own.
      const standard =
        !server.port.trim() || Number(server.port) === defaultPorts[kind][server.security]
      return {
        ...current,
        [kind]: {
          ...server,
          security,
          port: standard ? String(defaultPorts[kind][security]) : server.port,
        },
      }
    })
  const choose = (index: number, result = discovery) => {
    const candidate = result?.candidates[index]
    if (!candidate) return
    setOrigin({ kind: 'candidate', index })
    setFields((current) => {
      const next = fieldsFrom(candidate, email.trim())
      // A username the user already typed is kept, since they know their login best.
      return current.username && current.username !== email.trim()
        ? { ...next, username: current.username }
        : next
    })
    setEditing(false)
    setErrors({})
    changed()
  }
  const manual = () => {
    setEditing(true)
    setOrigin({ kind: 'manual' })
    setErrors({})
    changed()
  }
  const findSettings = async () => {
    const address = email.trim().toLowerCase()
    if (!emailSchema.safeParse(address).success) {
      setEmailError('Enter a valid email address.')
      return
    }
    const token = ++lookup.current
    setDiscovering(true)
    setEmailError('')
    setNotice('')
    setError('')
    // A token belongs to one account; a new address needs its own sign-in.
    setOauth(undefined)
    try {
      const result = await api.discover(address)
      if (token !== lookup.current) return
      const preset = result.candidates.length ? undefined : oauthPreset(result.email)
      const withPreset: DiscoveryResult = preset ? { ...result, candidates: [preset] } : result
      setDiscovery(withPreset)
      setEmail(result.email)
      if (withPreset.candidates.length) {
        setFields(fieldsFrom(withPreset.candidates[0], result.email))
        setOrigin({ kind: 'candidate', index: 0 })
        setEditing(false)
        if (preset)
          setNotice(
            'Using the built-in settings for ' +
              (preset.protocol === 'imap' ? preset.provider : '') +
              '. Sign in with OAuth below, or enter an app password instead.',
          )
      } else {
        setFields(blankFields(result.email))
        setOrigin({ kind: 'manual' })
        setEditing(true)
        setNotice(
          'No settings are published for ' + result.domain + '. Enter your server details below.',
        )
      }
    } catch (e) {
      if (token !== lookup.current) return
      setDiscovery(undefined)
      setFields(blankFields(address))
      setOrigin({ kind: 'manual' })
      setEditing(true)
      setNotice(
        'Settings for ' +
          (address.split('@')[1] || 'this address') +
          ' couldn’t be looked up. ' +
          friendlyError(e) +
          ' Enter your server details below.',
      )
    } finally {
      if (token === lookup.current) setDiscovering(false)
    }
    setTest(undefined)
    setErrors({})
    setPhase('server')
  }
  const setUpManually = () => {
    const address = email.trim().toLowerCase()
    lookup.current++
    setDiscovering(false)
    setDiscovery(undefined)
    setNotice('')
    setFields((current) => ({
      ...current,
      username: current.username || address,
      outgoingUsername: current.outgoingUsername || address,
    }))
    manual()
    setPhase('server')
  }

  /** Builds and validates the request, marking any field the schema rejects. */
  const validate = (): ConnectInput | undefined => {
    const address = email.trim()
    const config =
      fields.protocol === 'jmap'
        ? {
            protocol: 'jmap' as const,
            serverUrl: fields.serverUrl.trim(),
            username: fields.username.trim(),
          }
        : {
            protocol: 'imap' as const,
            email: address,
            incoming: {
              host: fields.incoming.host,
              port: Number(fields.incoming.port.trim()) || 0,
              security: fields.incoming.security,
              username: fields.username.trim(),
            },
            outgoing: {
              host: fields.outgoing.host,
              port: Number(fields.outgoing.port.trim()) || 0,
              security: fields.outgoing.security,
              username: (fields.sameLogin ? fields.username : fields.outgoingUsername).trim(),
            },
            outgoingSameCredentials: fields.sameLogin,
          }
    const separate = fields.protocol === 'imap' && !fields.sameLogin
    const parsed = accountSchema.safeParse({
      config,
      // An OAuth sign-in stands in for the password; the token itself stays in the main process.
      ...(password ? { password } : {}),
      ...(oauth && !password ? { oauthSessionId: oauth.sessionId } : {}),
      ...(separate && outgoingPassword ? { outgoingPassword } : {}),
      name: name.trim(),
      ...(senderName.trim() ? { senderName: senderName.trim() } : {}),
      remember,
      ...(existing ? { connectionId: existing.connectionId } : {}),
      ...(savedSettings?.folders ? { folders: savedSettings.folders } : {}),
    })
    if (parsed.success) {
      setErrors({})
      return parsed.data
    }
    const found: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.')
      found[key] ??= issue.message
    }
    setErrors(found)
    // Server fields can only show their errors while they are editable.
    if (Object.keys(found).some((key) => key.startsWith('config.'))) setEditing(true)
    requestAnimationFrame(() =>
      form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
    )
    return undefined
  }
  const connect = async (input: ConnectInput) => {
    setBusy('connecting')
    setError('')
    try {
      await api.connect(input)
      await queryClient.invalidateQueries({ queryKey: ['bootstrap'] })
      onDone(
        mode === 'add'
          ? 'Account connected.'
          : mode === 'edit'
            ? 'Connection updated.'
            : 'Signed in.',
      )
    } catch (e) {
      setError(friendlyError(e))
      setBusy(undefined)
    }
  }
  /** Opens the provider's sign-in page and waits for the redirect; no token reaches this window. */
  const signInWith = async (provider: OAuthProviderId) => {
    setBusy('oauth')
    setError('')
    setTest(undefined)
    try {
      const result = await api.beginOAuth(provider)
      setOauth(result)
      // A token is only good for one account; the typed password no longer belongs to it.
      setPassword('')
      setOutgoingPassword('')
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(undefined)
    }
  }
  /**
   * One-click Google flow: skips discovery (Gmail publishes nothing to look up), presets the
   * built-in servers, signs in in the browser, then checks and connects automatically.
   */
  const startGoogleDirect = async () => {
    const address = email.trim().toLowerCase()
    if (!emailSchema.safeParse(address).success) {
      setEmailError('Enter a valid email address.')
      return
    }
    if (oauthFor(address) !== 'google') {
      setEmailError(
        'Continue with Google is for Gmail addresses. Press Continue for other providers.',
      )
      return
    }
    if (busy || discovering) return
    const preset = oauthPreset(address)
    if (!preset) return
    setEmail(address)
    setEmailError('')
    setNotice('Using the built-in settings for Google. Your browser opens the sign-in page.')
    setError('')
    setOauth(undefined)
    setPassword('')
    setOutgoingPassword('')
    setDiscovery({ email: address, domain: address.split('@')[1] || '', candidates: [preset] })
    const next = fieldsFrom(preset, address)
    setFields(next)
    setOrigin({ kind: 'candidate', index: 0 })
    setEditing(false)
    setErrors({})
    setTest(undefined)
    setPhase('server')
    setBusy('oauth')
    let signIn: OAuthSignIn
    try {
      signIn = await api.beginOAuth('google')
    } catch (e) {
      setError(friendlyError(e))
      setBusy(undefined)
      return
    }
    setOauth(signIn)
    const input = buildPresetInput(next, address, signIn)
    if (!input) {
      setBusy(undefined)
      return
    }
    await testAndConnect(input)
  }
  /**
   * Builds a validated connect request from preset fields (same shape as `validate`, but from
   * the given fields instead of state, which has not re-rendered yet when called directly).
   */
  const buildPresetInput = (
    next: Fields,
    address: string,
    signIn: OAuthSignIn,
  ): ConnectInput | undefined => {
    const parsed = accountSchema.safeParse({
      config: {
        protocol: 'imap' as const,
        email: address,
        incoming: {
          host: next.incoming.host,
          port: Number(next.incoming.port.trim()) || 0,
          security: next.incoming.security,
          username: next.username.trim(),
        },
        outgoing: {
          host: next.outgoing.host,
          port: Number(next.outgoing.port.trim()) || 0,
          security: next.outgoing.security,
          username: (next.sameLogin ? next.username : next.outgoingUsername).trim(),
        },
        outgoingSameCredentials: next.sameLogin,
      },
      oauthSessionId: signIn.sessionId,
      name: name.trim(),
      ...(senderName.trim() ? { senderName: senderName.trim() } : {}),
      remember,
      ...(existing ? { connectionId: existing.connectionId } : {}),
      ...(savedSettings?.folders ? { folders: savedSettings.folders } : {}),
    })
    if (parsed.success) {
      setErrors({})
      return parsed.data
    }
    const found: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.')
      found[key] ??= issue.message
    }
    setErrors(found)
    setEditing(true)
    requestAnimationFrame(() =>
      form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
    )
    return undefined
  }
  /** Checks both servers first, confirms folders when needed, then connects. Shared by submit and the Google shortcut. */
  const testAndConnect = async (input: ConnectInput) => {
    if (input.config.protocol === 'jmap') return connect(input)
    // IMAP checks both servers first, so a failure names the server that needs attention.
    setBusy('testing')
    setError('')
    setTest(undefined)
    try {
      const result = await api.testConnection(input)
      setTest(result)
      if (!result.incoming.ok || (result.outgoing && !result.outgoing.ok)) {
        setBusy(undefined)
        return
      }
      pending.current = input
      if (result.folders) {
        // Earlier choices for this connection count as confirmed.
        const known: FolderMappingReview = {
          ...result.folders,
          mappings: { ...result.folders.mappings },
        }
        for (const [role, choice] of Object.entries(savedSettings?.folders || {}))
          known.mappings[role as keyof FolderMappings] = choice && {
            path: choice.path,
            source: 'user',
          }
        if (needsFolderReview(known)) {
          setReview(known)
          setChoices(initialFolderChoices(known))
          setBusy(undefined)
          setPhase('folders')
          return
        }
      }
      await connect(input)
    } catch (e) {
      setError(friendlyError(e))
      setBusy(undefined)
    }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || discovering) return
    if (phase === 'email') return void findSettings()
    if (phase === 'folders') {
      if (pending.current) await connect({ ...pending.current, folders: choices })
      return
    }
    const input = validate()
    if (!input) return
    await testAndConnect(input)
  }

  const title =
    mode === 'edit' ? 'Edit connection' : mode === 'signIn' ? 'Sign in again' : 'Connect an account'
  const accountProblem = existing?.outgoingError
    ? 'Sending unavailable: ' + existing.outgoingError
    : existing && existing.status !== 'connected'
      ? existing.error
      : undefined
  const primaryLabel =
    phase === 'email'
      ? 'Continue'
      : phase === 'folders'
        ? mode === 'add'
          ? 'Connect account'
          : 'Save and sign in'
        : mode === 'add'
          ? 'Connect account'
          : mode === 'edit'
            ? 'Save and sign in'
            : 'Sign in'
  const busyLabel =
    phase === 'email'
      ? 'Continue'
      : busy === 'testing'
        ? 'Checking servers…'
        : busy === 'oauth'
          ? 'Waiting for sign-in…'
          : 'Connecting…'
  const isBusy = discovering || !!busy
  const selected = origin.kind === 'candidate' ? candidates[origin.index] : undefined
  const failed = test && (!test.incoming.ok || (test.outgoing && !test.outgoing.ok))

  return (
    <form className="account-form" ref={form} onSubmit={(e) => void submit(e)} noValidate>
      <Button variant="ghost" size="small" className="account-form-back" onClick={onBack}>
        <ArrowLeft size={13} />
        Back to accounts
      </Button>
      <header className="account-form-title">
        <h3>{phase === 'folders' ? 'Check folders' : title}</h3>
        {phase === 'email' ? (
          <p>
            Enter your email address and Inlark looks up your server settings. You’ll see them
            before your password is sent anywhere.
          </p>
        ) : phase === 'folders' ? (
          <p>
            Some folders on {review && fields.incoming.host} couldn’t be confirmed. Choose where
            Inlark keeps sent mail and drafts, and where Archive, Mark as spam and Move to trash put
            conversations. You can change this later.
          </p>
        ) : (
          <p className="account-form-address">
            <span>{email}</span>
            {mode === 'add' && (
              <button
                type="button"
                className="text-action"
                onClick={() => {
                  setPhase('email')
                  setError('')
                }}
              >
                Change
              </button>
            )}
          </p>
        )}
      </header>
      {accountProblem && phase === 'server' && (
        <div className="form-error account-form-problem">
          <AlertCircle size={14} />
          <span>{accountProblem}</span>
        </div>
      )}

      {phase === 'email' && (
        <section className="account-form-section">
          <TextField
            label="Email address"
            type="email"
            autoFocus
            autoComplete="email"
            spellCheck={false}
            placeholder="you@example.com"
            value={email}
            error={emailError}
            onChange={(e) => {
              setEmail(e.target.value)
              setEmailError('')
            }}
          />
          <div className="setup-lookup" role="status">
            {discovering && (
              <>
                <Spinner size={12} />
                Looking up settings for {email.split('@')[1] || 'your address'}…
              </>
            )}
          </div>
          {emailProvider && emailProvider !== 'google' && (
            <div className="form-notice setup-notice" role="status">
              <AlertCircle size={14} />
              <span>
                You typed an {oauthLabels[emailProvider]} address. {oauthLabels[emailProvider]}{' '}
                sign-in isn’t set up in this build yet — press Continue and use a password or app
                password, or use a Gmail address with the button above.
              </span>
            </div>
          )}
          <div className="setup-oauth">
            <div className="setup-provider-buttons">
              <Button
                onClick={() => void startGoogleDirect()}
                disabled={isBusy || isDemo}
                className="setup-oauth-button"
              >
                {busy === 'oauth' ? <Spinner size={13} /> : <GoogleMark />}
                Continue with Google
              </Button>
              <Button disabled className="setup-oauth-button">
                Continue with Microsoft
              </Button>
            </div>
            <p className="field-hint">
              {isDemo
                ? 'Provider sign-in needs the desktop app — this preview uses demo accounts.'
                : 'Recommended for Gmail — your browser opens a Google sign-in page and Inlark never sees your password. Microsoft needs an Azure app key first. Prefer a password or another provider? Press Continue.'}
            </p>
            {missingClientId(error) && (
              <div className="form-notice setup-notice" role="status">
                <AlertCircle size={14} />
                <span>
                  This build has no Google sign-in key (INLARK_GOOGLE_CLIENT_ID is unset). Add it to
                  apps/desktop/.env.local and restart the app, or press Continue and use an app
                  password instead.
                </span>
              </div>
            )}
          </div>
        </section>
      )}

      {phase === 'server' &&
        (loadingSaved ? (
          <div className="setup-lookup" role="status">
            <Spinner size={12} />
            Loading saved settings…
          </div>
        ) : (
          <>
            <section className="account-form-section">
              <div className="account-form-section-heading">
                <h4>Server</h4>
                {editing ? (
                  (candidates.length > 0 || savedSettings) &&
                  mode !== 'edit' && (
                    <Button
                      variant="ghost"
                      size="small"
                      onClick={() => {
                        if (savedSettings && !candidates.length) {
                          setFields(fieldsFrom(savedSettings.config, email))
                          setOrigin({ kind: 'saved' })
                          setEditing(false)
                          setErrors({})
                          changed()
                        } else choose(origin.kind === 'candidate' ? origin.index : 0)
                      }}
                    >
                      {savedSettings && !candidates.length
                        ? 'Use saved settings'
                        : 'Use found settings'}
                    </Button>
                  )
                ) : (
                  <Button variant="ghost" size="small" onClick={() => setEditing(true)}>
                    <PenLine size={12} />
                    Edit settings
                  </Button>
                )}
              </div>
              {notice && (
                <div className="form-notice setup-notice" role="status">
                  <AlertCircle size={14} />
                  <span>{notice}</span>
                </div>
              )}
              {!editing && candidates.length > 1 && (
                <div
                  className="server-options"
                  role="radiogroup"
                  aria-label="Server settings found"
                >
                  {candidates.map((candidate, index) => (
                    <label
                      key={index}
                      className={
                        'server-option' +
                        (origin.kind === 'candidate' && origin.index === index ? ' chosen' : '')
                      }
                    >
                      <input
                        type="radio"
                        className="sr-only"
                        name="server-candidate"
                        checked={origin.kind === 'candidate' && origin.index === index}
                        onChange={() => choose(index)}
                      />
                      <span className="theme-radio" aria-hidden="true" />
                      <span className="protocol-tag">{candidate.protocol.toUpperCase()}</span>
                      <span className="server-option-title">{candidateTitle(candidate)}</span>
                      <span className="server-option-source">{sourceLabel(candidate)}</span>
                    </label>
                  ))}
                </div>
              )}
              {!editing && (
                <div className="server-card">
                  {candidates.length < 2 && (
                    <div className="server-card-heading">
                      <span className="protocol-tag">
                        {fields.protocol === 'jmap' ? 'JMAP' : 'IMAP · SMTP'}
                      </span>
                      <span className="server-card-source">
                        {selected
                          ? sourceLabel(selected)
                          : origin.kind === 'saved'
                            ? 'Saved settings'
                            : 'Entered manually'}
                      </span>
                    </div>
                  )}
                  <ServerSummary fields={fields} />
                </div>
              )}
              {editing && (
                <div className="server-fields">
                  <div className="form-field">
                    <span className="form-label">Protocol</span>
                    <SegmentedControl
                      label="Protocol"
                      value={fields.protocol}
                      options={protocolOptions}
                      onChange={(protocol) => update({ protocol })}
                    />
                  </div>
                  {fields.protocol === 'jmap' ? (
                    <TextField
                      label="Server URL"
                      type="url"
                      autoFocus={mode !== 'edit'}
                      spellCheck={false}
                      placeholder={'https://mail.' + domain}
                      value={fields.serverUrl}
                      error={errors['config.serverUrl']}
                      hint="A server address or a full JMAP session URL."
                      onChange={(e) => update({ serverUrl: e.target.value }, 'config.serverUrl')}
                    />
                  ) : (
                    (['incoming', 'outgoing'] as const).map((kind) => (
                      <fieldset className="server-group" key={kind}>
                        <legend>
                          {kind === 'incoming' ? 'Incoming mail · IMAP' : 'Outgoing mail · SMTP'}
                        </legend>
                        <div className="server-row">
                          <TextField
                            label="Server"
                            autoFocus={kind === 'incoming' && mode !== 'edit'}
                            spellCheck={false}
                            autoCapitalize="off"
                            placeholder={(kind === 'incoming' ? 'imap.' : 'smtp.') + domain}
                            value={fields[kind].host}
                            error={errors['config.' + kind + '.host']}
                            onChange={(e) => updateServer(kind, { host: e.target.value }, 'host')}
                          />
                          <TextField
                            label="Port"
                            inputMode="numeric"
                            className="port-field"
                            value={fields[kind].port}
                            error={errors['config.' + kind + '.port']}
                            onChange={(e) =>
                              updateServer(
                                kind,
                                { port: e.target.value.replace(/\D/g, '').slice(0, 5) },
                                'port',
                              )
                            }
                          />
                          <div className="form-field">
                            <span className="form-label">Security</span>
                            <SegmentedControl
                              label={
                                (kind === 'incoming' ? 'Incoming' : 'Outgoing') + ' server security'
                              }
                              value={fields[kind].security}
                              options={securityOptions}
                              onChange={(security) => {
                                setSecurity(kind, security)
                                changed('config.' + kind + '.port')
                              }}
                            />
                          </div>
                        </div>
                      </fieldset>
                    ))
                  )}
                </div>
              )}
            </section>

            <section className="account-form-section">
              <h4>Sign in</h4>
              {oauthProvider && (
                <div className="setup-oauth">
                  {oauth ? (
                    <p className="setup-oauth-done">
                      <Check size={13} />
                      <span>
                        Signed in with {oauthLabels[oauth.provider]}. Your access token stays in
                        memory and is never written to this device.
                      </span>
                    </p>
                  ) : (
                    <Button
                      onClick={() => void signInWith(oauthProvider)}
                      disabled={isBusy}
                      className="setup-oauth-button"
                    >
                      {busy === 'oauth' ? <Spinner size={13} /> : null}
                      Sign in with {oauthLabels[oauthProvider]}
                    </Button>
                  )}
                  <p className="field-hint">
                    {oauth
                      ? 'Continue to connect this account.'
                      : 'Your browser opens a sign-in page. Inlark never sees your password there.'}
                  </p>
                  {oauthProvider && missingClientId(error) && (
                    <div className="form-notice setup-notice" role="status">
                      <AlertCircle size={14} />
                      <span>
                        This build has no sign-in key for {oauthLabels[oauthProvider]} (
                        {'INLARK_' + oauthProvider.toUpperCase() + '_CLIENT_ID'} is unset). Either
                        rebuild with the key, or use an app password instead: create one in your{' '}
                        {oauthProvider === 'google' ? 'Google Account' : 'Microsoft account'}{' '}
                        security settings and enter it in the password field.
                      </span>
                    </div>
                  )}
                </div>
              )}
              <div className="form-row">
                <TextField
                  label="Username"
                  autoComplete="username"
                  spellCheck={false}
                  autoCapitalize="off"
                  value={fields.username}
                  error={
                    errors['config.username'] ||
                    errors['config.incoming.username'] ||
                    (fields.sameLogin ? errors['config.outgoing.username'] : undefined)
                  }
                  onChange={(e) =>
                    update(
                      { username: e.target.value },
                      'config.username',
                      'config.incoming.username',
                      'config.outgoing.username',
                    )
                  }
                />
                {!oauth && (
                  <TextField
                    label="Password or app password"
                    type="password"
                    autoComplete="current-password"
                    autoFocus={!editing}
                    placeholder="Your password"
                    value={password}
                    error={errors.password}
                    onChange={(e) => {
                      setPassword(e.target.value)
                      changed('password')
                    }}
                  />
                )}
              </div>
              {fields.protocol === 'imap' && (
                <>
                  <label className="checkbox-label">
                    <Checkbox
                      checked={fields.sameLogin}
                      onCheckedChange={(sameLogin) =>
                        update({ sameLogin }, 'outgoingPassword', 'config.outgoing.username')
                      }
                    />
                    Outgoing server uses the same login
                  </label>
                  {!fields.sameLogin && (
                    <div className="form-row">
                      <TextField
                        label="Outgoing username"
                        autoComplete="off"
                        spellCheck={false}
                        autoCapitalize="off"
                        value={fields.outgoingUsername}
                        error={errors['config.outgoing.username']}
                        onChange={(e) =>
                          update({ outgoingUsername: e.target.value }, 'config.outgoing.username')
                        }
                      />
                      {!oauth && (
                        <TextField
                          label="Outgoing password"
                          type="password"
                          autoComplete="off"
                          placeholder="Outgoing server password"
                          value={outgoingPassword}
                          error={errors.outgoingPassword}
                          onChange={(e) => {
                            setOutgoingPassword(e.target.value)
                            changed('outgoingPassword')
                          }}
                        />
                      )}
                    </div>
                  )}
                </>
              )}
              <label className="checkbox-label">
                <Checkbox
                  checked={remember}
                  disabled={isDemo}
                  onCheckedChange={(checked) => setRemember(checked)}
                />
                {bootstrap.secureStorage
                  ? 'Remember this login in the OS keyring'
                  : 'Remember this login on this device'}
              </label>
              {!bootstrap.secureStorage && (
                <div className="form-notice">
                  <LockKeyhole size={14} />
                  <span>
                    {isDemo
                      ? 'Demo accounts stay in this window and never connect to a server.'
                      : 'No OS keyring is available. If you remember this login, your password will be saved unencrypted in a file accessible to your user account. Leave the box unchecked for session-only login.'}
                  </span>
                </div>
              )}
            </section>

            {mode === 'add' && (
              <section className="account-form-section">
                <h4>How it appears</h4>
                <div className="form-row">
                  <TextField
                    label="Label"
                    placeholder="Personal"
                    maxLength={100}
                    hint="Only you see this."
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                  <TextField
                    label="Your name"
                    placeholder="Jane Doe"
                    autoComplete="name"
                    maxLength={100}
                    value={senderName}
                    onChange={(e) => setSenderName(e.target.value)}
                    hint={
                      <>
                        Recipients see{' '}
                        <span className="sender-preview">
                          {(senderName.trim() || 'your server’s name') + ' <' + email + '>'}
                        </span>
                      </>
                    }
                  />
                </div>
              </section>
            )}

            {fields.protocol === 'imap' && (busy === 'testing' || test) && (
              <section className="account-form-section" aria-live="polite">
                <h4>Connection check</h4>
                <ul className="connection-checks">
                  <CheckRow
                    label="Incoming"
                    host={fields.incoming.host}
                    check={test?.incoming}
                    pending={busy === 'testing'}
                  />
                  <CheckRow
                    label="Outgoing"
                    host={fields.outgoing.host}
                    check={test?.outgoing}
                    pending={busy === 'testing'}
                  />
                </ul>
                {failed && (
                  <p className="connection-check-hint">
                    Nothing was saved. Check the password or the server settings above, then try
                    again.
                  </p>
                )}
              </section>
            )}
          </>
        ))}

      {phase === 'folders' && review && (
        <section className="account-form-section">
          <FolderMappingEditor
            review={review}
            value={choices}
            onChange={setChoices}
            disabled={!!busy}
          />
        </section>
      )}

      {error && (
        <div role="alert" className="form-error">
          <AlertCircle size={14} />
          <span>{error}</span>
        </div>
      )}
      <footer className="account-form-footer">
        {phase === 'email' && (
          <Button variant="ghost" className="account-form-manual" onClick={setUpManually}>
            Set up manually
          </Button>
        )}
        {phase === 'folders' ? (
          <Button onClick={() => setPhase('server')} disabled={!!busy}>
            Back
          </Button>
        ) : (
          <Button onClick={onBack}>Cancel</Button>
        )}
        <Button type="submit" variant="primary" disabled={isBusy || loadingSaved}>
          {isBusy ? (
            <>
              <Spinner size={14} />
              {busyLabel}
            </>
          ) : (
            primaryLabel
          )}
        </Button>
      </footer>
    </form>
  )
}
