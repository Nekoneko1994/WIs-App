import { useEffect, useMemo, useRef, useState } from 'react'
import {
  MapContainer,
  TileLayer,
  Circle,
  Popup,
  Marker,
  useMap,
} from 'react-leaflet'
import L from 'leaflet'

import 'leaflet/dist/leaflet.css'
import './App.css'

// ============================================================
// WIs App v3.1
// ============================================================

// Species

const SPECIES = [
  { id: 'blue', name: 'Blue duiker', icon: '🦌' },
  { id: 'peters', name: "Peters's duiker", icon: '🦌' },
  { id: 'bay', name: 'Bay duiker', icon: '🦌' },
  { id: 'porcupine', name: 'Brush-tailed porcupine', icon: '🐾' },
  { id: 'rat', name: "Emin's pouched rat", icon: '🐀' },
]

const IDS = SPECIES.map((species) => species.id)

const METHODS = ['Gun', 'Snare', 'Other']

const PERIODS = [
  'Morning',
  'Afternoon',
  'Night',
  'Unknown',
]

const EMPTY = () =>
  Object.fromEntries(
    IDS.map((id) => [id, 0])
  )

const EMPTY_BY_METHOD = () =>
  Object.fromEntries(
    METHODS.map((method) => [method, EMPTY()])
  )

// Database

const DB_NAME = 'wis-app-records-v1'
const DB_STORE = 'records'
const SETTINGS_KEY = 'wis-app-settings-v2'

const SETTINGS_PASSWORD = '6918'

// Default settings

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

  // Values attributed to Fa et al. (2015)
  // through a secondary tabulation.
  // Direct verification against the original
  // supplementary dataset remains necessary.

  rmax: {
    blue: 0.49,
    peters: 0.44,
    bay: 0.20,
    porcupine: 0.80,
    rat: 0.70,
  },
}

// Indicators

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

// Fixed color scales for composition indicators

const FIXED_SCALES = {
  rb: {
    min: 0,
    middle: 1,
    max: 2,
  },

  dr: {
    min: 0,
    middle: 1,
    max: 2,
  },

  red: {
    min: 0,
    middle: 0.5,
    max: 1,
  },

  duiker: {
    min: 0,
    middle: 0.5,
    max: 1,
  },
}

// Leaflet marker icon fix

delete L.Icon.Default.prototype._getIconUrl

L.Icon.Default.mergeOptions({
  iconRetinaUrl:
    'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',

  iconUrl:
    'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',

  shadowUrl:
    'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
})

// ============================================================
// IndexedDB
// ============================================================

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)

    request.onupgradeneeded = () => {
      const db = request.result

      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, {
          keyPath: 'id',
        })
      }
    }

    request.onsuccess = () => {
      resolve(request.result)
    }

    request.onerror = () => {
      reject(request.error)
    }
  })
}

async function databaseAction(action, data) {
  const db = await openDb()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      DB_STORE,
      action === 'read' ? 'readonly' : 'readwrite'
    )

    const store = transaction.objectStore(DB_STORE)

    let result

    if (action === 'read') {
      const request = store.getAll()

      request.onsuccess = () => {
        result = request.result
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

    transaction.oncomplete = () => {
      db.close()
      resolve(result)
    }

    transaction.onerror = () => {
      db.close()
      reject(transaction.error)
    }

    transaction.onabort = () => {
      db.close()
      reject(
        transaction.error ||
        new Error('Database transaction aborted')
      )
    }
  })
}

// ============================================================
// Date utilities
// ============================================================

function today(offset = 0) {
  const date = new Date()

  date.setDate(
    date.getDate() - offset
  )

  const year = date.getFullYear()

  const month = String(
    date.getMonth() + 1
  ).padStart(2, '0')

  const day = String(
    date.getDate()
  ).padStart(2, '0')

  return `${year}-${month}-${day}`
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }

  const [year, month, day] = value
    .split('-')
    .map(Number)

  const date = new Date(
    year,
    month - 1,
    day
  )

  return (
    date.getFullYear() === year &&
    date.getMonth() + 1 === month &&
    date.getDate() === day &&
    value <= today()
  )
}

// ============================================================
// Record utilities
// ============================================================

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

// Compatibility with older records

function getByMethod(record) {
  if (record.byMethod) {
    return cleanByMethod(record.byMethod)
  }

  const result = EMPTY_BY_METHOD()

  const method =
    record.huntingMethod ||
    record.method ||
    'Other'

  if (METHODS.includes(method)) {
    result[method] = cleanCounts(
      record.counts || {}
    )
  }

  return result
}

function countTotal(counts) {
  return IDS.reduce(
    (sum, id) => sum + (counts[id] || 0),
    0
  )
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

    for (const id of IDS) {
      totals[id] += matrix[method][id]
    }
  }

  return totals
}

// NEW: chronological history
//
// First: capture date, newest first.
// Second: recording timestamp, newest first.

function sortRecords(records) {
  return [...records].sort((a, b) => {
    const dateComparison =
      (b.captureDate || '').localeCompare(
        a.captureDate || ''
      )

    if (dateComparison !== 0) {
      return dateComparison
    }

    return (b.recordedAt || '').localeCompare(
      a.recordedAt || ''
    )
  })
}

