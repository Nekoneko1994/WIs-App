import { useEffect, useMemo, useRef, useState } from 'react'
import {
  MapContainer,
  TileLayer,
  Circle,
  CircleMarker,
  Marker,
  Popup,
  useMap,
} from 'react-leaflet'
import L from 'leaflet'

import 'leaflet/dist/leaflet.css'
import './App.css'

// ============================================================
// WIs App v4.0
// Wildlife Indicators Monitoring
//
// - Catch records only
// - Six wildlife indicators
// - No CPUE or hunting effort inputs
// - Individual GPS records and clustered WI map
// - Offline record storage using IndexedDB
// ============================================================

// ------------------------------------------------------------
// Species and methods
// ------------------------------------------------------------

const SPECIES = [
  { id: 'blue', name: 'Blue duiker', icon: '🦌' },
  { id: 'peters', name: "Peters's duiker", icon: '🦌' },
  { id: 'bay', name: 'Bay duiker', icon: '🦌' },
  { id: 'porcupine', name: 'Brush-tailed porcupine', icon: '🐾' },
  { id: 'rat', name: "Emin's pouched rat", icon: '🐀' },
]

const IDS = SPECIES.map((s) => s.id)

const METHODS = ['Gun', 'Snare', 'Other']

const PERIODS = [
  'Morning',
  'Afternoon',
  'Night',
  'Unknown',
]

const INDICATORS = [
  ['rb', 'R/B ratio'],
  ['red', 'Red proportion'],
  ['dr', 'D/R ratio'],
  ['duiker', 'Duiker proportion'],
  ['mass', 'Mean body mass (kg)'],
  ['rmax', 'Reciprocal mean-rmax'],
]

// ------------------------------------------------------------
// Database and settings
// ------------------------------------------------------------

// Keep original database names for compatibility.

const DB_NAME = 'wis-app-records-v1'
const STORE = 'records'

const SETTINGS_KEY = 'wis-app-settings-v2'
const SETTINGS_PASSWORD = '6918'

const DEFAULT_SETTINGS = {
  hunterId: '',
  clusterDistance: 30,
  circleRadius: 30,
  maxGpsAccuracy: 100,

  masses: {
    blue: 4.5,
    peters: 16.3,
    bay: 16.3,
    porcupine: 2.8,
    rat: 1.0,
  },

  // Provisional rmax values.
  // Verify primary-source values before scientific publication.
  rmax: {
    blue: 0.49,
    peters: 0.44,
    bay: 0.20,
    porcupine: 0.80,
    rat: 0.70,
  },
}

const FIXED_SCALES = {
  rb: { min: 0, middle: 1, max: 2 },
  dr: { min: 0, middle: 1, max: 2 },
  red: { min: 0, middle: 0.5, max: 1 },
  duiker: { min: 0, middle: 0.5, max: 1 },
}

// ------------------------------------------------------------
// Leaflet marker icon
// ------------------------------------------------------------

delete L.Icon.Default.prototype._getIconUrl

L.Icon.Default.mergeOptions({
  iconRetinaUrl:
    'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl:
    'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl:
    'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

// ============================================================
// IndexedDB
// ============================================================

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)

    request.onupgradeneeded = () => {
      const db = request.result

      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, {
          keyPath: 'id',
        })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function dbAction(action, data) {
  const db = await openDb()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      STORE,
      action === 'read' ? 'readonly' : 'readwrite'
    )

    const store = tx.objectStore(STORE)
    let result = null

    if (action === 'read') {
      const req = store.getAll()

      req.onsuccess = () => {
        result = req.result
      }
    }

    if (action === 'put') {
      store.put(data)
    }

    if (action === 'delete') {
      store.delete(data)
    }

    if (action === 'putMany') {
      for (const record of data) {
        store.put(record)
      }
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
// Dates
// ============================================================

function today(offset = 0) {
  const date = new Date()
  date.setDate(date.getDate() - offset)

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false

  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year, month - 1, day)

  return (
    date.getFullYear() === year &&
    date.getMonth() + 1 === month &&
    date.getDate() === day &&
    value <= today()
  )
}

function dateLabel(offset) {
  return ['Today', 'Yesterday', 'Two days ago'][offset]
}

// ============================================================
// Record structure and compatibility
// ============================================================

function emptyCounts() {
  return Object.fromEntries(
    IDS.map((id) => [id, 0])
  )
}

function emptyByMethod() {
  return Object.fromEntries(
    METHODS.map((method) => [method, emptyCounts()])
  )
}

function cleanCounts(input = {}) {
  return Object.fromEntries(
    IDS.map((id) => {
      const value = Number(input[id] ?? 0)

      return [
        id,
        Number.isInteger(value) && value >= 0
          ? value
          : 0,
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

// Old records may contain one huntingMethod and counts.
// New records contain byMethod.

function getByMethod(record) {
  if (record.byMethod) {
    return cleanByMethod(record.byMethod)
  }

  const result = emptyByMethod()

  const method =
    record.huntingMethod ||
    record.method ||
    'Other'

  if (METHODS.includes(method)) {
    result[method] = cleanCounts(record.counts || {})
  }

  return result
}

function countTotal(counts) {
  return IDS.reduce(
    (sum, id) => sum + (counts[id] || 0),
    0
  )
}

function recordTotal(record) {
  const matrix = getByMethod(record)

  return METHODS.reduce(
    (sum, method) => sum + countTotal(matrix[method]),
    0
  )
}

function totalsOf(records, method = 'All') {
  const totals = emptyCounts()

  for (const record of records) {
    const matrix = getByMethod(record)

    const methods =
      method === 'All' ? METHODS : [method]

    for (const m of methods) {
      for (const id of IDS) {
        totals[id] += matrix[m][id]
      }
    }
  }

  return totals
}

// Newest capture date first.
// If the same date, newest saved record first.

function sortRecords(records) {
  return [...records].sort((a, b) => {
    const dateOrder = (b.captureDate || '').localeCompare(
      a.captureDate || ''
    )

    if (dateOrder !== 0) return dateOrder

    return (b.recordedAt || '').localeCompare(
      a.recordedAt || ''
    )
  })
}

function blankForm() {
  return {
    id: null,
    captureDate: today(),
    period: 'Morning',
    byMethod: emptyByMethod(),
    note: '',
    previousLocation: null,
  }
}

function fmt(value, digits = 3) {
  return (
    value == null ||
    !Number.isFinite(value)
  )
    ? 'N/A'
    : Number(value).toFixed(digits)
}

// ============================================================
// Six Wildlife Indicators
// ============================================================

function calculateIndicators(counts, settings) {
  const blue = counts.blue || 0

  const red =
    (counts.peters || 0) +
    (counts.bay || 0)

  const duikers = blue + red

  const rodents =
    (counts.porcupine || 0) +
    (counts.rat || 0)

  const total = duikers + rodents

  // Zero denominator -> undefined -> N/A.

  function ratio(numerator, denominator) {
    return denominator > 0
      ? numerator / denominator
      : null
  }

  function weightedMean(parameterName) {
    if (total === 0) return null

    let sum = 0

    for (const id of IDS) {
      if (!counts[id]) continue

      const raw = settings[parameterName]?.[id]
      const value = Number(raw)

      if (
        raw == null ||
        raw === '' ||
        !Number.isFinite(value) ||
        value <= 0
      ) {
        return null
      }

      sum += counts[id] * value
    }

    return sum / total
  }

  const mass = weightedMean('masses')
  const meanRmax = weightedMean('rmax')

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

// ============================================================
// GPS
// ============================================================

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation is unavailable'))
      return
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          timestamp: new Date(
            position.timestamp
          ).toISOString(),
        })
      },
      reject,
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 30000,
      }
    )
  })
}

