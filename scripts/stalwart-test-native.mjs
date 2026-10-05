import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Native-Windows variant of stalwart-test.mjs: no container runtime needed.
// Spawns stalwart.exe directly in bootstrap mode instead of `run -d ...`.
const binary = fileURLToPath(new URL('../.stalwart-native/stalwart.exe', import.meta.url))
const workdir = mkdtempSync(join(tmpdir(), 'inlark-test-'))
const config = join(workdir, 'config.json')
const port = process.env.STALWART_TEST_PORT || '8080'
// Native bootstrap binds the standard ports on all interfaces.
const published = { imaps: '993', imap: '143', submissions: '465', submission: '587' }
// Test-only certificate for localhost/127.0.0.1, signed by tests/fixtures/tls/ca.crt.
const tls = fileURLToPath(new URL('../tests/fixtures/tls/', import.meta.url))
const url = 'http://127.0.0.1:' + port
const password = randomUUID()

let child = null
const spawnServer = () => {
  child = spawn(binary, ['--config', config], {
    cwd: workdir,
    env: {
      ...process.env,
      STALWART_PUBLIC_URL: url,
      STALWART_RECOVERY_ADMIN: 'admin:' + password,
    },
    stdio: 'ignore',
  })
}
const stopServer = async () => {
  if (!child || child.exitCode !== null) return
  child.kill()
  await new Promise((r) => {
    const t = setTimeout(r, 5000)
    child.once('exit', () => {
      clearTimeout(t)
      r()
    })
  })
  if (child.exitCode === null) {
    spawnSync('taskkill', ['/F', '/PID', String(child.pid)], { stdio: 'ignore' })
  }
}
const restart = async () => {
  await stopServer()
  spawnServer()
}
const waitForSession = async (auth) => {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(url + '/jmap/session', { headers: { Authorization: auth } })
      if (r.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('Stalwart did not become ready at ' + url)
}
try {
  spawnServer()
  const auth = 'Basic ' + Buffer.from('admin:' + password).toString('base64')
  await waitForSession(auth)
  const response = await fetch(url + '/jmap/', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
      methodCalls: [
        [
          'x:Bootstrap/set',
          {
            update: {
              singleton: {
                serverHostname: 'mail.inlark.test',
                defaultDomain: 'inlark.test',
                requestTlsCertificate: false,
                generateDkimKeys: false,
              },
            },
          },
          'setup',
        ],
      ],
    }),
  })
  const body = await response.json(),
    account = body.methodResponses?.[0]?.[1]?.updated?.singleton
  if (!account?.secret)
    throw new Error('Stalwart bootstrap failed. No account secret was returned.')
  // Serve a certificate the tests trust explicitly, and add the STARTTLS listeners.
  const adminCall = (methodCalls) =>
    fetch(url + '/jmap/', {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
        methodCalls,
      }),
    }).then((r) => r.json())
  await restart()
  await waitForSession(auth)
  const configured = await adminCall([
    [
      'x:Certificate/set',
      {
        create: {
          test: {
            certificate: { '@type': 'Text', value: readFileSync(tls + 'server.crt', 'utf8') },
            privateKey: { '@type': 'Text', secret: readFileSync(tls + 'server.key', 'utf8') },
          },
        },
      },
      'certificate',
    ],
    [
      'x:NetworkListener/set',
      {
        create: {
          imap: {
            name: 'imap',
            bind: { '[::]:143': true },
            protocol: 'imap',
            useTls: true,
            tlsImplicit: false,
          },
          submission: {
            name: 'submission',
            bind: { '[::]:587': true },
            protocol: 'smtp',
            useTls: true,
            tlsImplicit: false,
          },
        },
      },
      'listeners',
    ],
  ])
  for (const [, result] of configured.methodResponses || [])
    if (!result?.created || result.notCreated)
      throw new Error('Stalwart TLS configuration failed: ' + JSON.stringify(result))
  await restart()
  const login = 'Basic ' + Buffer.from(account.username + ':' + account.secret).toString('base64')
  await waitForSession(login)
  const tests = spawnSync('pnpm', ['test:integration'], {
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      STALWART_TEST_URL: url,
      STALWART_TEST_USERNAME: account.username,
      STALWART_TEST_PASSWORD: account.secret,
      STALWART_TEST_IMAPS_PORT: published.imaps,
      STALWART_TEST_IMAP_PORT: published.imap,
      STALWART_TEST_SUBMISSIONS_PORT: published.submissions,
      STALWART_TEST_SUBMISSION_PORT: published.submission,
      STALWART_TEST_CA: tls + 'ca.crt',
    },
  })
  process.exitCode = tests.status || 0
} finally {
  await stopServer()
  rmSync(workdir, { recursive: true, force: true })
}