function fmt(value, digits = 3) {
  if (
    value == null ||
    !Number.isFinite(value)
  ) {
    return 'N/A'
  }

  return Number(value).toFixed(digits)
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
  const blue = counts.blue || 0

  const red =
    (counts.peters || 0) +
    (counts.bay || 0)

  const duikers = blue + red

  const rodents =
    (counts.porcupine || 0) +
    (counts.rat || 0)

  const total = duikers + rodents

  const ratio = (a, b) =>
    b > 0 ? a / b : null

  function weightedAverage(key) {
    if (total === 0) return null

    let weightedTotal = 0

    for (const id of IDS) {
      if (!counts[id]) continue

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

      weightedTotal += counts[id] * value
    }

    return weightedTotal / total
  }

  const mass = weightedAverage('masses')
  const meanRmax = weightedAverage('rmax')

  return {
    rb: ratio(red, blue),

    red: ratio(red, duikers),

    dr: ratio(duikers, rodents),

    duiker: ratio(duikers, total),

    mass,

    rmax:
      meanRmax > 0
        ? 1 / meanRmax
        : null,

    total,
  }
}

// ============================================================
// CPUE
// ============================================================

function calculateCpue(records, method) {
  const effortKey =
    method === 'Gun'
      ? 'gunEffort'
      : 'snareEffort'

  const legacyUnit =
    method === 'Gun'
      ? 'hunter-day'
      : 'trap-night'

  let totalEffort = 0
  let totalCatch = 0

  for (const record of records) {
    let effort = record[effortKey]

    // Compatibility with previous record format

    if (effort == null) {
      const previousMethod =
        record.huntingMethod ||
        record.method

      if (
        previousMethod === method &&
        record.effortUnit === legacyUnit
      ) {
        effort = record.effort
      }
    }

    if (
      effort === '' ||
      effort == null ||
      !Number.isFinite(Number(effort)) ||
      Number(effort) <= 0
    ) {
      continue
    }

    totalEffort += Number(effort)

    totalCatch += countTotal(
      getByMethod(record)[method]
    )
  }

  return totalEffort > 0
    ? totalCatch / totalEffort
    : null
}

// ============================================================
// GPS
// ============================================================

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(
        new Error('Geolocation is unavailable')
      )
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

      (error) => {
        reject(error)
      },

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

  const latitude = Number(
    location.latitude
  )

  const longitude = Number(
    location.longitude
  )

  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  )
}

const EARTH_RADIUS = 6371000

function radians(degrees) {
  return degrees * Math.PI / 180
}

function distance(a, b) {
  const deltaLatitude = radians(
    b.latitude - a.latitude
  )

  const deltaLongitude = radians(
    b.longitude - a.longitude
  )

  const h =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(radians(a.latitude)) *
    Math.cos(radians(b.latitude)) *
    Math.sin(deltaLongitude / 2) ** 2

  return (
    2 *
    EARTH_RADIUS *
    Math.asin(
      Math.min(1, Math.sqrt(h))
    )
  )
}

// ============================================================
// Complete-linkage GPS clustering
// ============================================================

