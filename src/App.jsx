import { useEffect, useMemo, useRef, useState } from 'react'
import {
  MapContainer,
  TileLayer,
  Circle,
  Popup,
  useMap,
} from 'react-leaflet'

import 'leaflet/dist/leaflet.css'
import './App.css'

// ============================================================
// WIs App v3.0
// ============================================================

const SPECIES = [
  { id: 'blue', name: 'Blue duiker', icon: '🦌' },
  { id: 'peters', name: "Peters's duiker", icon: '🦌' },
  { id: 'bay', name: 'Bay duiker', icon: '🦌' },
  { id: 'porcupine', name: 'Brush-tailed porcupine', icon: '🐾' },
  { id: 'rat', name: "Emin's pouched rat", icon: '🐀' },
]

const IDS = SPECIES.map((s) => s.id)
const METHODS = ['Gun', 'Snare', 'Other']
const PERIODS = ['Morning', 'Afternoon', 'Night', 'Unknown']

const EMPTY = () =>
  Object.fromEntries(IDS.map((id) => [id, 0]))

const EMPTY_BY_METHOD = () =>
  Object.fromEntries(METHODS.map((m) => [m, EMPTY()]))

const DB_NAME = 'wis-app-records-v1'
const STORE = 'records'
const SETTINGS_KEY = 'wis-app-settings-v2'
const SETTINGS_PASSWORD = '6918'

const DEFAULT_SETTINGS = {
  hunterId: '',
  clusterDistance: 30,
  circleRadius: 30,
  maxGpsAccuracy: 100,
  colorMin: 0,
  colorMax: 3,

  masses: {
    blue: 4.5,
    peters: 16.3,
    bay: 16.3,
    porcupine: 2.8,
    rat: 1.0,
  },

  // Values previously identified from secondary
  // tabulation attributed to Fa et al. (2015).
  // Verify against the original source before publication.
  rmax: {
    blue: 0.49,
    peters: 0.44,
    bay: 0.20,
    porcupine: 0.80,
    rat: 0.70,
  },
}

const INDICATORS = [
  ['rb', 'R/B ratio'],
  ['red', 'Red proportion'],
  ['dr', 'D/R ratio'],
  ['duiker', 'Duiker proportion'],
  ['mass', 'Mean body mass (kg)'],
  ['rmax', 'Reciprocal mean-rmax'],
  ['gunCpue', 'Gun CPUE'],
  ['snareCpue', 'Snare CPUE'],
]

// ============================================================
// IndexedDB
// ============================================================

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)

    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }

    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function databaseAction(action, data) {
  const db = await openDb()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      STORE,
      action === 'read' ? 'readonly' : 'readwrite'
    )
    const store = tx.objectStore(STORE)
    let result

    if (action === 'read') {
      const req = store.getAll()
      req.onsuccess = () => { result = req.result }
    } else if (action === 'put') {
      store.put(data)
    } else if (action === 'delete') {
      store.delete(data)
    } else if (action === 'putMany') {
      for (const item of data) store.put(item)
    }

    tx.oncomplete = () => {
      db.close()
      resolve(result)
    }
    tx.onerror = () => {
      db.close()
      reject(tx.error)
    }
    tx.onabort = () => {
      db.close()
      reject(tx.error || new Error('Transaction aborted'))
    }
  })
}

// ============================================================
// Utilities
// ============================================================

function today(offset = 0) {
  const d = new Date()
  d.setDate(d.getDate() - offset)

  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-')
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false

  const [y, m, d] = value.split('-').map(Number)
  const x = new Date(y, m - 1, d)

  return (
    x.getFullYear() === y &&
    x.getMonth() + 1 === m &&
    x.getDate() === d &&
    value <= today()
  )
}

function cleanCounts(input = {}) {
  return Object.fromEntries(
    IDS.map((id) => {
      const value = Number(input[id] ?? 0)
      return [
        id,
        Number.isInteger(value) && value >= 0 ? value : 0,
      ]
    })
  )
}

function cleanByMethod(input = {}) {
  return Object.fromEntries(
    METHODS.map((method) => [
      method,
      cleanCounts(input[method] || {}),
    ])
  )
}

// Compatibility with older WIs App records.
// Their single huntingMethod is assigned to all species counts.
function getByMethod(record) {
  if (record.byMethod) {
    return cleanByMethod(record.byMethod)
  }

  const result = EMPTY_BY_METHOD()
  const method =
    record.huntingMethod || record.method || 'Other'

  if (METHODS.includes(method)) {
    result[method] = cleanCounts(record.counts)
  }

  return result
}

