import { useEffect, useState } from 'react'

// Firebase is loaded only when Messages is opened. The core catch-record
// application stays usable offline, even if the Firebase CDN is unavailable.
const FIREBASE_VERSION = '12.11.0'
const BASE_URL = 'https://www.gstatic.com/firebasejs/' + FIREBASE_VERSION + '/'
const CONFIG_URL = import.meta.env.BASE_URL + 'messaging-config.json'

let sdkPromise = null

function firebaseSdk() {
  if (!sdkPromise) {
    sdkPromise = Promise.all([
      import(/* @vite-ignore */ BASE_URL + 'firebase-app.js'),
      import(/* @vite-ignore */ BASE_URL + 'firebase-auth.js'),
      import(/* @vite-ignore */ BASE_URL + 'firebase-firestore.js'),
    ]).then(([app, auth, firestore]) => ({ app, auth, firestore }))
      .catch((error) => {
        sdkPromise = null
        throw error
      })
  }
  return sdkPromise
}

function timeLabel(value) {
  const date = value?.toDate?.()
  if (!date) return 'Sending…'
  return date.toLocaleString()
}

export default function Messages({ hunterId }) {
  const [online, setOnline] = useState(navigator.onLine)
  const [connection, setConnection] = useState(null)
  const [status, setStatus] = useState('Loading messaging service…')
  const [user, setUser] = useState(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [working, setWorking] = useState(false)
  const [researcher, setResearcher] = useState(false)
  const [hunters, setHunters] = useState([])
  const [activeHunter, setActiveHunter] = useState('')
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let unsubscribeAuth = () => {}

    async function initialize() {
      try {
        // No cloud credentials are bundled into the app by default.
        const response = await fetch(CONFIG_URL, { cache: 'no-store' })
        if (!response.ok) throw new Error('Messaging configuration is missing.')
        const config = await response.json()
        if (!config.enabled || !config.apiKey || !config.projectId ||
            !config.authDomain || !config.appId || !config.researcherUid) {
          if (!disposed) setStatus('Messaging is not configured yet. Ask the researcher to set up Firebase.')
          return
        }
        const sdk = await firebaseSdk()
        if (disposed) return
        const appName = 'wis-messaging'
        const app = sdk.app.getApps().find((item) => item.name === appName) ||
          sdk.app.initializeApp(config, appName)
        const auth = sdk.auth.getAuth(app)
        const db = sdk.firestore.getFirestore(app)
        setConnection({ sdk, auth, db, config })
        setStatus('')
        unsubscribeAuth = sdk.auth.onAuthStateChanged(auth, (currentUser) => {
          if (!disposed) {
            setUser(currentUser)
            setResearcher(currentUser?.uid === config.researcherUid)
            setError('')
          }
        })
      } catch (err) {
        if (!disposed) setStatus('Messaging service unavailable: ' + err.message)
      }
    }
    initialize()
    return () => {
      disposed = true
      unsubscribeAuth()
    }
  }, [])

  // Register each hunter once using their authenticated Firebase UID,
  // never an unverified client-supplied researcher role.
  useEffect(() => {
    if (!connection || !user || researcher || !online) return
    let cancelled = false
    async function ensureProfile() {
      try {
        const { sdk, db } = connection
        const ref = sdk.firestore.doc(db, 'users', user.uid)
        const existing = await sdk.firestore.getDoc(ref)
        if (!existing.exists() && !cancelled) {
          await sdk.firestore.setDoc(ref, {
            hunterId: hunterId?.trim() || 'Hunter',
            createdAt: sdk.firestore.serverTimestamp(),
          })
        }
      } catch (err) {
        if (!cancelled) setError('Profile setup: ' + err.message)
      }
    }
    ensureProfile()
    return () => { cancelled = true }
  }, [connection, user, researcher, online, hunterId])

  useEffect(() => {
    if (!connection || !user || !researcher || !online) {
      setHunters([])
      return
    }
    const { sdk, db } = connection
    const unsubscribe = sdk.firestore.onSnapshot(
      sdk.firestore.collection(db, 'users'),
      (snapshot) => {
        const list = snapshot.docs.map((item) => ({
          uid: item.id, hunterId: item.data().hunterId || item.id,
        })).sort((a, b) => a.hunterId.localeCompare(b.hunterId))
        setHunters(list)
        setActiveHunter((current) =>
          list.some((item) => item.uid === current) ? current : (list[0]?.uid || '')
        )
      },
      (err) => setError('Hunter list: ' + err.message)
    )
    return unsubscribe
  }, [connection, user, researcher, online])

  const threadUid = researcher ? activeHunter : user?.uid

  useEffect(() => {
    if (!connection || !user || !threadUid || !online) {
      setMessages([])
      return
    }
    const { sdk, db } = connection
    const query = sdk.firestore.query(
      sdk.firestore.collection(db, 'threads', threadUid, 'messages'),
      sdk.firestore.orderBy('createdAt', 'desc'),
      sdk.firestore.limit(200)
    )
    const unsubscribe = sdk.firestore.onSnapshot(
      query,
      (snapshot) => {
        setMessages(snapshot.docs.map((item) => ({
          id: item.id, ...item.data(),
        })).reverse())
        setError('')
      },
      (err) => setError('Messages: ' + err.message)
    )
    return unsubscribe
  }, [connection, user, threadUid, online])

  async function signIn(event) {
    event.preventDefault()
    if (!connection || !online) return
    setWorking(true)
    setError('')
    try {
      await connection.sdk.auth.signInWithEmailAndPassword(
        connection.auth, email.trim(), password
      )
      setPassword('')
    } catch (err) {
      setError('Sign-in failed: ' + err.message)
    } finally {
      setWorking(false)
    }
  }

  async function send(event) {
    event.preventDefault()
    const body = draft.trim()
    if (!connection || !user || !threadUid || !online || !body || working) return
    setWorking(true)
    setError('')
    try {
      await connection.sdk.firestore.addDoc(
        connection.sdk.firestore.collection(
          connection.db, 'threads', threadUid, 'messages'
        ),
        {
          text: body,
          senderUid: user.uid,
          createdAt: connection.sdk.firestore.serverTimestamp(),
        }
      )
      setDraft('')
    } catch (err) {
      setError('Send failed: ' + err.message)
    } finally {
      setWorking(false)
    }
  }

  return (
    <section className="card">
      <h2>Messages</h2>
      <p className="muted">
        Online messaging between hunters and the researcher. Catch records remain offline;
        messaging does not upload hunting records.
      </p>
      <p className="muted" role="status">
        Connection: <strong>{online ? 'Online' : 'Offline'}</strong>
      </p>
      {status && <div className="notice">{status}</div>}
      {error && <div className="notice" role="alert">{error}</div>}
      {!online && <div className="notice">Connect to the internet to send or receive messages.</div>}

      {connection && !user && (
        <form onSubmit={signIn}>
          <h3>Sign in</h3>
          <p className="muted">Use the account supplied by the researcher. Do not share passwords.</p>
          <label htmlFor="chat-email">Email</label>
          <input id="chat-email" type="email" autoComplete="username" required
            value={email} onChange={(event) => setEmail(event.target.value)} />
          <label htmlFor="chat-password">Password</label>
          <input id="chat-password" type="password" autoComplete="current-password" required
            value={password} onChange={(event) => setPassword(event.target.value)} />
          <button className="primary-button" type="submit" disabled={working || !online}>
            {working ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      )}

      {connection && user && (
        <>
          <p className="muted">
            Signed in as {user.email} ({researcher ? 'Researcher' : 'Hunter'})
          </p>
          {researcher && (
            <>
              <h3>Select hunter</h3>
              {hunters.length > 0 ? (
                <select value={activeHunter} onChange={(event) => setActiveHunter(event.target.value)}>
                  {hunters.map((item) => (
                    <option key={item.uid} value={item.uid}>{item.hunterId}</option>
                  ))}
                </select>
              ) : <p className="muted">No registered hunters yet. Hunter profiles appear after their first sign-in.</p>}
            </>
          )}

          <div className="chat-log" role="log" aria-label="Conversation">
            {messages.length === 0 && <p className="muted">No messages in this conversation.</p>}
            {messages.map((item) => (
              <div key={item.id}
                className={'chat-message ' + (item.senderUid === user.uid ? 'chat-message-own' : '')}>
                <strong>{item.senderUid === user.uid ? 'You' : (researcher ? 'Hunter' : 'Researcher')}</strong>
                <p>{item.text}</p>
                <small>{timeLabel(item.createdAt)}</small>
              </div>
            ))}
          </div>

          <form onSubmit={send}>
            <label htmlFor="chat-draft">Message</label>
            <textarea id="chat-draft" rows={3} maxLength={2000}
              placeholder="Write your message…" value={draft}
              onChange={(event) => setDraft(event.target.value)} />
            <button className="primary-button" type="submit"
              disabled={!online || !threadUid || !draft.trim() || working}>
              {working ? 'Sending…' : 'Send Message'}
            </button>
          </form>
          <button className="secondary-button" type="button" onClick={() => {
            connection.sdk.auth.signOut(connection.auth).catch((err) => setError(err.message))
          }}>
            Sign out
          </button>
        </>
      )}
    </section>
  )
}