function clusterRecords(records, threshold) {
  let groups = records
    .filter(
      (record) => validLocation(record.location)
    )
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
    let bestPair = null
    let bestDistance = Infinity

    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const d = maximumDistance(
          groups[i],
          groups[j]
        )

        if (
          d <= threshold &&
          d < bestDistance
        ) {
          bestPair = [i, j]
          bestDistance = d
        }
      }
    }

    if (!bestPair) break

    const [i, j] = bestPair

    const merged = [
      ...groups[i],
      ...groups[j],
    ]

    groups = groups.filter(
      (_, index) =>
        index !== i &&
        index !== j
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
// NEW: Map color scales
// ============================================================

const RED = [220, 55, 55]
const YELLOW = [240, 205, 45]
const GREEN = [40, 150, 85]

function clamp(value, minimum, maximum) {
  return Math.min(
    maximum,
    Math.max(minimum, value)
  )
}

function interpolateColor(start, end, fraction) {
  const t = clamp(fraction, 0, 1)

  const rgb = start.map(
    (component, i) =>
      Math.round(
        component +
        (end[i] - component) * t
      )
  )

  return `rgb(${rgb.join(',')})`
}

function getColor(value, minimum, maximum) {
  if (
    value == null ||
    !Number.isFinite(value)
  ) {
    return '#999999'
  }

  if (
    !Number.isFinite(minimum) ||
    !Number.isFinite(maximum) ||
    maximum <= minimum
  ) {
    return '#999999'
  }

  const t = clamp(
    (value - minimum) /
      (maximum - minimum),
    0,
    1
  )

  if (t <= 0.5) {
    return interpolateColor(
      RED,
      YELLOW,
      t * 2
    )
  }

  return interpolateColor(
    YELLOW,
    GREEN,
    (t - 0.5) * 2
  )
}

// Fixed scales for R/B, D/R,
// Red proportion and Duiker proportion.
//
// Other indicators use their own
// observed-value ranges.

function getMapScale(indicatorId, clusters) {
  if (FIXED_SCALES[indicatorId]) {
    return FIXED_SCALES[indicatorId]
  }

  const values = clusters
    .map(
      (cluster) =>
        cluster.metrics[indicatorId]
    )
    .filter(
      (value) =>
        value != null &&
        Number.isFinite(value)
    )

  if (!values.length) {
    return {
      min: 0,
      middle: 0.5,
      max: 1,
    }
  }

  const minimum = Math.min(...values)
  const maximum = Math.max(...values)

  if (minimum === maximum) {
    // No spatial variation:
    // show every valid cluster as yellow.
    return {
      min: minimum - 0.5,
      middle: minimum,
      max: minimum + 0.5,
    }
  }

  return {
    min: minimum,
    middle: (minimum + maximum) / 2,
    max: maximum,
  }
}

// ============================================================
// Map components
// ============================================================

function FitBounds({ clusters }) {
  const map = useMap()

  useEffect(() => {
    if (clusters.length === 0) return

    if (clusters.length === 1) {
      map.setView(
        [
          clusters[0].latitude,
          clusters[0].longitude,
        ],
        17
      )

      return
    }

    map.fitBounds(
      clusters.map((cluster) => [
        cluster.latitude,
        cluster.longitude,
      ]),

      {
        padding: [45, 45],
        maxZoom: 17,
      }
    )
  }, [clusters, map])

  return null
}

// NEW: individual-record map

function RecordLocationMap({ record }) {
  if (!validLocation(record.location)) {
    return (
      <div className="notice">
        GPS location unavailable for this record.
      </div>
    )
  }

  const latitude = Number(
    record.location.latitude
  )

  const longitude = Number(
    record.location.longitude
  )

  const accuracy = Number(
    record.location.accuracy
  )

  const markerCenter = [
    latitude,
    longitude,
  ]

  return (
    <>
      <div
        className="map-container"
        style={{ marginTop: 12 }}
      >
        <MapContainer
          center={markerCenter}
          zoom={18}
          scrollWheelZoom={true}
          className="leaflet-map"
          style={{ height: 360 }}
        >
          <TileLayer
            attribution="&copy; OpenStreetMap contributors"
            url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
            maxZoom={19}
          />

          <Marker position={markerCenter}>
            <Popup>
              <strong>
                {record.captureDate}
              </strong>
              <br />
              Recording location
              <br />
              Hunter: {record.hunterId}
            </Popup>
          </Marker>

          {Number.isFinite(accuracy) &&
            accuracy > 0 && (
              <Circle
                center={markerCenter}
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
        Latitude: {latitude.toFixed(6)}
        <br />
        Longitude: {longitude.toFixed(6)}
        <br />
        Accuracy:{' '}
        {Number.isFinite(accuracy)
          ? `±${Math.round(accuracy)} m`
          : 'Unknown'}
        <br />
        GPS timestamp:{' '}
        {record.location.timestamp || 'Unknown'}
      </p>

      <p className="muted">
        This map shows the recording location,
        not necessarily the capture location.
      </p>
    </>
  )
}

// ============================================================
// Export
// ============================================================

function csvCell(value) {
  let text = String(value ?? '')

  if (/^[=+\-@\t\r]/.test(text)) {
    text = "'" + text
  }

  return /[",\r\n]/.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text
}

function download(filename, content, type) {
  const blob = new Blob(
    [content],
    { type }
  )

  const url = URL.createObjectURL(blob)

  const link = document.createElement('a')

  link.href = url
  link.download = filename

  document.body.appendChild(link)
  link.click()
  link.remove()

  setTimeout(
    () => URL.revokeObjectURL(url),
    15000
  )
}

// ============================================================
// Main application
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
      const data = JSON.parse(
        localStorage.getItem(SETTINGS_KEY) ||
        'null'
      )

      return {
        ...DEFAULT_SETTINGS,
        ...data,

        masses: {
          ...DEFAULT_SETTINGS.masses,
          ...data?.masses,
        },

        rmax: {
          ...DEFAULT_SETTINGS.rmax,
          ...data?.rmax,
        },
      }
    } catch {
      return DEFAULT_SETTINGS
    }
  })

  const [
    settingsUnlocked,
    setSettingsUnlocked,
  ] = useState(false)

  const [password, setPassword] = useState('')

  const [
    methodFilter,
    setMethodFilter,
  ] = useState('All')

  const [
    monthFilter,
    setMonthFilter,
  ] = useState('All')

  const [
    mapIndicator,
    setMapIndicator,
  ] = useState('rb')

  // NEW: selected history record

  const [
    selectedRecordId,
    setSelectedRecordId,
  ] = useState(null)

  const saveInProgress = useRef(false)

  // ----------------------------------------------------------
  // Read saved records
  // ----------------------------------------------------------

  useEffect(() => {
    databaseAction('read')
      .then((data) => {
        setRecords(
          sortRecords(data)
        )

        setDbReady(true)
      })

      .catch((error) => {
        setMessage(
          'Database error: ' +
          error.message
        )
      })
  }, [])

  // Save settings

  useEffect(() => {
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify(settings)
      )
    } catch {
      // Storage may be unavailable in restricted browsers.
    }
  }, [settings])

  // ----------------------------------------------------------
  // Navigation
  // ----------------------------------------------------------

  function navigate(target) {
    setMessage('')

    if (target === 'settings') {
      setSettingsUnlocked(false)
      setPassword('')
    }

    setPage(target)
  }

  function newRecord() {
    setForm(blankForm())
    navigate('record')
  }

  function updateForm(patch) {
    setForm(
      (previous) => ({
        ...previous,
        ...patch,
      })
    )
  }

  function changeCount(speciesId, method, delta) {
    setForm((previous) => ({
      ...previous,

      byMethod: {
        ...previous.byMethod,

        [method]: {
          ...previous.byMethod[method],

          [speciesId]: Math.max(
            0,
            previous.byMethod[method][speciesId] +
              delta
          ),
        },
      },
    }))
  }

  // ----------------------------------------------------------
  // Save record and automatically acquire GPS
  // ----------------------------------------------------------

  async function saveRecord() {
    if (
      saveInProgress.current ||
      !dbReady
    ) {
      return
    }

    if (!settings.hunterId.trim()) {
      setMessage(
        'Please set Hunter ID in Settings.'
      )
      return
    }

    if (!validDate(form.captureDate)) {
      setMessage(
        'Invalid capture date.'
      )
      return
    }

    for (const value of [
      form.gunEffort,
      form.snareEffort,
    ]) {
      if (
        value !== '' &&
        (
          !Number.isFinite(Number(value)) ||
          Number(value) <= 0
        )
      ) {
        setMessage(
          'Hunting effort must be positive.'
        )
        return
      }
    }

    saveInProgress.current = true
    setBusy(true)

    setMessage(
      'Acquiring GPS automatically...'
    )

    const existing = records.find(
      (record) => record.id === form.id
    )

    let location = form.previousLocation
    let gpsError = null

    try {
      location = await getPosition()
    } catch (error) {
      gpsError = error.message
    }

    const now = new Date().toISOString()

    const record = {
      id:
        form.id ||
        crypto.randomUUID(),

      hunterId:
        existing?.hunterId ||
        settings.hunterId.trim(),

      captureDate: form.captureDate,
      timePeriod: form.period,

      byMethod: cleanByMethod(
        form.byMethod
      ),

      gunEffort:
        form.gunEffort === ''
          ? null
          : Number(form.gunEffort),

      snareEffort:
        form.snareEffort === ''
          ? null
          : Number(form.snareEffort),

      note: form.note.trim(),

      location: location || null,
      gpsError,

      recordedAt:
        existing?.recordedAt || now,

      updatedAt: now,
    }

    try {
      await databaseAction(
        'put',
        record
      )

      const updated = await databaseAction(
        'read'
      )

      setRecords(
        sortRecords(updated)
      )

      setForm(blankForm())
      setPage('indicators')

      setMessage(
        location
          ? `Record saved. GPS accuracy: ±${Math.round(
              Number(location.accuracy)
            )} m.`
          : `Record saved without GPS. ${
              gpsError || ''
            }`
      )
    } catch (error) {
      setMessage(
        'Save failed: ' +
        error.message
      )
    } finally {
      setBusy(false)
      saveInProgress.current = false
    }
  }

  // ----------------------------------------------------------
  // Edit record
  // ----------------------------------------------------------

  function editRecord(record) {
    const previousMethod =
      record.huntingMethod ||
      record.method

    const oldEffort =
      record.effort == null
        ? ''
        : String(record.effort)

    setForm({
      id: record.id,

      captureDate: record.captureDate,

      period:
        record.timePeriod ||
        record.period ||
        'Unknown',

      byMethod: getByMethod(record),

      gunEffort:
        record.gunEffort != null
          ? String(record.gunEffort)
          : previousMethod === 'Gun'
            ? oldEffort
            : '',

      snareEffort:
        record.snareEffort != null
          ? String(record.snareEffort)
          : previousMethod === 'Snare'
            ? oldEffort
            : '',

      note: record.note || '',

      previousLocation:
        record.location || null,
    })

    navigate('record')
  }

  // ----------------------------------------------------------
  // Delete record
  // ----------------------------------------------------------

  async function removeRecord(record) {
    if (
      !window.confirm(
        'Delete this record?'
      )
    ) {
      return
    }

    try {
      await databaseAction(
        'delete',
        record.id
      )

      setRecords(
        (previous) =>
          previous.filter(
            (item) =>
              item.id !== record.id
          )
      )

      if (selectedRecordId === record.id) {
        setSelectedRecordId(null)
      }

      setMessage(
        'Record deleted.'
      )
    } catch (error) {
      setMessage(
        'Delete failed: ' +
        error.message
      )
    }
  }

  // ----------------------------------------------------------
  // NEW: Open record detail
  // ----------------------------------------------------------

  function openRecordDetail(record) {
    setSelectedRecordId(record.id)
    navigate('recordDetail')
  }

  const selectedRecord = records.find(
    (record) =>
      record.id === selectedRecordId
  )

  // ----------------------------------------------------------
  // Filters
  // ----------------------------------------------------------

  const months = useMemo(
    () =>
      [
        ...new Set(
          records
            .map(
              (record) =>
                record.captureDate?.slice(0, 7)
            )
            .filter(Boolean)
        ),
      ].sort().reverse(),

    [records]
  )

  const dateFilteredRecords = useMemo(
    () =>
      records.filter(
        (record) =>
          monthFilter === 'All' ||
          record.captureDate?.startsWith(
            monthFilter
          )
      ),

    [records, monthFilter]
  )

  const filteredRecords = useMemo(
    () =>
      dateFilteredRecords.filter(
        (record) => {
          if (methodFilter === 'All') {
            return true
          }

          const catches = countTotal(
            getByMethod(record)[methodFilter]
          )

          if (catches > 0) {
            return true
          }

          if (
            methodFilter === 'Gun' &&
            Number(record.gunEffort) > 0
          ) {
            return true
          }

          if (
            methodFilter === 'Snare' &&
            Number(record.snareEffort) > 0
          ) {
            return true
          }

          // Legacy effort format

          const legacyMethod =
            record.huntingMethod ||
            record.method

          return (
            legacyMethod === methodFilter &&
            Number(record.effort) > 0
          )
        }
      ),

    [dateFilteredRecords, methodFilter]
  )

  const counts = useMemo(
    () =>
      methodFilter === 'All'
        ? totalsOf(filteredRecords)
        : totalsByMethod(
            filteredRecords,
            methodFilter
          ),

    [filteredRecords, methodFilter]
  )

  const indicators = useMemo(
    () =>
      calculateIndicators(
        counts,
        settings
      ),

    [counts, settings]
  )

  // ----------------------------------------------------------
  // Map GPS filtering
  // ----------------------------------------------------------

  const gpsRecords = useMemo(
    () =>
      filteredRecords.filter(
        (record) => {
          if (
            !validLocation(
              record.location
            )
          ) {
            return false
          }

          const accuracy = Number(
            record.location.accuracy
          )

          return (
            Number.isFinite(accuracy) &&
            accuracy >= 0 &&
            accuracy <=
              Number(settings.maxGpsAccuracy)
          )
        }
      ),

    [
      filteredRecords,
      settings.maxGpsAccuracy,
    ]
  )

  // ----------------------------------------------------------
  // Map clustering
  // ----------------------------------------------------------

  const clusters = useMemo(
    () =>
      clusterRecords(
        gpsRecords,
        Number(settings.clusterDistance)
      ).map((cluster) => {
        const clusterCounts =
          methodFilter === 'All'
            ? totalsOf(cluster.records)
            : totalsByMethod(
                cluster.records,
                methodFilter
              )

        return {
          ...cluster,

          counts: clusterCounts,

          metrics: {
            ...calculateIndicators(
              clusterCounts,
              settings
            ),

            gunCpue: calculateCpue(
              cluster.records,
              'Gun'
            ),

            snareCpue: calculateCpue(
              cluster.records,
              'Snare'
            ),
          },
        }
      }),

    [
      gpsRecords,
      settings,
      methodFilter,
    ]
  )

  // NEW: fixed scales for four indicators

  const mapScale = useMemo(
    () =>
      getMapScale(
        mapIndicator,
        clusters
      ),

    [mapIndicator, clusters]
  )

  // ----------------------------------------------------------
  // Export CSV
  // ----------------------------------------------------------

  function exportCsv() {
    const headers = [
      'record_id',
      'hunter_id',
      'capture_date',
      'time_period',

      ...METHODS.flatMap(
        (method) =>
          IDS.map(
            (id) =>
              `${method.toLowerCase()}_${id}`
          )
      ),

      'gun_effort_hunter_days',
      'snare_effort_trap_nights',

      'latitude',
      'longitude',
      'gps_accuracy_m',
      'gps_timestamp',

      'recorded_at',
      'updated_at',
      'note',
    ]

    const rows = records.map(
      (record) => {
        const matrix =
          getByMethod(record)

        const oldMethod =
          record.huntingMethod ||
          record.method

        const oldEffort = record.effort

        return [
          record.id,
          record.hunterId,
          record.captureDate,
          record.timePeriod ||
            record.period,

          ...METHODS.flatMap(
            (method) =>
              IDS.map(
                (id) =>
                  matrix[method][id]
              )
          ),

          record.gunEffort ??
            (
              oldMethod === 'Gun'
                ? oldEffort
                : ''
            ),

          record.snareEffort ??
            (
              oldMethod === 'Snare'
                ? oldEffort
                : ''
            ),

          record.location?.latitude ?? '',
          record.location?.longitude ?? '',
          record.location?.accuracy ?? '',
          record.location?.timestamp ?? '',

          record.recordedAt,
          record.updatedAt,
          record.note,
        ]
      }
    )

    const csv =
      '\ufeff' +
      [headers, ...rows]
        .map(
          (row) =>
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
          version: 3,
          app: 'WIs App',

          exportedAt:
            new Date().toISOString(),

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
      const data = JSON.parse(
        await file.text()
      )

      if (
        !Array.isArray(data.records)
      ) {
        throw new Error(
          'Invalid backup'
        )
      }

      for (const record of data.records) {
        if (
          typeof record.id !== 'string' ||
          !record.id ||
          typeof record.hunterId !== 'string' ||
          !validDate(record.captureDate) ||
          !(record.byMethod || record.counts)
        ) {
          throw new Error(
            'Invalid record in backup'
          )
        }

        if (
          record.location &&
          !validLocation(record.location)
        ) {
          throw new Error(
            'Invalid GPS coordinates'
          )
        }
      }

      if (
        !window.confirm(
          `Import ${data.records.length} records? ` +
          'Existing IDs will be replaced.'
        )
      ) {
        return
      }

      setBusy(true)

      await databaseAction(
        'putMany',
        data.records
      )

      const updated =
        await databaseAction('read')

      setRecords(
        sortRecords(updated)
      )

      setMessage(
        'Records imported successfully.'
      )
    } catch (error) {
      setMessage(
        'Import failed: ' +
        error.message
      )
    } finally {
      setBusy(false)
      event.target.value = ''
    }
  }

  // ----------------------------------------------------------
  // Totals
  // ----------------------------------------------------------

  const totalAnimals = countTotal(
    totalsOf(records)
  )

  const formTotal =
    METHODS.reduce(
      (sum, method) =>
        sum +
        countTotal(
          form.byMethod[method]
        ),
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

        {page !== 'home' && (
          <button
            className="back-button"
            onClick={() => {
              if (page === 'recordDetail') {
                navigate('history')
              } else {
                navigate('home')
              }
            }}
          >
            {page === 'recordDetail'
              ? '← History'
              : '← Home'}
          </button>
        )}

        {message && (
          <div
            className="notice"
            role="status"
          >
            {message}
          </div>
        )}

        {/* ================================================
            HOME
        ================================================ */}

        {page === 'home' && (
          <>
            <section className="card">
              <h2>Hunting Monitoring</h2>

              <p>
                Record catches and monitor
                wildlife indicators.
              </p>

              <div className="summary-grid">
                <div>
                  <strong>
                    {records.length}
                  </strong>

                  <span>Records</span>
                </div>

                <div>
                  <strong>
                    {totalAnimals}
                  </strong>

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
                  'Wildlife indicators and CPUE',
                ],

                [
                  'history',
                  '📋',
                  'History',
                  'Review recorded catches',
                ],

                [
                  'map',
                  '🗺️',
                  'Map',
                  'GPS-based indicator map',
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
              ].map(
                ([
                  id,
                  icon,
                  label,
                  description,
                ]) => (
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
                      <strong>
                        {label}
                      </strong>

                      <small>
                        {description}
                      </small>
                    </div>
                  </button>
                )
              )}
            </div>
          </>
        )}

        {/* ================================================
            NEW RECORD
        ================================================ */}

        {page === 'record' && (
          <section className="card">
            <h2>
              {form.id
                ? 'Edit Record'
                : 'New Hunting Record'}
            </h2>

            <h3>Capture date</h3>

            <div className="choice-buttons">
              {[0, 1, 2].map(
                (offset) => (
                  <button
                    key={offset}
                    className={
                      form.captureDate === today(offset)
                        ? 'selected'
                        : ''
                    }
                    onClick={() =>
                      updateForm({
                        captureDate:
                          today(offset),
                      })
                    }
                  >
                    {
                      [
                        'Today',
                        'Yesterday',
                        'Two days ago',
                      ][offset]
                    }
                  </button>
                )
              )}
            </div>

            <input
              type="date"
              max={today()}
              value={form.captureDate}
              onChange={(event) =>
                updateForm({
                  captureDate:
                    event.target.value,
                })
              }
            />

            <h3>Time of capture</h3>

            <div className="choice-buttons">
              {PERIODS.map(
                (period) => (
                  <button
                    key={period}
                    className={
                      form.period === period
                        ? 'selected'
                        : ''
                    }
                    onClick={() =>
                      updateForm({
                        period,
                      })
                    }
                  >
                    {period}
                  </button>
                )
              )}
            </div>

            <h3>Animals caught</h3>

            <p className="muted">
              Enter the number caught
              by each hunting method.
            </p>

            <div className="animal-list">
              {SPECIES.map(
                (species) => (
                  <div
                    className="animal-row"
                    key={species.id}
                  >
                    <div className="animal-name">
                      <span>
                        {species.icon}
                      </span>

                      <strong>
                        {species.name}
                      </strong>
                    </div>

                    <div className="method-grid">
                      {METHODS.map(
                        (method) => (
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
                                  `Decrease ${species.name} ${method}`
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
                                  `Increase ${species.name} ${method}`
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
                        )
                      )}
                    </div>
                  </div>
                )
              )}
            </div>

            <p className="total-line">
              Total animals:{' '}
              <strong>
                {formTotal}
              </strong>
            </p>

            <h3>
              Hunting effort (optional)
            </h3>

            <label className="field-label">
              Gun: hunter-days
            </label>

            <input
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={form.gunEffort}
              onChange={(event) =>
                updateForm({
                  gunEffort:
                    event.target.value,
                })
              }
              placeholder="Hunter-days"
            />

            <label className="field-label">
              Snare: trap-nights
            </label>

            <input
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={form.snareEffort}
              onChange={(event) =>
                updateForm({
                  snareEffort:
                    event.target.value,
                })
              }
              placeholder="Trap-nights"
            />

            <p className="muted">
              Zero-catch records are allowed.
              Effort is needed for CPUE.
            </p>

            <h3>Notes (optional)</h3>

            <textarea
              rows="2"
              value={form.note}
              onChange={(event) =>
                updateForm({
                  note:
                    event.target.value,
                })
              }
            />

            <p className="gps-hint">
              ◎ GPS location will be
              acquired automatically when
              you save the record.
            </p>

            <button
              className="primary-button"
              disabled={
                busy || !dbReady
              }
              onClick={saveRecord}
            >
              {busy
                ? 'Acquiring GPS / Saving...'
                : 'Save Record'}
            </button>
          </section>
        )}

        {/* ================================================
            INDICATORS
        ================================================ */}

        {page === 'indicators' && (
          <section className="card">
            <h2>Wildlife Indicators</h2>

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

              {METHODS.map(
                (method) => (
                  <option
                    key={method}
                    value={method}
                  >
                    {method}
                  </option>
                )
              )}
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

              {months.map(
                (month) => (
                  <option
                    key={month}
                    value={month}
                  >
                    {month}
                  </option>
                )
              )}
            </select>

            <div className="summary-grid">
              <div>
                <strong>
                  {filteredRecords.length}
                </strong>

                <span>Records</span>
              </div>

              <div>
                <strong>
                  {indicators.total}
                </strong>

                <span>Animals</span>
              </div>
            </div>

            <div className="indicator-grid">
              {INDICATORS.slice(0, 6).map(
                ([id, label]) => (
                  <div
                    className="indicator-card"
                    key={id}
                  >
                    <span>
                      {label}
                    </span>

                    <strong>
                      {fmt(
                        indicators[id]
                      )}
                    </strong>
                  </div>
                )
              )}

              <div className="indicator-card">
                <span>
                  Gun CPUE
                  (animals / hunter-day)
                </span>

                <strong>
                  {fmt(
                    calculateCpue(
                      filteredRecords,
                      'Gun'
                    )
                  )}
                </strong>
              </div>

              <div className="indicator-card">
                <span>
                  Snare CPUE
                  (animals / trap-night)
                </span>

                <strong>
                  {fmt(
                    calculateCpue(
                      filteredRecords,
                      'Snare'
                    )
                  )}
                </strong>
              </div>
            </div>

            <h3>Species totals</h3>

            {SPECIES.map(
              (species) => (
                <div
                  className="species-total"
                  key={species.id}
                >
                  <span>
                    {species.name}
                  </span>

                  <strong>
                    {
                      counts[
                        species.id
                      ]
                    }
                  </strong>
                </div>
              )
            )}

            <p className="muted">
              Indicators are calculated
              from hunting records,
              not camera-trap detection rates.
            </p>
          </section>
        )}

        {/* ================================================
            HISTORY — CHRONOLOGICAL ORDER
        ================================================ */}

        {page === 'history' && (
          <section className="card">
            <h2>History</h2>

            <p className="muted">
              Records are sorted by capture
              date, newest first.
            </p>

            <p>
              {records.length} records
            </p>

            {records.length === 0 && (
              <p>No records yet.</p>
            )}

            {records.map(
              (record) => {
                const matrix =
                  getByMethod(record)

                const total =
                  METHODS.reduce(
                    (sum, method) =>
                      sum +
                      countTotal(
                        matrix[method]
                      ),
                    0
                  )

                return (
                  <div
                    className="history-record"
                    key={record.id}
                  >
                    <strong>
                      {record.captureDate}
                      {' · '}
                      {
                        record.timePeriod ||
                        record.period
                      }
                    </strong>

                    <p>
                      Hunter:{' '}
                      {record.hunterId}
                    </p>

                    <p>
                      Animals: {total}
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
                                  `${species.id}-${method}`
                                }
                              >
                                {species.name}
                                {' · '}
                                {method}
                                {': '}
                                {number}
                              </p>
                            ) : null
                          }
                        )
                    )}

                    {validLocation(
                      record.location
                    ) ? (
                      <p className="muted">
                        GPS recorded
                      </p>
                    ) : (
                      <p className="muted">
                        No GPS recorded
                      </p>
                    )}

                    <div className="history-actions">
                      <button
                        className="secondary-button"
                        onClick={() =>
                          openRecordDetail(
                            record
                          )
                        }
                      >
                        View Location
                      </button>

                      <button
                        className="secondary-button"
                        onClick={() =>
                          editRecord(
                            record
                          )
                        }
                      >
                        Edit
                      </button>

                      <button
                        className="delete-button"
                        onClick={() =>
                          removeRecord(
                            record
                          )
                        }
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )
              }
            )}
          </section>
        )}

        {/* ================================================
            NEW: RECORD DETAIL + MAP
        ================================================ */}

        {page === 'recordDetail' && (
          <section className="card">
            <h2>Record Details</h2>

            {!selectedRecord ? (
              <p>
                Record not found.
              </p>
            ) : (
              <>
                <h3>
                  {
                    selectedRecord.captureDate
                  }
                </h3>

                <p>
                  Time:{' '}
                  {
                    selectedRecord.timePeriod ||
                    selectedRecord.period
                  }
                </p>

                <p>
                  Hunter:{' '}
                  {
                    selectedRecord.hunterId
                  }
                </p>

                <h3>
                  Animals caught
                </h3>

                {SPECIES.map(
                  (species) =>
                    METHODS.map(
                      (method) => {
                        const number =
                          getByMethod(
                            selectedRecord
                          )[method][species.id]

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

                            <strong>
                              {number}
                            </strong>
                          </div>
                        ) : null
                      }
                    )
                )}

                {selectedRecord.note && (
                  <>
                    <h3>Notes</h3>

                    <p>
                      {
                        selectedRecord.note
                      }
                    </p>
                  </>
                )}

                <h3>
                  Recording Location
                </h3>

                <RecordLocationMap
                  record={selectedRecord}
                />

                <button
                  className="secondary-button"
                  onClick={() =>
                    editRecord(
                      selectedRecord
                    )
                  }
                >
                  Edit Record
                </button>
              </>
            )}
          </section>
        )}

        {/* ================================================
            MAP
        ================================================ */}

        {page === 'map' && (
          <section className="card map-card">
            <h2>
              Wildlife Indicators Map
            </h2>

            <h3>Indicator</h3>

            <select
              value={mapIndicator}
              onChange={(event) =>
                setMapIndicator(
                  event.target.value
                )
              }
            >
              {INDICATORS.map(
                ([id, label]) => (
                  <option
                    key={id}
                    value={id}
                  >
                    {label}
                  </option>
                )
              )}
            </select>

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

              {METHODS.map(
                (method) => (
                  <option
                    key={method}
                    value={method}
                  >
                    {method}
                  </option>
                )
              )}
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

              {months.map(
                (month) => (
                  <option
                    key={month}
                    value={month}
                  >
                    {month}
                  </option>
                )
              )}
            </select>

            <div className="map-settings-row">
              <label>
                Cluster distance (m)

                <select
                  value={
                    settings.clusterDistance
                  }
                  onChange={(event) =>
                    setSettings(
                      (previous) => ({
                        ...previous,

                        clusterDistance:
                          Number(
                            event.target.value
                          ),
                      })
                    )
                  }
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
                Circle radius (m)

                <select
                  value={
                    settings.circleRadius
                  }
                  onChange={(event) =>
                    setSettings(
                      (previous) => ({
                        ...previous,

                        circleRadius:
                          Number(
                            event.target.value
                          ),
                      })
                    )
                  }
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

            {/* Color legend */}

            <div className="map-legend">
              <div className="legend-gradient" />

              <div className="legend-labels">
                <span>
                  {fmt(
                    mapScale.min,
                    2
                  )}
                </span>

                <span>
                  {fmt(
                    mapScale.middle,
                    2
                  )}
                </span>

                <span>
                  {fmt(
                    mapScale.max,
                    2
                  )}
                </span>
              </div>
            </div>

            <p className="muted">
              {FIXED_SCALES[mapIndicator]
                ? 'Fixed color scale: red = lower, yellow = middle, green = higher.'
                : 'Relative color scale based on the observed values.'}
            </p>

            <div className="map-summary">
              <span>
                GPS records:{' '}
                {gpsRecords.length}
              </span>

              <span>
                Clusters:{' '}
                {clusters.length}
              </span>

              <span>
                Excluded:{' '}
                {
                  filteredRecords.length -
                  gpsRecords.length
                }
              </span>
            </div>

            {/* OpenStreetMap */}

            <div className="map-container">
              <MapContainer
                center={[2.5, 15.0]}
                zoom={9}
                scrollWheelZoom={true}
                className="leaflet-map"
              >
                <TileLayer
                  attribution="&copy; OpenStreetMap contributors"
                  url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
                  maxZoom={19}
                />

                <FitBounds
                  clusters={clusters}
                />

                {clusters.map(
                  (cluster) => {
                    const value =
                      cluster.metrics[
                        mapIndicator
                      ]

                    const fill =
                      getColor(
                        value,
                        mapScale.min,
                        mapScale.max
                      )

                    return (
                      <Circle
                        key={cluster.id}
                        center={[
                          cluster.latitude,
                          cluster.longitude,
                        ]}
                        radius={
                          Number(
                            settings.circleRadius
                          )
                        }
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
                              Cluster{' '}
                              {cluster.id}
                            </h3>

                            <p>
                              Records:{' '}
                              {
                                cluster.records.length
                              }
                            </p>

                            <p>
                              Animals:{' '}
                              {
                                cluster.metrics.total
                              }
                            </p>

                            <p>
                              GPS:{' '}
                              {
                                cluster.latitude.toFixed(6)
                              }
                              {', '}
                              {
                                cluster.longitude.toFixed(6)
                              }
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
                                <p
                                  key={species.id}
                                >
                                  {species.name}
                                  {': '}
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
                  }
                )}
              </MapContainer>
            </div>

            <p className="muted">
              Map tiles require internet access.
              GPS points are grouped using
              complete-linkage clustering.
              Colors are visualization values,
              not ecological safety thresholds.
            </p>

            {clusters.length === 0 && (
              <div className="notice">
                No valid GPS clusters.
              </div>
            )}
          </section>
        )}

        {/* ================================================
            EXPORT
        ================================================ */}

        {page === 'export' && (
          <section className="card">
            <h2>Export / Backup</h2>

            <button
              className="primary-button"
              onClick={exportCsv}
            >
              Download CSV
            </button>

            <button
              className="secondary-button"
              onClick={exportJson}
            >
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
              Records with matching IDs are
              replaced. Imported records can
              also be displayed on the Map.
            </p>
          </section>
        )}

        {/* ================================================
            SETTINGS PASSWORD
        ================================================ */}

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
                  setPassword(
                    event.target.value
                  )
                }
              />

              <button
                className="primary-button"
                onClick={() => {
                  if (
                    password ===
                    SETTINGS_PASSWORD
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

        {/* ================================================
            SETTINGS CONTENT
        ================================================ */}

        {page === 'settings' &&
          settingsUnlocked && (
            <section className="card">
              <h2>Settings</h2>

              <h3>Hunter ID</h3>

              <input
                value={settings.hunterId}
                placeholder="e.g. H01"
                onChange={(event) =>
                  setSettings(
                    (previous) => ({
                      ...previous,

                      hunterId:
                        event.target.value,
                    })
                  )
                }
              />

              <h3>
                Maximum GPS error (m)
              </h3>

              <input
                type="number"
                min="1"
                value={
                  settings.maxGpsAccuracy
                }
                onChange={(event) =>
                  setSettings(
                    (previous) => ({
                      ...previous,

                      maxGpsAccuracy:
                        Math.max(
                          1,
                          Number(
                            event.target.value
                          ) || 1
                        ),
                    })
                  )
                }
              />

              <h3>
                Species parameters
              </h3>

              <p className="muted">
                Mean mass: Hongo et al. (2022).
                rmax: values attributed to
                Fa et al. (2015).
              </p>

              {SPECIES.map(
                (species) => (
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
                            settings.masses[
                              species.id
                            ]
                          }
                          onChange={(event) =>
                            setSettings(
                              (previous) => ({
                                ...previous,

                                masses: {
                                  ...previous.masses,

                                  [species.id]:
                                    event.target.value,
                                },
                              })
                            )
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
                            settings.rmax[
                              species.id
                            ]
                          }
                          onChange={(event) =>
                            setSettings(
                              (previous) => ({
                                ...previous,

                                rmax: {
                                  ...previous.rmax,

                                  [species.id]:
                                    event.target.value,
                                },
                              })
                            )
                          }
                        />
                      </label>
                    </div>
                  </div>
                )
              )}

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
        WIs App v3.1 · Wildlife Monitoring
      </footer>
    </div>
  )
}