function countTotal(counts) {
  return IDS.reduce((sum, id) => sum + (counts[id] || 0), 0)
}

function totalsOf(records) {
  const totals = EMPTY()

  for (const record of records) {
    const matrix = getByMethod(record)

    for (const method of METHODS) {
      for (const id of IDS) {
        totals[id] += matrix[method][id]
      }
    }
  }

  return totals
}

function totalsByMethod(records, method) {
  const totals = EMPTY()

  for (const record of records) {
    const matrix = getByMethod(record)
    for (const id of IDS) totals[id] += matrix[method][id]
  }

  return totals
}

function sorted(records) {
  return [...records].sort((a, b) =>
    (b.recordedAt || '').localeCompare(b.recordedAt || '')
  )
}

function fmt(value, digits = 3) {
  return value == null || !Number.isFinite(value)
    ? 'N/A'
    : Number(value).toFixed(digits)
}

function blankForm() {
  return {
    id: null,
    captureDate: today(),
    period: 'Morning',
    byMethod: EMPTY_BY_METHOD(),
    gunEffort: '',
    snareEffort: '',
    note: '',
    previousLocation: null,
  }
}

// ============================================================
// Wildlife Indicators
// ============================================================

function calculateIndicators(counts, settings) {
  const blue = counts.blue
  const red = counts.peters + counts.bay
  const duikers = red + blue
  const rodents = counts.porcupine + counts.rat
  const total = duikers + rodents

  const ratio = (a, b) => b > 0 ? a / b : null

  function weighted(key) {
    if (total === 0) return null

    let sum = 0

    for (const id of IDS) {
      if (counts[id] === 0) continue

      const raw = settings[key]?.[id]
      const value = Number(raw)

      if (
        raw === '' ||
        raw == null ||
        !Number.isFinite(value) ||
        value <= 0
      ) {
        return null
      }

      sum += counts[id] * value
    }

    return sum / total
  }

  const mass = weighted('masses')
  const meanRmax = weighted('rmax')

  return {
    rb: ratio(red, blue),
    red: ratio(red, duikers),
    dr: ratio(duikers, rodents),
    duiker: ratio(duikers, total),
    mass,
    rmax: meanRmax > 0 ? 1 / meanRmax : null,
    total,
  }
}

function cpue(records, method) {
  const key = method === 'Gun' ? 'gunEffort' : 'snareEffort'
  const unit = method === 'Gun' ? 'hunter-day' : 'trap-night'

  let catchCount = 0
  let effort = 0

  for (const record of records) {
    const value =
      record[key] ??
      (
        (record.huntingMethod || record.method) === method &&
        record.effortUnit === unit
          ? record.effort
          : null
      )

    // Exclude records with missing effort.
    if (
      value === '' ||
      value == null ||
      !Number.isFinite(Number(value)) ||
      Number(value) <= 0
    ) continue

    effort += Number(value)
    catchCount += countTotal(getByMethod(record)[method])
  }

  return effort > 0 ? catchCount / effort : null
}

// ============================================================
// GPS
// ============================================================

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation unavailable'))
      return
    }

    navigator.geolocation.getCurrentPosition(
      (p) => resolve({
        latitude: p.coords.latitude,
        longitude: p.coords.longitude,
        accuracy: p.coords.accuracy,
        timestamp: new Date(p.timestamp).toISOString(),
      }),
      reject,
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 30000,
      }
    )
  })
}

function validLocation(p) {
  return (
    p &&
    Number.isFinite(Number(p.latitude)) &&
    Number.isFinite(Number(p.longitude)) &&
    Math.abs(Number(p.latitude)) <= 90 &&
    Math.abs(Number(p.longitude)) <= 180
  )
}

const EARTH_R = 6371000
const rad = (x) => x * Math.PI / 180

function distance(a, b) {
  const dLat = rad(b.latitude - a.latitude)
  const dLon = rad(b.longitude - a.longitude)

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) *
    Math.cos(rad(b.latitude)) *
    Math.sin(dLon / 2) ** 2

  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)))
}

// Complete-linkage clustering.
// Every pair of GPS points in a cluster remains within threshold.
function clusterRecords(records, threshold) {
  let groups = records
    .filter((r) => validLocation(r.location))
    .map((r) => [r])

  function maximumDistance(a, b) {
    let max = 0
    for (const x of a) {
      for (const y of b) {
        max = Math.max(max, distance(x.location, y.location))
      }
    }
    return max
  }

  while (groups.length > 1) {
    let best = null
    let min = Infinity

    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const d = maximumDistance(groups[i], groups[j])
        if (d <= threshold && d < min) {
          min = d
          best = [i, j]
        }
      }
    }

    if (!best) break

    const [i, j] = best
    const merged = [...groups[i], ...groups[j]]

    groups = groups.filter((_, k) => k !== i && k !== j)
    groups.push(merged)
  }

  return groups.map((group, index) => ({
    id: index + 1,
    records: group,
    latitude:
      group.reduce((s, r) => s + r.location.latitude, 0) /
      group.length,
    longitude:
      group.reduce((s, r) => s + r.location.longitude, 0) /
      group.length,
  }))
}