function validLocation(location) {
  if (!location) return false

  const lat = Number(location.latitude)
  const lon = Number(location.longitude)

  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  )
}

function validAccuracy(location, maxAccuracy) {
  if (!validLocation(location)) return false

  if (
    location.accuracy == null ||
    location.accuracy === ''
  ) {
    return false
  }

  const accuracy = Number(location.accuracy)

  return (
    Number.isFinite(accuracy) &&
    accuracy >= 0 &&
    accuracy <= Number(maxAccuracy)
  )
}

const EARTH_RADIUS = 6371000

function radians(value) {
  return value * Math.PI / 180
}

function distance(a, b) {
  const dLat = radians(b.latitude - a.latitude)
  const dLon = radians(b.longitude - a.longitude)

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.latitude)) *
      Math.cos(radians(b.latitude)) *
      Math.sin(dLon / 2) ** 2

  return (
    2 *
    EARTH_RADIUS *
    Math.asin(Math.min(1, Math.sqrt(h)))
  )
}

// ============================================================
// GPS clustering
//
// Complete linkage:
// Every pair of points in a cluster must be
// within the selected distance threshold.
// ============================================================

function clusterRecords(records, threshold) {
  let groups = records
    .filter((record) => validLocation(record.location))
    .map((record) => [record])

  function maximumDistance(groupA, groupB) {
    let maximum = 0

    for (const a of groupA) {
      for (const b of groupB) {
        maximum = Math.max(
          maximum,
          distance(a.location, b.location)
        )
      }
    }

    return maximum
  }

  while (groups.length > 1) {
    let best = null
    let minimum = Infinity

    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const d = maximumDistance(groups[i], groups[j])

        if (d <= threshold && d < minimum) {
          minimum = d
          best = [i, j]
        }
      }
    }

    if (!best) break

    const [i, j] = best
    const merged = [...groups[i], ...groups[j]]

    groups = groups.filter(
      (_, index) => index !== i && index !== j
    )

    groups.push(merged)
  }

  return groups.map((group, index) => ({
    id: index + 1,
    records: group,

    latitude:
      group.reduce(
        (sum, record) =>
          sum + Number(record.location.latitude),
        0
      ) / group.length,

    longitude:
      group.reduce(
        (sum, record) =>
          sum + Number(record.location.longitude),
        0
      ) / group.length,
  }))
}

// ============================================================
// Map colors
// ============================================================

const RED = [220, 55, 55]
const YELLOW = [240, 205, 45]
const GREEN = [40, 150, 85]

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function interpolateColor(start, end, fraction) {
  const t = clamp(fraction, 0, 1)

  const rgb = start.map((value, index) =>
    Math.round(
      value + (end[index] - value) * t
    )
  )

  return `rgb(${rgb.join(',')})`
}

function getColor(value, scale) {
  if (
    value == null ||
    !Number.isFinite(value)
  ) {
    return '#999999'
  }

  const { min, middle, max } = scale

  if (value <= middle) {
    const t =
      middle > min
        ? (value - min) / (middle - min)
        : 0.5

    return interpolateColor(RED, YELLOW, t)
  }

  const t =
    max > middle
      ? (value - middle) / (max - middle)
      : 0.5

  return interpolateColor(YELLOW, GREEN, t)
}

// R/B and D/R: 0 red, 1 yellow, >=2 green.
// Proportions: 0 red, 0.5 yellow, 1 green.
//
// Mean mass and reciprocal mean-rmax
// retain observed-value relative scales.

function getMapScale(indicator, clusters) {
  if (FIXED_SCALES[indicator]) {
    return FIXED_SCALES[indicator]
  }

  const values = clusters
    .map((cluster) => cluster.metrics[indicator])
    .filter(
      (value) =>
        value != null && Number.isFinite(value)
    )

  if (values.length === 0) {
    return { min: 0, middle: 0.5, max: 1 }
  }

  const min = Math.min(...values)
  const max = Math.max(...values)

  if (min === max) {
    return {
      min: min - 0.5,
      middle: min,
      max: min + 0.5,
    }
  }

  return {
    min,
    middle: (min + max) / 2,
    max,
  }
}

// ============================================================
// Map components
// ============================================================

function FitMap({ points }) {
  const map = useMap()

  useEffect(() => {
    if (points.length === 0) return

    if (points.length === 1) {
      map.setView(
        [points[0].latitude, points[0].longitude],
        17
      )
    } else {
      map.fitBounds(
        points.map((point) => [
          point.latitude,
          point.longitude,
        ]),
        {
          padding: [45, 45],
          maxZoom: 17,
        }
      )
    }
  }, [map, points])

  return null
}