// ============================================================
// Map
// ============================================================

function FitBounds({ clusters }) {
  const map = useMap()

  useEffect(() => {
    if (!clusters.length) return

    if (clusters.length === 1) {
      map.setView(
        [clusters[0].latitude, clusters[0].longitude],
        17
      )
    } else {
      map.fitBounds(
        clusters.map((c) => [c.latitude, c.longitude]),
        { padding: [45, 45], maxZoom: 17 }
      )
    }
  }, [clusters, map])

  return null
}

function color(value, min, max) {
  if (value == null || !Number.isFinite(value)) return '#999999'

  const t = Math.min(1, Math.max(0, (value - min) / (max - min || 1)))

  const red = [220, 55, 55]
  const yellow = [240, 205, 45]
  const green = [40, 150, 85]

  const start = t < 0.5 ? red : yellow
  const end = t < 0.5 ? yellow : green
  const p = t < 0.5 ? t * 2 : (t - 0.5) * 2

  return `rgb(${start.map((x, i) =>
    Math.round(x + (end[i] - x) * p)
  ).join(',')})`
}

// ============================================================
// File export
// ============================================================

function csvCell(value) {
  let text = String(value ?? '')
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text

  return /[",\r\n]/.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text
}

function download(filename, content, type) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')

  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()

  setTimeout(() => URL.revokeObjectURL(url), 15000)
}

// ============================================================
// App
// ============================================================