// Individual-record map used from History.

function RecordLocationMap({ record }) {
  if (!validLocation(record.location)) {
    return (
      <div className="notice">
        GPS location unavailable for this record.
      </div>
    )
  }

  const lat = Number(record.location.latitude)
  const lon = Number(record.location.longitude)
  const accuracy = Number(record.location.accuracy)

  return (
    <>
      <div className="map-container">
        <MapContainer
          center={[lat, lon]}
          zoom={18}
          className="leaflet-map"
          scrollWheelZoom
          style={{ height: 360 }}
        >
          <TileLayer
            attribution="&copy; OpenStreetMap contributors"
            url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
            maxZoom={19}
          />

          <Marker position={[lat, lon]}>
            <Popup>
              <strong>{record.captureDate}</strong>
              <br />
              Recording location
              <br />
              Hunter: {record.hunterId}
            </Popup>
          </Marker>

          {Number.isFinite(accuracy) &&
            accuracy > 0 && (
              <Circle
                center={[lat, lon]}
                radius={accuracy}
                pathOptions={{
                  color: '#2563eb',
                  fillColor: '#60a5fa',
                  fillOpacity: 0.12,
                  weight: 1,
                }}
              />
            )}
        </MapContainer>
      </div>

      <p className="muted">
        Latitude: {lat.toFixed(6)}
        <br />
        Longitude: {lon.toFixed(6)}
        <br />
        GPS accuracy:{' '}
        {Number.isFinite(accuracy)
          ? `±${Math.round(accuracy)} m`
          : 'Unknown'}
        <br />
        GPS timestamp:{' '}
        {record.location.timestamp || 'Unknown'}
      </p>

      <p className="muted">
        The map shows the location where the record
        was saved, not necessarily where the animal
        was captured.
      </p>
    </>
  )
}

// Display every catch record on the map.
//
// If several records have exactly the same GPS
// coordinates, combine only their popups,
// not their wildlife indicators.

function groupExactCoordinates(records) {
  const groups = new Map()

  for (const record of records) {
    const lat = Number(record.location.latitude)
    const lon = Number(record.location.longitude)

    const key = `${lat},${lon}`

    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        latitude: lat,
        longitude: lon,
        records: [],
      })
    }

    groups.get(key).records.push(record)
  }

  return [...groups.values()]
}

// ============================================================
// CSV and JSON export
// ============================================================

function csvCell(value) {
  let text = String(value ?? '')

  // Prevent spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(text)) {
    text = "'" + text
  }

  return /[",\r\n]/.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text
}

function download(filename, content, mimeType) {
  const blob = new Blob([content], {
    type: mimeType,
  })

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
// Main application
// ============================================================

export default function App() {
  // ----------------------------------------------------------
  // State
  // ----------------------------------------------------------

  const [page, setPage] = useState('home')

  const [records, setRecords] = useState([])
  const [dbReady, setDbReady] = useState(false)

  const [form, setForm] = useState(blankForm)

  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const [selectedRecordId, setSelectedRecordId] =
    useState(null)

  const [methodFilter, setMethodFilter] =
    useState('All')

  const [monthFilter, setMonthFilter] =
    useState('All')

  const [mapMode, setMapMode] =
    useState('indicators')

  const [mapIndicator, setMapIndicator] =
    useState('rb')

  const [settingsUnlocked, setSettingsUnlocked] =
    useState(false)

  const [password, setPassword] = useState('')

  const [settings, setSettings] = useState(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem(SETTINGS_KEY) || 'null'
      )

      return {
        ...DEFAULT_SETTINGS,
        ...saved,

        masses: {
          ...DEFAULT_SETTINGS.masses,
          ...saved?.masses,
        },

        rmax: {
          ...DEFAULT_SETTINGS.rmax,
          ...saved?.rmax,
        },
      }
    } catch {
      return DEFAULT_SETTINGS
    }
  })

  const savingRef = useRef(false)

  // ----------------------------------------------------------
  // Load records
  // ----------------------------------------------------------

  useEffect(() => {
    dbAction('read')
      .then((data) => {
        setRecords(sortRecords(data))
        setDbReady(true)
      })
      .catch((error) => {
        setMessage(
          'Database error: ' + error.message
        )
      })
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify(settings)
      )
    } catch {
      // Ignore localStorage errors.
    }
  }, [settings])

  // ----------------------------------------------------------
  // Navigation
  // ----------------------------------------------------------

  function navigate(destination) {
    setMessage('')

    if (destination === 'settings') {
      setSettingsUnlocked(false)
      setPassword('')
    }

    setPage(destination)
  }

  function newRecord() {
    setForm(blankForm())
    navigate('record')
  }

  function updateForm(patch) {
    setForm((previous) => ({
      ...previous,
      ...patch,
    }))
  }

  function changeCount(speciesId, method, delta) {
    setForm((previous) => {
      const matrix = cleanByMethod(previous.byMethod)

      matrix[method][speciesId] = Math.max(
        0,
        matrix[method][speciesId] + delta
      )

      return {
        ...previous,
        byMethod: matrix,
      }
    })
  }

  // ----------------------------------------------------------
  // Save record
  // ----------------------------------------------------------

  async function saveRecord() {
    if (savingRef.current || !dbReady) return

    if (!settings.hunterId.trim()) {
      setMessage(
        'Please set Hunter ID in Settings.'
      )
      return
    }

    if (!validDate(form.captureDate)) {
      setMessage('Invalid capture date.')
      return
    }

    savingRef.current = true
    setBusy(true)

    const previous = records.find(
      (record) => record.id === form.id
    )

    let location =
      form.previousLocation || null

    let gpsError = null

    setMessage('Acquiring GPS automatically...')

    try {
      const position = await getPosition()

      // Keep the measured GPS point even if it is less
      // accurate than the map's maximum accuracy filter.
      location = position
    } catch (error) {
      gpsError = error.message
    }

    const now = new Date().toISOString()

    const record = {
      id: form.id || crypto.randomUUID(),

      hunterId:
        previous?.hunterId ||
        settings.hunterId.trim(),

      captureDate: form.captureDate,
      timePeriod: form.period,

      byMethod: cleanByMethod(form.byMethod),
      note: form.note.trim(),

      location,
      gpsError,

      recordedAt: previous?.recordedAt || now,
      updatedAt: now,
    }

    // Old effort fields are not required for v4.0,
    // but retain them in previously saved records.

    if (previous) {
      for (const key of [
        'gunEffort',
        'snareEffort',
        'effort',
        'effortUnit',
      ]) {
        if (Object.hasOwn(previous, key)) {
          record[key] = previous[key]
        }
      }
    }

    try {
      await dbAction('put', record)

      const updated = await dbAction('read')

      setRecords(sortRecords(updated))
      setForm(blankForm())
      setPage('history')

      if (location) {
        const accuracy = Number(location.accuracy)

        setMessage(
          Number.isFinite(accuracy)
            ? `Record saved. GPS accuracy: ±${Math.round(accuracy)} m.`
            : 'Record saved with GPS.'
        )
      } else {
        setMessage(
          'Record saved without GPS. ' +
          (gpsError || '')
        )
      }
    } catch (error) {
      setMessage(
        'Save failed: ' + error.message
      )
    } finally {
      savingRef.current = false
      setBusy(false)
    }
  }

  // ----------------------------------------------------------
  // Edit and delete
  // ----------------------------------------------------------

  function editRecord(record) {
    setForm({
      id: record.id,
      captureDate: record.captureDate,

      period:
        record.timePeriod ||
        record.period ||
        'Unknown',

      byMethod: getByMethod(record),

      note: record.note || '',
      previousLocation: record.location || null,
    })

    navigate('record')
  }

  async function deleteRecord(record) {
    if (!window.confirm('Delete this record?')) {
      return
    }

    try {
      await dbAction('delete', record.id)

      setRecords((previous) =>
        previous.filter(
          (item) => item.id !== record.id
        )
      )

      if (selectedRecordId === record.id) {
        setSelectedRecordId(null)
      }

      setMessage('Record deleted.')
    } catch (error) {
      setMessage(
        'Delete failed: ' + error.message
      )
    }
  }

  function openRecordDetail(record) {
    setSelectedRecordId(record.id)
    navigate('detail')
  }

  const selectedRecord = records.find(
    (record) => record.id === selectedRecordId
  )

  // ----------------------------------------------------------
  // Filters
  // ----------------------------------------------------------

  const months = useMemo(() => {
    return [
      ...new Set(
        records
          .map((record) =>
            record.captureDate?.slice(0, 7)
          )
          .filter(Boolean)
      ),
    ].sort().reverse()
  }, [records])

  const filteredRecords = useMemo(() => {
    return records.filter((record) => {
      const matchesMonth =
        monthFilter === 'All' ||
        record.captureDate?.startsWith(monthFilter)

      if (!matchesMonth) return false

      if (methodFilter === 'All') return true

      return countTotal(
        getByMethod(record)[methodFilter]
      ) > 0
    })
  }, [records, monthFilter, methodFilter])

  const counts = useMemo(
    () => totalsOf(filteredRecords, methodFilter),
    [filteredRecords, methodFilter]
  )

  const indicators = useMemo(
    () => calculateIndicators(counts, settings),
    [counts, settings]
  )

  // ----------------------------------------------------------
  // Map data
  // ----------------------------------------------------------

  const gpsRecords = useMemo(() => {
    return filteredRecords.filter((record) =>
      validAccuracy(
        record.location,
        settings.maxGpsAccuracy
      )
    )
  }, [filteredRecords, settings.maxGpsAccuracy])

  const clusters = useMemo(() => {
    return clusterRecords(
      gpsRecords,
      Number(settings.clusterDistance)
    ).map((cluster) => {
      const clusterCounts = totalsOf(
        cluster.records,
        methodFilter
      )

      return {
        ...cluster,
        counts: clusterCounts,
        metrics: calculateIndicators(
          clusterCounts,
          settings
        ),
      }
    })
  }, [gpsRecords, settings, methodFilter])

  const mapScale = useMemo(
    () => getMapScale(mapIndicator, clusters),
    [mapIndicator, clusters]
  )

  const rawMapPoints = useMemo(
    () => groupExactCoordinates(gpsRecords),
    [gpsRecords]
  )

  const mapPoints = useMemo(() => {
    if (mapMode === 'indicators') {
      return clusters
    }

    return rawMapPoints
  }, [mapMode, clusters, rawMapPoints])

  // ----------------------------------------------------------
  // Export CSV
  // ----------------------------------------------------------

  function exportCsv() {
    const headers = [
      'record_id',
      'hunter_id',
      'capture_date',
      'time_period',

      ...METHODS.flatMap((method) =>
        IDS.map(
          (id) =>
            `${method.toLowerCase()}_${id}`
        )
      ),

      'latitude',
      'longitude',
      'gps_accuracy_m',
      'gps_timestamp',

      'recorded_at',
      'updated_at',
      'note',
    ]

    const rows = records.map((record) => {
      const matrix = getByMethod(record)

      return [
        record.id,
        record.hunterId,
        record.captureDate,
        record.timePeriod || record.period,

        ...METHODS.flatMap((method) =>
          IDS.map((id) => matrix[method][id])
        ),

        record.location?.latitude ?? '',
        record.location?.longitude ?? '',
        record.location?.accuracy ?? '',
        record.location?.timestamp ?? '',

        record.recordedAt,
        record.updatedAt,
        record.note,
      ]
    })

    const csv =
      '\ufeff' +
      [headers, ...rows]
        .map((row) =>
          row.map(csvCell).join(',')
        )
        .join('\r\n')

    download(
      `wis-records-${today()}.csv`,
      csv,
      'text/csv;charset=utf-8'
    )
  }

  // ----------------------------------------------------------
  // JSON backup
  // ----------------------------------------------------------

  function exportJson() {
    download(
      `wis-backup-${today()}.json`,
      JSON.stringify(
        {
          app: 'WIs App',
          version: 4,
          exportedAt: new Date().toISOString(),
          records,
        },
        null,
        2
      ),
      'application/json'
    )
  }

  async function importJson(event) {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const backup = JSON.parse(
        await file.text()
      )

      if (!Array.isArray(backup.records)) {
        throw new Error('Invalid backup file.')
      }

      for (const record of backup.records) {
        if (
          typeof record.id !== 'string' ||
          !record.id ||
          typeof record.hunterId !== 'string' ||
          !validDate(record.captureDate) ||
          !(record.byMethod || record.counts)
        ) {
          throw new Error(
            'Invalid record in backup.'
          )
        }

        if (
          record.location &&
          !validLocation(record.location)
        ) {
          throw new Error(
            'Invalid GPS coordinates.'
          )
        }
      }

      if (
        !window.confirm(
          `Import ${backup.records.length} records? ` +
          'Existing records with matching IDs will be replaced.'
        )
      ) {
        return
      }

      setBusy(true)

      await dbAction(
        'putMany',
        backup.records
      )

      const updated = await dbAction('read')
      setRecords(sortRecords(updated))

      setMessage(
        'Records imported successfully.'
      )
    } catch (error) {
      setMessage(
        'Import failed: ' + error.message
      )
    } finally {
      setBusy(false)
      event.target.value = ''
    }
  }

  // ----------------------------------------------------------
  // Derived summary
  // ----------------------------------------------------------

  const totalAnimals = countTotal(
    totalsOf(records)
  )

  const formTotal = METHODS.reduce(
    (sum, method) =>
      sum + countTotal(form.byMethod[method]),
    0
  )

  // ==========================================================
  // UI
  // ==========================================================

  return (
    <div className="app">

      {/* HEADER */}

      <header className="app-header">
        <h1>WIs App</h1>
        <p>Wildlife Indicators Monitoring</p>
      </header>

      <main className="app-main">

        {/* BACK BUTTON */}

        {page !== 'home' && (
          <button
            className="back-button"
            onClick={() =>
              page === 'detail'
                ? navigate('history')
                : navigate('home')
            }
          >
            {page === 'detail'
              ? '← History'
              : '← Home'}
          </button>
        )}

        {/* MESSAGE */}

        {message && (
          <div className="notice" role="status">
            {message}
          </div>
        )}

        {/* ==================================================
            HOME
        ================================================== */}

        {page === 'home' && (
          <>
            <section className="card">
              <h2>Hunting Monitoring</h2>

              <p>
                Record animal catches and monitor
                wildlife indicators.
              </p>

              <div className="summary-grid">
                <div>
                  <strong>{records.length}</strong>
                  <span>Records</span>
                </div>

                <div>
                  <strong>{totalAnimals}</strong>
                  <span>Animals</span>
                </div>
              </div>
            </section>

            <div className="home-menu">
              {[
                [
                  'record',
                  '🐾',
                  'New Record',
                  'Record animal catches',
                ],
                [
                  'indicators',
                  '📊',
                  'Indicators',
                  'Six wildlife indicators',
                ],
                [
                  'history',
                  '📋',
                  'History',
                  'Review and edit catch records',
                ],
                [
                  'map',
                  '🗺️',
                  'Map',
                  'Indicators and GPS catch records',
                ],
                [
                  'export',
                  '📁',
                  'Export / Backup',
                  'CSV and JSON',
                ],
                [
                  'settings',
                  '⚙️',
                  'Settings',
                  'Password protected',
                ],
              ].map(([id, icon, label, description]) => (
                <button
                  key={id}
                  onClick={() =>
                    id === 'record'
                      ? newRecord()
                      : navigate(id)
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

        {/* ==================================================
            NEW / EDIT RECORD
        ================================================== */}

        {page === 'record' && (
          <section className="card">
            <h2>
              {form.id
                ? 'Edit Record'
                : 'New Hunting Record'}
            </h2>

            <h3>Capture date</h3>

            <div className="choice-buttons">
              {[0, 1, 2].map((offset) => (
                <button
                  key={offset}
                  type="button"
                  className={
                    form.captureDate === today(offset)
                      ? 'selected'
                      : ''
                  }
                  onClick={() =>
                    updateForm({
                      captureDate: today(offset),
                    })
                  }
                >
                  {dateLabel(offset)}
                </button>
              ))}
            </div>

            <input
              type="date"
              max={today()}
              value={form.captureDate}
              onChange={(event) =>
                updateForm({
                  captureDate: event.target.value,
                })
              }
            />

            <h3>Time of capture</h3>

            <div className="choice-buttons">
              {PERIODS.map((period) => (
                <button
                  type="button"
                  key={period}
                  className={
                    form.period === period
                      ? 'selected'
                      : ''
                  }
                  onClick={() =>
                    updateForm({ period })
                  }
                >
                  {period}
                </button>
              ))}
            </div>

            <h3>Animals caught</h3>

            <p className="muted">
              Enter the number caught by each
              hunting method.
            </p>

            <div className="animal-list">
              {SPECIES.map((species) => (
                <div
                  className="animal-row"
                  key={species.id}
                >
                  <div className="animal-name">
                    <span>{species.icon}</span>
                    <strong>{species.name}</strong>
                  </div>

                  <div className="method-grid">
                    {METHODS.map((method) => (
                      <div
                        className="method-count"
                        key={method}
                      >
                        <span className="method-label">
                          {method}
                        </span>

                        <div className="counter">
                          <button
                            type="button"
                            aria-label={
                              `Decrease ${species.name}, ${method}`
                            }
                            onClick={() =>
                              changeCount(
                                species.id,
                                method,
                                -1
                              )
                            }
                          >
                            −
                          </button>

                          <strong>
                            {
                              form.byMethod[method][
                                species.id
                              ]
                            }
                          </strong>

                          <button
                            type="button"
                            aria-label={
                              `Increase ${species.name}, ${method}`
                            }
                            onClick={() =>
                              changeCount(
                                species.id,
                                method,
                                1
                              )
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
              Total animals:{' '}
              <strong>{formTotal}</strong>
            </p>

            <h3>Notes (optional)</h3>

            <textarea
              rows={3}
              value={form.note}
              onChange={(event) =>
                updateForm({
                  note: event.target.value,
                })
              }
            />

            <p className="gps-hint">
              ◎ GPS location will be acquired
              automatically when you save.
              A failed GPS request will not
              prevent the record from being saved.
            </p>

            <button
              className="primary-button"
              onClick={saveRecord}
              disabled={busy || !dbReady}
            >
              {busy
                ? 'Acquiring GPS / Saving...'
                : 'Save Record'}
            </button>
          </section>
        )}

        {/* ==================================================
            INDICATORS
        ================================================== */}

        {page === 'indicators' && (
          <section className="card">
            <h2>Wildlife Indicators</h2>

            <h3>Hunting method</h3>

            <select
              value={methodFilter}
              onChange={(event) =>
                setMethodFilter(event.target.value)
              }
            >
              <option value="All">
                All methods
              </option>

              {METHODS.map((method) => (
                <option
                  key={method}
                  value={method}
                >
                  {method}
                </option>
              ))}
            </select>

            <h3>Month</h3>

            <select
              value={monthFilter}
              onChange={(event) =>
                setMonthFilter(event.target.value)
              }
            >
              <option value="All">
                All months
              </option>

              {months.map((month) => (
                <option
                  key={month}
                  value={month}
                >
                  {month}
                </option>
              ))}
            </select>

            <div className="summary-grid">
              <div>
                <strong>
                  {filteredRecords.length}
                </strong>
                <span>Records</span>
              </div>

              <div>
                <strong>{indicators.total}</strong>
                <span>Animals</span>
              </div>
            </div>

            <div className="indicator-grid">
              {INDICATORS.map(([id, label]) => (
                <div
                  className="indicator-card"
                  key={id}
                >
                  <span>{label}</span>
                  <strong>
                    {fmt(indicators[id])}
                  </strong>
                </div>
              ))}
            </div>

            <h3>Species totals</h3>

            {SPECIES.map((species) => (
              <div
                className="species-total"
                key={species.id}
              >
                <span>{species.name}</span>
                <strong>
                  {counts[species.id]}
                </strong>
              </div>
            ))}

            <p className="muted">
              Ratios with zero denominators are
              displayed as N/A.
            </p>

            <p className="muted">
              These indicators describe the species
              composition of recorded catches.
              Changes in hunting selectivity may also
              affect their values.
            </p>
          </section>
        )}

        {/* ==================================================
            HISTORY
        ================================================== */}

        {page === 'history' && (
          <section className="card">
            <h2>History</h2>

            <p className="muted">
              Sorted by capture date, newest first.
            </p>

            <p>{records.length} records</p>

            {records.length === 0 && (
              <p>No records yet.</p>
            )}

            {records.map((record) => {
              const matrix = getByMethod(record)

              return (
                <div
                  className="history-record"
                  key={record.id}
                >
                  <strong>
                    {record.captureDate}
                    {' · '}
                    {record.timePeriod ||
                      record.period ||
                      'Unknown'}
                  </strong>

                  <p>
                    Hunter: {record.hunterId}
                  </p>

                  <p>
                    Animals: {recordTotal(record)}
                  </p>

                  {SPECIES.map((species) =>
                    METHODS.map((method) => {
                      const number =
                        matrix[method][species.id]

                      return number > 0 ? (
                        <p
                          key={
                            `${species.id}-${method}`
                          }
                        >
                          {species.name}
                          {' · '}
                          {method}: {number}
                        </p>
                      ) : null
                    })
                  )}

                  <p className="muted">
                    {validLocation(record.location)
                      ? 'GPS recorded'
                      : 'No GPS recorded'}
                  </p>

                  <div
                    className="history-actions"
                    style={{ flexWrap: 'wrap' }}
                  >
                    <button
                      className="secondary-button"
                      onClick={() =>
                        openRecordDetail(record)
                      }
                    >
                      View Location
                    </button>

                    <button
                      className="secondary-button"
                      onClick={() =>
                        editRecord(record)
                      }
                    >
                      Edit
                    </button>

                    <button
                      className="delete-button"
                      onClick={() =>
                        deleteRecord(record)
                      }
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )
            })}
          </section>
        )}

        {/* ==================================================
            RECORD DETAIL
        ================================================== */}

        {page === 'detail' && (
          <section className="card">
            <h2>Record Details</h2>

            {!selectedRecord ? (
              <p>Record not found.</p>
            ) : (
              <>
                <h3>
                  {selectedRecord.captureDate}
                </h3>

                <p>
                  Time:{' '}
                  {selectedRecord.timePeriod ||
                    selectedRecord.period ||
                    'Unknown'}
                </p>

                <p>
                  Hunter: {selectedRecord.hunterId}
                </p>

                <h3>Animals caught</h3>

                {SPECIES.map((species) =>
                  METHODS.map((method) => {
                    const number =
                      getByMethod(selectedRecord)[
                        method
                      ][species.id]

                    return number > 0 ? (
                      <div
                        className="species-total"
                        key={
                          `${species.id}-${method}`
                        }
                      >
                        <span>
                          {species.name}
                          {' · '}
                          {method}
                        </span>

                        <strong>{number}</strong>
                      </div>
                    ) : null
                  })
                )}

                <p>
                  Total animals:{' '}
                  <strong>
                    {recordTotal(selectedRecord)}
                  </strong>
                </p>

                {selectedRecord.note && (
                  <>
                    <h3>Notes</h3>
                    <p>{selectedRecord.note}</p>
                  </>
                )}

                <h3>Recording Location</h3>

                <RecordLocationMap
                  record={selectedRecord}
                />

                <button
                  className="secondary-button"
                  onClick={() =>
                    editRecord(selectedRecord)
                  }
                >
                  Edit Record
                </button>
              </>
            )}
          </section>
        )}

        {/* ==================================================
            MAP
        ================================================== */}

        {page === 'map' && (
          <section className="card map-card">
            <h2>Map</h2>

            <h3>Display mode</h3>

            <div className="choice-buttons">
              <button
                className={
                  mapMode === 'indicators'
                    ? 'selected'
                    : ''
                }
                onClick={() =>
                  setMapMode('indicators')
                }
              >
                Wildlife Indicators
              </button>

              <button
                className={
                  mapMode === 'records'
                    ? 'selected'
                    : ''
                }
                onClick={() =>
                  setMapMode('records')
                }
              >
                Catch Records
              </button>
            </div>

            {mapMode === 'indicators' && (
              <>
                <h3>Indicator</h3>

                <select
                  value={mapIndicator}
                  onChange={(event) =>
                    setMapIndicator(
                      event.target.value
                    )
                  }
                >
                  {INDICATORS.map(([id, label]) => (
                    <option
                      key={id}
                      value={id}
                    >
                      {label}
                    </option>
                  ))}
                </select>
              </>
            )}

            <h3>Hunting method</h3>

            <select
              value={methodFilter}
              onChange={(event) =>
                setMethodFilter(
                  event.target.value
                )
              }
            >
              <option value="All">
                All methods
              </option>

              {METHODS.map((method) => (
                <option
                  key={method}
                  value={method}
                >
                  {method}
                </option>
              ))}
            </select>

            <h3>Month</h3>

            <select
              value={monthFilter}
              onChange={(event) =>
                setMonthFilter(
                  event.target.value
                )
              }
            >
              <option value="All">
                All months
              </option>

              {months.map((month) => (
                <option
                  key={month}
                  value={month}
                >
                  {month}
                </option>
              ))}
            </select>

            {/* Map settings */}

            <div className="map-settings-row">
              <label>
                GPS clustering distance

                <select
                  value={settings.clusterDistance}
                  onChange={(event) =>
                    setSettings((previous) => ({
                      ...previous,
                      clusterDistance: Number(
                        event.target.value
                      ),
                    }))
                  }
                  disabled={mapMode !== 'indicators'}
                >
                  {[10, 20, 30, 50, 100].map(
                    (value) => (
                      <option
                        key={value}
                        value={value}
                      >
                        {value} m
                      </option>
                    )
                  )}
                </select>
              </label>

              <label>
                WI circle radius

                <select
                  value={settings.circleRadius}
                  onChange={(event) =>
                    setSettings((previous) => ({
                      ...previous,
                      circleRadius: Number(
                        event.target.value
                      ),
                    }))
                  }
                  disabled={mapMode !== 'indicators'}
                >
                  {[10, 20, 30, 50, 100].map(
                    (value) => (
                      <option
                        key={value}
                        value={value}
                      >
                        {value} m
                      </option>
                    )
                  )}
                </select>
              </label>
            </div>

            {/* WI color legend */}

            {mapMode === 'indicators' && (
              <>
                <div className="map-legend">
                  <div className="legend-gradient" />

                  <div className="legend-labels">
                    <span>
                      {fmt(mapScale.min, 2)}
                    </span>

                    <span>
                      {fmt(mapScale.middle, 2)}
                    </span>

                    <span>
                      {fmt(mapScale.max, 2)}
                    </span>
                  </div>
                </div>

                <p className="muted">
                  {FIXED_SCALES[mapIndicator]
                    ? 'Fixed color scale: red = low, yellow = intermediate, green = high.'
                    : 'Relative color scale based on observed values.'}
                  {' '}
                  Grey = N/A.
                </p>
              </>
            )}

            {/* Map summary */}

            <div className="map-summary">
              <span>
                GPS records: {gpsRecords.length}
              </span>

              <span>
                {mapMode === 'indicators'
                  ? `Clusters: ${clusters.length}`
                  : `Locations: ${rawMapPoints.length}`}
              </span>

              <span>
                Excluded:{' '}
                {filteredRecords.length -
                  gpsRecords.length}
              </span>
            </div>

            {/* Map */}

            <div className="map-container">
              <MapContainer
                center={[2.5, 15.0]}
                zoom={9}
                className="leaflet-map"
                scrollWheelZoom
              >
                <TileLayer
                  attribution="&copy; OpenStreetMap contributors"
                  url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
                  maxZoom={19}
                />

                <FitMap points={mapPoints} />

                {/* Wildlife indicator circles */}

                {mapMode === 'indicators' &&
                  clusters.map((cluster) => {
                    const value =
                      cluster.metrics[mapIndicator]

                    const fill = getColor(
                      value,
                      mapScale
                    )

                    return (
                      <Circle
                        key={cluster.id}
                        center={[
                          cluster.latitude,
                          cluster.longitude,
                        ]}
                        radius={Number(
                          settings.circleRadius
                        )}
                        pathOptions={{
                          color: fill,
                          fillColor: fill,
                          fillOpacity: 0.75,
                          weight: 2,
                        }}
                      >
                        <Popup>
                          <div className="map-popup">
                            <h3>
                              Cluster {cluster.id}
                            </h3>

                            <p>
                              Records:{' '}
                              {cluster.records.length}
                            </p>

                            <p>
                              Animals:{' '}
                              {cluster.metrics.total}
                            </p>

                            <p>
                              Latitude:{' '}
                              {cluster.latitude.toFixed(6)}
                            </p>

                            <p>
                              Longitude:{' '}
                              {cluster.longitude.toFixed(6)}
                            </p>

                            <hr />

                            {INDICATORS.map(
                              ([id, label]) => (
                                <p key={id}>
                                  <strong>
                                    {label}:{' '}
                                  </strong>

                                  {fmt(
                                    cluster.metrics[id]
                                  )}
                                </p>
                              )
                            )}

                            <hr />

                            {SPECIES.map(
                              (species) => (
                                <p key={species.id}>
                                  {species.name}:{' '}
                                  {
                                    cluster.counts[
                                      species.id
                                    ]
                                  }
                                </p>
                              )
                            )}
                          </div>
                        </Popup>
                      </Circle>
                    )
                  })}

                {/* Individual catch record locations */}

                {mapMode === 'records' &&
                  rawMapPoints.map((point) => (
                    <CircleMarker
                      key={point.id}
                      center={[
                        point.latitude,
                        point.longitude,
                      ]}
                      radius={
                        point.records.length > 1
                          ? 9
                          : 6
                      }
                      pathOptions={{
                        color: '#175ca1',
                        fillColor: '#3587d7',
                        fillOpacity: 0.85,
                        weight: 2,
                      }}
                    >
                      <Popup>
                        <div className="map-popup">
                          <h3>
                            Catch Records
                          </h3>

                          <p>
                            Records at this location:{' '}
                            {point.records.length}
                          </p>

                          <p>
                            GPS:{' '}
                            {point.latitude.toFixed(6)}
                            {', '}
                            {point.longitude.toFixed(6)}
                          </p>

                          <hr />

                          {sortRecords(
                            point.records
                          ).map((record) => {
                            const matrix =
                              getByMethod(record)

                            return (
                              <div key={record.id}>
                                <p>
                                  <strong>
                                    {record.captureDate}
                                  </strong>
                                </p>

                                <p>
                                  Hunter:{' '}
                                  {record.hunterId}
                                </p>

                                <p>
                                  Animals:{' '}
                                  {recordTotal(record)}
                                </p>

                                {SPECIES.map(
                                  (species) =>
                                    METHODS.map(
                                      (method) => {
                                        const number =
                                          matrix[method][
                                            species.id
                                          ]

                                        return number > 0 ? (
                                          <p
                                            key={
                                              `${record.id}-${species.id}-${method}`
                                            }
                                          >
                                            {species.name}
                                            {' · '}
                                            {method}: {number}
                                          </p>
                                        ) : null
                                      }
                                    )
                                )}

                                <hr />
                              </div>
                            )
                          })}
                        </div>
                      </Popup>
                    </CircleMarker>
                  ))}
              </MapContainer>
            </div>

            {mapPoints.length === 0 && (
              <div
                className="notice"
                style={{ marginTop: 15 }}
              >
                No GPS records available
                for the selected filters.
              </div>
            )}

            <p className="muted">
              Map tiles require internet access.
              Capture records and indicators are
              calculated from locally stored data.
            </p>

            <p className="muted">
              GPS coordinates represent the
              recording location, which may differ
              from the actual capture location.
            </p>

            {mapMode === 'indicators' && (
              <p className="muted">
                Wildlife indicators are calculated
                for GPS clusters using complete-linkage
                clustering. A green color does not
                establish ecological sustainability.
              </p>
            )}
          </section>
        )}

        {/* ==================================================
            EXPORT / BACKUP
        ================================================== */}

        {page === 'export' && (
          <section className="card">
            <h2>Export / Backup</h2>

            <button
              className="primary-button"
              onClick={exportCsv}
              disabled={!dbReady}
            >
              Download CSV
            </button>

            <button
              className="secondary-button"
              onClick={exportJson}
              disabled={!dbReady}
            >
              Download JSON Backup
            </button>

            <h3>Import JSON Backup</h3>

            <input
              type="file"
              accept=".json,application/json"
              disabled={busy || !dbReady}
              onChange={importJson}
            />

            <p className="muted">
              Importing a backup adds records.
              Records with matching IDs are replaced.
              Records not in the backup are retained.
            </p>

            <p className="muted">
              Data is stored locally on this device.
              GitHub Pages does not automatically
              synchronize records between devices.
              Export backups regularly.
            </p>
          </section>
        )}

        {/* ==================================================
            SETTINGS PASSWORD
        ================================================== */}

        {page === 'settings' &&
          !settingsUnlocked && (
            <section className="card">
              <h2>Settings</h2>

              <p>
                Enter the administrator password.
              </p>

              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                placeholder="Password"
                value={password}
                onChange={(event) =>
                  setPassword(event.target.value)
                }
              />

              <button
                className="primary-button"
                onClick={() => {
                  if (
                    password === SETTINGS_PASSWORD
                  ) {
                    setSettingsUnlocked(true)
                    setPassword('')
                    setMessage('')
                  } else {
                    setMessage(
                      'Incorrect password.'
                    )
                  }
                }}
              >
                Unlock Settings
              </button>
            </section>
          )}

        {/* ==================================================
            SETTINGS
        ================================================== */}

        {page === 'settings' &&
          settingsUnlocked && (
            <section className="card">
              <h2>Settings</h2>

              <h3>Hunter ID</h3>

              <input
                value={settings.hunterId}
                placeholder="e.g. H01"
                onChange={(event) =>
                  setSettings((previous) => ({
                    ...previous,
                    hunterId: event.target.value,
                  }))
                }
              />

              <h3>
                Maximum GPS error (m)
              </h3>

              <input
                type="number"
                min="1"
                value={settings.maxGpsAccuracy}
                onChange={(event) =>
                  setSettings((previous) => ({
                    ...previous,

                    maxGpsAccuracy: Math.max(
                      1,
                      Number(event.target.value) || 1
                    ),
                  }))
                }
              />

              <h3>Species parameters</h3>

              <p className="muted">
                Mean body mass and rmax values
                are editable. Verify the parameter
                sources before scientific analysis.
              </p>

              {SPECIES.map((species) => (
                <div
                  className="parameter-row"
                  key={species.id}
                >
                  <strong>
                    {species.name}
                  </strong>

                  <div className="map-settings-row">
                    <label>
                      Mean mass (kg)

                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={
                          settings.masses[species.id]
                        }
                        onChange={(event) =>
                          setSettings((previous) => ({
                            ...previous,

                            masses: {
                              ...previous.masses,

                              [species.id]:
                                event.target.value,
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
                        value={
                          settings.rmax[species.id]
                        }
                        onChange={(event) =>
                          setSettings((previous) => ({
                            ...previous,

                            rmax: {
                              ...previous.rmax,

                              [species.id]:
                                event.target.value,
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
                onClick={() =>
                  setSettingsUnlocked(false)
                }
              >
                Lock Settings
              </button>
            </section>
          )}
      </main>

      <footer className="app-footer">
        WIs App v4.0 · Wildlife Monitoring
      </footer>
    </div>
  )
}