export default function App() {
  const [page, setPage] = useState('home')
  const [records, setRecords] = useState([])
  const [dbReady, setDbReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [form, setForm] = useState(blankForm)

  const [settings, setSettings] = useState(() => {
    try {
      const data = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null')

      return {
        ...DEFAULT_SETTINGS,
        ...data,
        masses: { ...DEFAULT_SETTINGS.masses, ...data?.masses },
        rmax: { ...DEFAULT_SETTINGS.rmax, ...data?.rmax },
      }
    } catch {
      return DEFAULT_SETTINGS
    }
  })

  const [settingsUnlocked, setSettingsUnlocked] = useState(false)
  const [password, setPassword] = useState('')
  const [methodFilter, setMethodFilter] = useState('All')
  const [monthFilter, setMonthFilter] = useState('All')
  const [mapIndicator, setMapIndicator] = useState('rb')

  const saveInProgress = useRef(false)

  useEffect(() => {
    databaseAction('read')
      .then((data) => {
        setRecords(sorted(data))
        setDbReady(true)
      })
      .catch((e) => setMessage('Database error: ' + e.message))
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    } catch {
      // Settings storage can fail in restricted browsers.
    }
  }, [settings])

  function navigate(name) {
    setMessage('')
    if (name === 'settings') {
      setSettingsUnlocked(false)
      setPassword('')
    }
    setPage(name)
  }

  function newRecord() {
    setForm(blankForm())
    navigate('record')
  }

  function updateForm(patch) {
    setForm((f) => ({ ...f, ...patch }))
  }

  function changeCount(speciesId, method, delta) {
    setForm((f) => ({
      ...f,
      byMethod: {
        ...f.byMethod,
        [method]: {
          ...f.byMethod[method],
          [speciesId]: Math.max(
            0,
            f.byMethod[method][speciesId] + delta
          ),
        },
      },
    }))
  }

  // ----------------------------------------------------------
  // Save: automatically acquire GPS
  // ----------------------------------------------------------

  async function saveRecord() {
    if (saveInProgress.current || !dbReady) return

    if (!settings.hunterId.trim()) {
      setMessage('Please set Hunter ID in Settings.')
      return
    }

    if (!validDate(form.captureDate)) {
      setMessage('Invalid capture date.')
      return
    }

    for (const value of [form.gunEffort, form.snareEffort]) {
      if (
        value !== '' &&
        (
          !Number.isFinite(Number(value)) ||
          Number(value) <= 0
        )
      ) {
        setMessage('Hunting effort must be positive.')
        return
      }
    }

    saveInProgress.current = true
    setBusy(true)
    setMessage('Acquiring GPS automatically...')

    let location = form.previousLocation
    let gpsError = null

    try {
      location = await getPosition()
    } catch (e) {
      gpsError = e.message
    }

    const old = records.find((r) => r.id === form.id)
    const timestamp = new Date().toISOString()

    const record = {
      id: form.id || crypto.randomUUID(),
      hunterId: old?.hunterId || settings.hunterId.trim(),
      captureDate: form.captureDate,
      timePeriod: form.period,

      byMethod: cleanByMethod(form.byMethod),

      gunEffort:
        form.gunEffort === '' ? null : Number(form.gunEffort),

      snareEffort:
        form.snareEffort === '' ? null : Number(form.snareEffort),

      note: form.note.trim(),

      // GPS is the recording location, not necessarily
      // the capture location.
      location: location || null,
      gpsError,

      recordedAt: old?.recordedAt || timestamp,
      updatedAt: timestamp,
    }

    try {
      await databaseAction('put', record)

      const updated = await databaseAction('read')
      setRecords(sorted(updated))
      setForm(blankForm())
      setPage('indicators')

      setMessage(
        location
          ? `Record saved. GPS accuracy: ±${Math.round(location.accuracy)} m.`
          : `Record saved without GPS. ${gpsError || ''}`
      )
    } catch (e) {
      setMessage('Save failed: ' + e.message)
    } finally {
      setBusy(false)
      saveInProgress.current = false
    }
  }

  function editRecord(record) {
    setForm({
      id: record.id,
      captureDate: record.captureDate,
      period: record.timePeriod || record.period || 'Unknown',
      byMethod: getByMethod(record),
      gunEffort:
        record.gunEffort == null ? '' : String(record.gunEffort),
      snareEffort:
        record.snareEffort == null ? '' : String(record.snareEffort),
      note: record.note || '',
      previousLocation: record.location || null,
    })

    // Restore legacy effort when possible.
    if (record.gunEffort == null && record.snareEffort == null) {
      const method = record.huntingMethod || record.method
      const value = record.effort
      if (value != null && value !== '') {
        setForm((f) => ({
          ...f,
          gunEffort: method === 'Gun' ? String(value) : '',
          snareEffort: method === 'Snare' ? String(value) : '',
        }))
      }
    }

    navigate('record')
  }

  async function removeRecord(record) {
    if (!window.confirm('Delete this record?')) return

    try {
      await databaseAction('delete', record.id)
      setRecords((r) => r.filter((x) => x.id !== record.id))
      setMessage('Record deleted.')
    } catch (e) {
      setMessage('Delete failed: ' + e.message)
    }
  }

  // ----------------------------------------------------------
  // Aggregations
  // ----------------------------------------------------------

  const months = useMemo(() => [
    ...new Set(
      records.map((r) => r.captureDate?.slice(0, 7)).filter(Boolean)
    ),
  ].sort().reverse(), [records])

  const filteredRecords = useMemo(() =>
    records.filter((r) => (
      (monthFilter === 'All' ||
        r.captureDate?.startsWith(monthFilter)) &&
      (methodFilter === 'All' ||
        countTotal(getByMethod(r)[methodFilter]) > 0 ||
        (
          methodFilter === 'Gun' &&
          Number(r.gunEffort) > 0
        ) ||
        (
          methodFilter === 'Snare' &&
          Number(r.snareEffort) > 0
        ))
    )), [records, monthFilter, methodFilter]
  )

  const counts = useMemo(() => {
    if (methodFilter === 'All') return totalsOf(filteredRecords)
    return totalsByMethod(filteredRecords, methodFilter)
  }, [filteredRecords, methodFilter])

  const indicators = useMemo(
    () => calculateIndicators(counts, settings),
    [counts, settings]
  )

  const gpsRecords = useMemo(() =>
    filteredRecords.filter((r) => {
      if (!validLocation(r.location)) return false
      const accuracy = Number(r.location.accuracy)

      return (
        Number.isFinite(accuracy) &&
        accuracy >= 0 &&
        accuracy <= settings.maxGpsAccuracy
      )
    }), [filteredRecords, settings.maxGpsAccuracy]
  )

  const clusters = useMemo(() =>
    clusterRecords(gpsRecords, settings.clusterDistance)
      .map((cluster) => {
        const c =
          methodFilter === 'All'
            ? totalsOf(cluster.records)
            : totalsByMethod(cluster.records, methodFilter)

        return {
          ...cluster,
          counts: c,
          metrics: {
            ...calculateIndicators(c, settings),
            gunCpue: cpue(cluster.records, 'Gun'),
            snareCpue: cpue(cluster.records, 'Snare'),
          },
        }
      }),
    [gpsRecords, settings, methodFilter]
  )

  const mapRange = useMemo(() => {
    if (mapIndicator === 'rb') {
      return {
        min: Number(settings.colorMin),
        max: Number(settings.colorMax),
      }
    }

    const values = clusters
      .map((c) => c.metrics[mapIndicator])
      .filter((x) => x != null && Number.isFinite(x))

    if (!values.length) return { min: 0, max: 1 }

    const min = Math.min(...values)
    const max = Math.max(...values)

    return { min, max: max > min ? max : min + 1 }
  }, [clusters, mapIndicator, settings.colorMin, settings.colorMax])

  // ----------------------------------------------------------
  // Export
  // ----------------------------------------------------------

  function exportCsv() {
    const headers = [
      'record_id', 'hunter_id', 'capture_date', 'time_period',
      ...METHODS.flatMap((m) =>
        IDS.map((id) => `${m.toLowerCase()}_${id}`)
      ),
      'gun_effort_hunter_days',
      'snare_effort_trap_nights',
      'latitude', 'longitude', 'gps_accuracy_m',
      'gps_timestamp', 'recorded_at', 'updated_at', 'note',
    ]

    const rows = records.map((r) => {
      const matrix = getByMethod(r)

      return [
        r.id,
        r.hunterId,
        r.captureDate,
        r.timePeriod || r.period,
        ...METHODS.flatMap((m) =>
          IDS.map((id) => matrix[m][id])
        ),
        r.gunEffort ?? '',
        r.snareEffort ?? '',
        r.location?.latitude ?? '',
        r.location?.longitude ?? '',
        r.location?.accuracy ?? '',
        r.location?.timestamp ?? '',
        r.recordedAt,
        r.updatedAt,
        r.note,
      ]
    })

    const csv = '\ufeff' +
      [headers, ...rows]
        .map((row) => row.map(csvCell).join(','))
        .join('\r\n')

    download(
      `wis-records-${today()}.csv`,
      csv,
      'text/csv;charset=utf-8'
    )
  }

  function exportJson() {
    download(
      `wis-backup-${today()}.json`,
      JSON.stringify({
        version: 3,
        app: 'WIs App',
        exportedAt: new Date().toISOString(),
        records,
      }, null, 2),
      'application/json'
    )
  }

  async function importJson(event) {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const data = JSON.parse(await file.text())

      if (!Array.isArray(data.records)) {
        throw new Error('Invalid backup')
      }

      for (const r of data.records) {
        if (
          typeof r.id !== 'string' ||
          !r.id ||
          typeof r.hunterId !== 'string' ||
          !validDate(r.captureDate) ||
          !(
            r.byMethod ||
            r.counts
          )
        ) {
          throw new Error('Invalid record in backup')
        }

        const matrix = getByMethod(r)
        for (const method of METHODS) {
          for (const id of IDS) {
            const n = Number(matrix[method][id])
            if (!Number.isInteger(n) || n < 0) {
              throw new Error('Invalid count')
            }
          }
        }
      }

      if (!window.confirm(
        `Import ${data.records.length} records? Existing IDs will be replaced.`
      )) return

      setBusy(true)
      await databaseAction('putMany', data.records)
      setRecords(sorted(await databaseAction('read')))
      setMessage('Records imported successfully.')
    } catch (e) {
      setMessage('Import failed: ' + e.message)
    } finally {
      setBusy(false)
      event.target.value = ''
    }
  }

  const totalAnimals = countTotal(totalsOf(records))
  const formTotal = METHODS.reduce(
    (sum, m) => sum + countTotal(form.byMethod[m]),
    0
  )

  // ==========================================================
  // Rendering
  // ==========================================================

  return (
    <div className="app">
      <header className="app-header">
        <h1>WIs App</h1>
        <p>Wildlife Indicators Monitoring</p>
      </header>

      <main className="app-main">
        {page !== 'home' && (
          <button className="back-button" onClick={() => navigate('home')}>
            ← Home
          </button>
        )}

        {message && (
          <div className="notice" role="status">{message}</div>
        )}

        {/* HOME */}
        {page === 'home' && (
          <>
            <section className="card">
              <h2>Hunting Monitoring</h2>
              <p>Record catches and monitor wildlife indicators.</p>

              <div className="summary-grid">
                <div><strong>{records.length}</strong><span>Records</span></div>
                <div><strong>{totalAnimals}</strong><span>Animals</span></div>
              </div>
            </section>

            <div className="home-menu">
              {[
                ['record', '🐾', 'New Record', 'Record animal catches'],
                ['indicators', '📊', 'Indicators', 'Wildlife indicators and CPUE'],
                ['history', '📋', 'History', 'Review recorded catches'],
                ['map', '🗺️', 'Map', 'GPS-based indicator map'],
                ['export', '📁', 'Export / Backup', 'CSV and JSON'],
                ['settings', '⚙️', 'Settings', 'Password protected'],
              ].map(([id, icon, label, description]) => (
                <button
                  key={id}
                  onClick={() =>
                    id === 'record' ? newRecord() : navigate(id)
                  }
                >
                  <span>{icon}</span>
                  <div>
                    <strong>{label}</strong>
                    <small>{description}</small>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        {/* RECORD */}
        {page === 'record' && (
          <section className="card">
            <h2>{form.id ? 'Edit Record' : 'New Hunting Record'}</h2>

            <h3>Capture date</h3>
            <div className="choice-buttons">
              {[0, 1, 2].map((offset) => (
                <button
                  key={offset}
                  className={
                    form.captureDate === today(offset) ? 'selected' : ''
                  }
                  onClick={() =>
                    updateForm({ captureDate: today(offset) })
                  }
                >
                  {['Today', 'Yesterday', 'Two days ago'][offset]}
                </button>
              ))}
            </div>

            <input
              type="date"
              max={today()}
              value={form.captureDate}
              onChange={(e) =>
                updateForm({ captureDate: e.target.value })
              }
            />

            <h3>Time of capture</h3>
            <div className="choice-buttons">
              {PERIODS.map((period) => (
                <button
                  key={period}
                  className={form.period === period ? 'selected' : ''}
                  onClick={() => updateForm({ period })}
                >
                  {period}
                </button>
              ))}
            </div>

            <h3>Animals caught</h3>
            <p className="muted">
              Enter the number caught by each hunting method.
            </p>

            <div className="animal-list">
              {SPECIES.map((species) => (
                <div className="animal-row" key={species.id}>
                  <div className="animal-name">
                    <span>{species.icon}</span>
                    <strong>{species.name}</strong>
                  </div>

                  <div className="method-grid">
                    {METHODS.map((method) => (
                      <div className="method-count" key={method}>
                        <span className="method-label">{method}</span>

                        <div className="counter">
                          <button
                            type="button"
                            aria-label={`Decrease ${species.name} ${method}`}
                            onClick={() =>
                              changeCount(species.id, method, -1)
                            }
                          >
                            −
                          </button>

                          <strong>
                            {form.byMethod[method][species.id]}
                          </strong>

                          <button
                            type="button"
                            aria-label={`Increase ${species.name} ${method}`}
                            onClick={() =>
                              changeCount(species.id, method, 1)
                            }
                          >
                            +
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <p className="total-line">
              Total animals: <strong>{formTotal}</strong>
            </p>

            <h3>Hunting effort (optional)</h3>

            <label className="field-label">Gun: hunter-days</label>
            <input
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={form.gunEffort}
              onChange={(e) =>
                updateForm({ gunEffort: e.target.value })
              }
              placeholder="Hunter-days"
            />

            <label className="field-label">Snare: trap-nights</label>
            <input
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={form.snareEffort}
              onChange={(e) =>
                updateForm({ snareEffort: e.target.value })
              }
              placeholder="Trap-nights"
            />

            <p className="muted">
              Zero-catch records are allowed. Effort is required
              only when calculating CPUE.
            </p>

            <h3>Notes (optional)</h3>
            <textarea
              rows="2"
              value={form.note}
              onChange={(e) =>
                updateForm({ note: e.target.value })
              }
            />

            <p className="gps-hint">
              ◎ GPS location will be acquired automatically
              when you save the record.
            </p>

            <button
              className="primary-button"
              disabled={busy || !dbReady}
              onClick={saveRecord}
            >
              {busy ? 'Acquiring GPS / Saving...' : 'Save Record'}
            </button>
          </section>
        )}

        {/* INDICATORS */}
        {page === 'indicators' && (
          <section className="card">
            <h2>Wildlife Indicators</h2>

            <h3>Hunting method</h3>
            <select
              value={methodFilter}
              onChange={(e) => setMethodFilter(e.target.value)}
            >
              <option value="All">All methods</option>
              {METHODS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>

            <h3>Month</h3>
            <select
              value={monthFilter}
              onChange={(e) => setMonthFilter(e.target.value)}
            >
              <option value="All">All months</option>
              {months.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>

            <div className="summary-grid">
              <div>
                <strong>{filteredRecords.length}</strong>
                <span>Records</span>
              </div>
              <div>
                <strong>{indicators.total}</strong>
                <span>Animals</span>
              </div>
            </div>

            <div className="indicator-grid">
              {INDICATORS.slice(0, 6).map(([id, label]) => (
                <div className="indicator-card" key={id}>
                  <span>{label}</span>
                  <strong>{fmt(indicators[id])}</strong>
                </div>
              ))}

              <div className="indicator-card">
                <span>Gun CPUE (animals / hunter-day)</span>
                <strong>{fmt(cpue(filteredRecords, 'Gun'))}</strong>
              </div>

              <div className="indicator-card">
                <span>Snare CPUE (animals / trap-night)</span>
                <strong>{fmt(cpue(filteredRecords, 'Snare'))}</strong>
              </div>
            </div>

            <h3>Species totals</h3>
            {SPECIES.map((s) => (
              <div className="species-total" key={s.id}>
                <span>{s.name}</span>
                <strong>{counts[s.id]}</strong>
              </div>
            ))}

            <p className="muted">
              Indicators are calculated from hunting records,
              not camera-trap detection rates.
            </p>
          </section>
        )}

        {/* HISTORY */}
        {page === 'history' && (
          <section className="card">
            <h2>History</h2>
            <p>{records.length} records</p>

            {records.map((r) => (
              <div className="history-record" key={r.id}>
                <strong>
                  {r.captureDate} · {r.timePeriod || r.period}
                </strong>

                <p>Hunter: {r.hunterId}</p>

                {SPECIES.map((s) =>
                  METHODS.map((m) => {
                    const n = getByMethod(r)[m][s.id]
                    return n > 0 ? (
                      <p key={`${s.id}-${m}`}>
                        {s.name} · {m}: {n}
                      </p>
                    ) : null
                  })
                )}

                {r.location ? (
                  <p className="muted">
                    GPS accuracy: ±{Math.round(r.location.accuracy)} m
                  </p>
                ) : (
                  <p className="muted">No GPS recorded</p>
                )}

                <div className="history-actions">
                  <button
                    className="secondary-button"
                    onClick={() => editRecord(r)}
                  >
                    Edit
                  </button>

                  <button
                    className="delete-button"
                    onClick={() => removeRecord(r)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}

        {/* MAP */}
        {page === 'map' && (
          <section className="card map-card">
            <h2>Wildlife Indicators Map</h2>

            <h3>Indicator</h3>
            <select
              value={mapIndicator}
              onChange={(e) => setMapIndicator(e.target.value)}
            >
              {INDICATORS.map(([id, label]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>

            <h3>Hunting method</h3>
            <select
              value={methodFilter}
              onChange={(e) => setMethodFilter(e.target.value)}
            >
              <option value="All">All methods</option>
              {METHODS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>

            <h3>Month</h3>
            <select
              value={monthFilter}
              onChange={(e) => setMonthFilter(e.target.value)}
            >
              <option value="All">All months</option>
              {months.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>

            <div className="map-settings-row">
              <label>
                Cluster distance (m)
                <select
                  value={settings.clusterDistance}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      clusterDistance: Number(e.target.value),
                    }))
                  }
                >
                  {[10, 20, 30, 50, 100].map((n) => (
                    <option key={n} value={n}>{n} m</option>
                  ))}
                </select>
              </label>

              <label>
                Circle radius (m)
                <select
                  value={settings.circleRadius}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      circleRadius: Number(e.target.value),
                    }))
                  }
                >
                  {[10, 20, 30, 50, 100].map((n) => (
                    <option key={n} value={n}>{n} m</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="map-legend">
              <div className="legend-gradient" />
              <div className="legend-labels">
                <span>{fmt(mapRange.min, 2)}</span>
                <span>{fmt((mapRange.min + mapRange.max) / 2, 2)}</span>
                <span>{fmt(mapRange.max, 2)}</span>
              </div>
            </div>

            <div className="map-summary">
              <span>GPS records: {gpsRecords.length}</span>
              <span>Clusters: {clusters.length}</span>
              <span>
                Excluded: {filteredRecords.length - gpsRecords.length}
              </span>
            </div>

            <div className="map-container">
              <MapContainer
                center={[2.5, 15.0]}
                zoom={9}
                scrollWheelZoom
                className="leaflet-map"
              >
                <TileLayer
                  attribution="&copy; OpenStreetMap contributors"
                  url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
                  maxZoom={19}
                />

                <FitBounds clusters={clusters} />

                {clusters.map((c) => {
                  const value = c.metrics[mapIndicator]
                  const fill = color(
                    value,
                    mapRange.min,
                    mapRange.max
                  )

                  return (
                    <Circle
                      key={c.id}
                      center={[c.latitude, c.longitude]}
                      radius={settings.circleRadius}
                      pathOptions={{
                        color: fill,
                        fillColor: fill,
                        fillOpacity: 0.75,
                        weight: 2,
                      }}
                    >
                      <Popup>
                        <div className="map-popup">
                          <h3>Cluster {c.id}</h3>
                          <p>Records: {c.records.length}</p>
                          <p>Animals: {c.metrics.total}</p>
                          <p>GPS: {c.latitude.toFixed(6)}, {c.longitude.toFixed(6)}</p>
                          <hr />

                          {INDICATORS.map(([id, label]) => (
                            <p key={id}>
                              <strong>{label}: </strong>
                              {fmt(c.metrics[id])}
                            </p>
                          ))}

                          <hr />
                          {SPECIES.map((s) => (
                            <p key={s.id}>
                              {s.name}: {c.counts[s.id]}
                            </p>
                          ))}
                        </div>
                      </Popup>
                    </Circle>
                  )
                })}
              </MapContainer>
            </div>

            <p className="muted">
              Map tiles require internet access. Circles represent
              recording locations grouped within the selected distance.
              Colors are visualization values, not ecological safety
              thresholds.
            </p>
          </section>
        )}

        {/* EXPORT */}
        {page === 'export' && (
          <section className="card">
            <h2>Export / Backup</h2>

            <button className="primary-button" onClick={exportCsv}>
              Download CSV
            </button>

            <button className="secondary-button" onClick={exportJson}>
              Download JSON Backup
            </button>

            <h3>Import JSON Backup</h3>
            <input
              type="file"
              accept=".json,application/json"
              disabled={busy}
              onChange={importJson}
            />

            <p className="muted">
              Records with matching IDs are replaced.
              Imported data can be combined on the Map.
              Exported files contain potentially sensitive GPS data.
            </p>
          </section>
        )}

        {/* SETTINGS PASSWORD */}
        {page === 'settings' && !settingsUnlocked && (
          <section className="card">
            <h2>Settings</h2>
            <p>Enter the administrator password.</p>

            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />

            <button
              className="primary-button"
              onClick={() => {
                if (password === SETTINGS_PASSWORD) {
                  setSettingsUnlocked(true)
                  setPassword('')
                  setMessage('')
                } else {
                  setMessage('Incorrect password.')
                }
              }}
            >
              Unlock Settings
            </button>
          </section>
        )}

        {/* SETTINGS CONTENT */}
        {page === 'settings' && settingsUnlocked && (
          <section className="card">
            <h2>Settings</h2>

            <h3>Hunter ID</h3>
            <input
              value={settings.hunterId}
              placeholder="e.g. H01"
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  hunterId: e.target.value,
                }))
              }
            />

            <h3>Maximum GPS error (m)</h3>
            <input
              type="number"
              min="1"
              value={settings.maxGpsAccuracy}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  maxGpsAccuracy:
                    Math.max(1, Number(e.target.value) || 1),
                }))
              }
            />

            <h3>R/B color scale</h3>
            <div className="map-settings-row">
              <label>
                Minimum
                <input
                  type="number"
                  step="0.1"
                  value={settings.colorMin}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      colorMin: Number(e.target.value),
                    }))
                  }
                />
              </label>

              <label>
                Maximum
                <input
                  type="number"
                  step="0.1"
                  value={settings.colorMax}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      colorMax: Number(e.target.value),
                    }))
                  }
                />
              </label>
            </div>

            <h3>Species parameters</h3>
            <p className="muted">
              Mean mass: Hongo et al. (2022).
              rmax: values attributed to Fa et al. (2015);
              original supplementary data verification is still required.
            </p>

            {SPECIES.map((species) => (
              <div className="parameter-row" key={species.id}>
                <strong>{species.name}</strong>

                <div className="map-settings-row">
                  <label>
                    Mean mass (kg)
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={settings.masses[species.id]}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          masses: {
                            ...s.masses,
                            [species.id]: e.target.value,
                          },
                        }))
                      }
                    />
                  </label>

                  <label>
                    rmax
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={settings.rmax[species.id]}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          rmax: {
                            ...s.rmax,
                            [species.id]: e.target.value,
                          },
                        }))
                      }
                    />
                  </label>
                </div>
              </div>
            ))}

            <button
              className="secondary-button"
              onClick={() => setSettingsUnlocked(false)}
            >
              Lock Settings
            </button>
          </section>
        )}
      </main>

      <footer className="app-footer">
        WIs App v3.0 · Wildlife Monitoring
      </footer>
    </div>
  )
}