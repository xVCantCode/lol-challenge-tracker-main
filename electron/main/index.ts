import { app, BrowserWindow, shell, ipcMain } from "electron"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import path from "node:path"
import os from "node:os"
import { WebSocket } from "ws"
import Store from "electron-store"
import { execFile } from "child_process"
import https from "https"
import {
  ChampSelectSessionEvent,
  LCUEventMessage,
  LCUEvents,
} from "./interface.js"
import { Champion, Summoner } from "../src/types/lol.js"
import { RawChallenge } from "../src/types/lcu.js"

interface LcuCredentials {
  port: string
  token: string
}

interface LcuData {
  summoner: Summoner
  champions: Champion[]
  challenges: Record<string, RawChallenge>
}

const IpcChannels = {
  GET_LCU_DATA: "get-lcu-data",
  STORE_GET: "store-get",
  STORE_SET: "store-set",
  STORE_DELETE: "store-delete",
  PROCESS_CLOSE: "process:close",
  GAME_START: "game-start",
  GAMEFLOW_UPDATE: "gameflow",
  CROWD_FAVORITES: "crowd-favorites",
  END_OF_GAME: "end-of-game",
  PICK: "pick",
}

type ChampSelectUpdatePayload = {
  championId: number | null
  benchChampionIds: number[]
  crowdFavoriteChampionIds?: number[]
}

const normalizeChampion = (c: any): Champion | null => {
  const id = Number(c?.id ?? c?.championId ?? c?.champion?.id ?? -1)
  if (!Number.isFinite(id)) return null

  const alias = String(c?.alias ?? c?.champion?.alias ?? c?.aliasName ?? c?.key ?? "")
  const name = String(c?.name ?? c?.champion?.name ?? c?.displayName ?? "")
  const active = Boolean(c?.active ?? c?.owned ?? true)

  const rawRoles = c?.roles ?? c?.champion?.roles ?? c?.tags ?? []
  const roles = Array.isArray(rawRoles) ? rawRoles : []

  const normalizedRoles = roles
    .map((r) => String(r).toLowerCase())
    .filter((r) =>
      r === "assassin" ||
      r === "fighter" ||
      r === "mage" ||
      r === "marksman" ||
      r === "support" ||
      r === "tank"
    )

  return {
    id,
    alias,
    name,
    roles: normalizedRoles.length > 0 ? (normalizedRoles as any) : (["fighter"] as any),
    active,
  }
}

const normalizeChampionList = (data: any): Champion[] => {
  const arr = Array.isArray(data)
    ? data
    : Array.isArray(data?.champions)
      ? data.champions
      : Array.isArray(data?.data)
        ? data.data
        : []

  if (!Array.isArray(arr)) return []

  return arr
    .map(normalizeChampion)
    .filter((c): c is Champion => Boolean(c))
}

async function fetchChampions(
  creds: LcuCredentials,
  summonerId: number
): Promise<Champion[]> {
  const endpoints = [
    `/lol-champions/v1/inventories/${summonerId}/champions-minimal`,
    `/lol-champions/v1/inventories/${summonerId}/champions`,
    "/lol-champions/v1/owned-champions-minimal",
    "/lol-champions/v1/champions-minimal",
  ]

  let lastError: unknown = null
  for (const endpoint of endpoints) {
    try {
      const data = await lcuRequest<any>(creds.port, creds.token, endpoint)
      const champs = normalizeChampionList(data)
      if (champs.length > 0) return champs
    } catch (e) {
      lastError = e
    }
  }

  throw (
    lastError ??
    new Error("Failed to fetch champions from LCU (all known endpoints failed).")
  )
}

function getLCUCredentials(): Promise<LcuCredentials | null> {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      return resolve(null)
    }

    const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
    const powershellExe = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

    const psScript =
      "$cmd = (Get-CimInstance Win32_Process -Filter \"Name='LeagueClientUx.exe'\" | Select-Object -First 1 -ExpandProperty CommandLine); " +
      "if (-not $cmd) { exit 1 }; " +
      "$port = $null; $token = $null; " +
      "if ($cmd -match '--app-port=(\\d+)') { $port = $Matches[1] } elseif ($cmd -match '--riotclient-app-port=(\\d+)') { $port = $Matches[1] }; " +
      "if ($cmd -match '--remoting-auth-token=([\\w-]+)') { $token = $Matches[1] } elseif ($cmd -match '--riotclient-auth-token=([\\w-]+)') { $token = $Matches[1] }; " +
      "if ($port -and $token) { Write-Output ($port + '|' + $token) } else { exit 2 }"

    execFile(
      powershellExe,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript],
      { windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout) => {
      if (error) {
        return resolve(null)
      }

      const [port, token] = stdout.trim().split("|")

      if (!port || !token) {
        return resolve(null)
      }
      resolve({ port, token })
      }
    )
  })
}

const httpsAgent = new https.Agent({ rejectUnauthorized: false })

function lcuRequest<T>(
  port: string,
  token: string,
  endpoint: string
): Promise<T> {
  const auth = Buffer.from(`riot:${token}`).toString("base64")
  const options = {
    hostname: "127.0.0.1",
    port: port,
    path: endpoint,
    method: "GET",
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
    },
    agent: httpsAgent,
  }

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = ""
      res.on("data", (chunk) => (data += chunk))
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          return reject(
            new Error(`LCU API Error for ${endpoint}: ${res.statusCode}`)
          )
        }
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          reject(new Error(`Failed to parse LCU API response: ${e.message}`))
        }
      })
    })
    req.on("error", (e) => reject(e))
    req.end()
  })
}

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, "../..")

export const MAIN_DIST = path.join(process.env.APP_ROOT, "dist-electron")
export const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist")
export const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, "public")
  : RENDERER_DIST

// Disable GPU Acceleration for Windows 7
if (os.release().startsWith("6.1")) app.disableHardwareAcceleration()

// Set application name for Windows 10+ notifications
if (process.platform === "win32") app.setAppUserModelId(app.getName())

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

const preload = path.join(__dirname, "../preload/index.mjs")
const indexHtml = path.join(RENDERER_DIST, "index.html")
let lcuWebsocket: WebSocket | null = null
let lcuWebsocketKey: string | null = null
let crowdFavoriteChampionIds: number[] = []
let crowdFavoritePollInterval: ReturnType<typeof setInterval> | null = null
let crowdFavoritePollKey = ""

async function createWindow() {
  const win = new BrowserWindow({
    title: "Main window",
    icon: path.join(process.env.VITE_PUBLIC, "favicon.ico"),
    autoHideMenuBar: true,
    height: 920,
    width: VITE_DEV_SERVER_URL ? 1440 + 760 : 1440,
    webPreferences: {
      preload,
      nodeIntegration: true,
      allowRunningInsecureContent: true,
      webSecurity: false,
      // Warning: Enable nodeIntegration and disable contextIsolation is not secure in production
      // nodeIntegration: true,

      // Consider using contextBridge.exposeInMainWorld
      // Read more on https://www.electronjs.org/docs/latest/tutorial/context-isolation
      // contextIsolation: false,
    },
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
    // Open devTool if the app is not packaged
    win.webContents.openDevTools()
  } else {
    win.loadFile(indexHtml)
  }

  // Make all links open with the browser, not with the application
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https:")) shell.openExternal(url)
    return { action: "deny" }
  })
  // win.webContents.on('will-navigate', (event, url) => { }) #344

  return win
}

async function connectWebsocket(win: BrowserWindow, creds: LcuCredentials) {
  const key = `${creds.port}:${creds.token}`
  if (
    lcuWebsocket &&
    lcuWebsocketKey === key &&
    (lcuWebsocket.readyState === WebSocket.OPEN ||
      lcuWebsocket.readyState === WebSocket.CONNECTING)
  ) {
    return
  }
  if (lcuWebsocket) {
    try {
      lcuWebsocket.terminate()
    } catch {
    }
    lcuWebsocket = null
    lcuWebsocketKey = null
  }

  const url = `wss://127.0.0.1:${creds.port}/`
  const ws = new WebSocket(url, "wamp", {
    headers: {
      Authorization: `Basic ${Buffer.from(`riot:${creds.token}`).toString(
        "base64"
      )}`,
    },
    rejectUnauthorized: false,
  })
  lcuWebsocket = ws
  lcuWebsocketKey = key

  ws.on("message", (e) => {
    try {
      const event: LCUEventMessage = parseEventMessage(e.toString())
      switch (event.type) {
        case LCUEvents.EndOfGameStats:
          win.webContents.send(IpcChannels.END_OF_GAME)
          break
        case LCUEvents.CrowdFavoriteChampionList: {
          const ids = parseCrowdFavoriteChampionIds(event.data)
          crowdFavoriteChampionIds = ids
          win.webContents.send(IpcChannels.CROWD_FAVORITES, ids)
          break
        }
        case LCUEvents.ChampSelectSession: {
          const payload = parseSessionEvent(event.data)
          win.webContents.send(IpcChannels.PICK, payload)
          break
        }
        case LCUEvents.GameSession:
          const gameMode =
            (event.data as any)?.gameData?.queue?.gameMode ??
            (event.data as any)?.gameData?.gameMode ??
            null

          win.webContents.send(IpcChannels.GAMEFLOW_UPDATE, {
            phase: event.data.phase,
            gameMode,
          })

          const upperMode = String(gameMode ?? "").toUpperCase()
          if (upperMode.includes("ARENA") || upperMode === "CHERRY") {
            startCrowdFavoritePolling(win, creds)
          } else {
            stopCrowdFavoritePolling()
          }
          if (event.data.phase === "InProgress") {
            win.webContents.send(
              IpcChannels.GAME_START,
              event.data.gameData.playerChampionSelections
            )
          }
          break
      }
    } catch (error) {
      console.error("Failed to parse WebSocket message:", error)
    }
  })

  // https://github.com/dysolix/hasagi-types/blob/main/dist/lcu-events.d.ts
  ws.on("open", () => {
    console.log("🔌 WebSocket connected")
    // 5 Means Subscribe
    ws.send(`[5, "OnJsonApiEvent"]`)
    ws.send(`[5, "${LCUEvents.EndOfGameStats}"]`)
    ws.send(`[5, "${LCUEvents.ChampSelectSession}"]`)
    ws.send(`[5, "${LCUEvents.GameSession}"]`)
    ws.send(`[5, "${LCUEvents.CrowdFavoriteChampionList}"]`)

    void (async () => {
      try {
        const data = await lcuRequest<any>(
          creds.port,
          creds.token,
          "/lol-lobby-team-builder/champ-select/v1/crowd-favorite-champion-list"
        )
        const ids = parseCrowdFavoriteChampionIds(data)
        crowdFavoriteChampionIds = ids
        win.webContents.send(IpcChannels.CROWD_FAVORITES, ids)
      } catch {
      }
    })()
  })

  ws.on("close", () => {
    console.log("🔌 WebSocket disconnected")
    stopCrowdFavoritePolling()
    if (lcuWebsocket === ws) {
      lcuWebsocket = null
      lcuWebsocketKey = null
    }
  })
}

function parseSessionEvent(event: ChampSelectSessionEvent): ChampSelectUpdatePayload {
  const championId =
    event.actions
      .flat()
      .find(
        (a) =>
          a.isAllyAction === true &&
          a.type === "pick" &&
          a.actorCellId === event.localPlayerCellId
      )?.championId ?? null

  const benchChampionIds = event.benchEnabled
    ? (event.benchChampions ?? [])
        .map((c) => c.championId)
        .filter((id) => id > 0)
    : []

  return {
    championId: championId && championId > 0 ? championId : null,
    benchChampionIds: Array.from(new Set(benchChampionIds)),
    crowdFavoriteChampionIds: crowdFavoriteChampionIds.length > 0 ? crowdFavoriteChampionIds : undefined,
  }
}

function parseCrowdFavoriteChampionIds(data: any): number[] {
  if (Array.isArray(data)) {
    return Array.from(new Set(data.filter((v) => typeof v === "number" && v > 0)))
  }

  const candidate =
    data?.championIds ??
    data?.champions ??
    data?.ids ??
    data?.data ??
    data?.crowdFavoriteChampionIds ??
    data?.crowdFavoriteChampions ??
    null

  if (Array.isArray(candidate)) {
    const ids = candidate
      .map((v) => (typeof v === "number" ? v : v?.championId))
      .filter((v) => typeof v === "number" && v > 0) as number[]
    return Array.from(new Set(ids))
  }

  return []
}

function startCrowdFavoritePolling(win: BrowserWindow, creds: LcuCredentials) {
  const key = `${creds.port}:${creds.token}`
  if (crowdFavoritePollInterval && crowdFavoritePollKey === key) {
    return
  }

  stopCrowdFavoritePolling()
  crowdFavoritePollKey = key

  const poll = async () => {
    try {
      const data = await lcuRequest<any>(
        creds.port,
        creds.token,
        "/lol-lobby-team-builder/champ-select/v1/crowd-favorite-champion-list"
      )
      const ids = parseCrowdFavoriteChampionIds(data)
      const prev = crowdFavoriteChampionIds.join(",")
      const next = ids.join(",")
      if (prev !== next) {
        crowdFavoriteChampionIds = ids
        win.webContents.send(IpcChannels.CROWD_FAVORITES, ids)
      }
    } catch {
    }
  }

  void poll()
  crowdFavoritePollInterval = setInterval(() => void poll(), 1000)
}

function stopCrowdFavoritePolling() {
  if (crowdFavoritePollInterval) {
    clearInterval(crowdFavoritePollInterval)
    crowdFavoritePollInterval = null
  }
  crowdFavoritePollKey = ""
}

function lcuEventTypeFromUri(uri: string): LCUEvents | null {
  switch (uri) {
    case "/lol-end-of-game/v1/eog-stats-block":
      return LCUEvents.EndOfGameStats
    case "/lol-champ-select/v1/session":
      return LCUEvents.ChampSelectSession
    case "/lol-gameflow/v1/session":
      return LCUEvents.GameSession
    case "/lol-lobby-team-builder/champ-select/v1/crowd-favorite-champion-list":
      return LCUEvents.CrowdFavoriteChampionList
    default:
      return null
  }
}

function parseEventMessage(message: string) {
  const parsed = JSON.parse(message) as [number, string, any]
  const type = parsed[1]
  const payload = parsed[2]

  if (type === "OnJsonApiEvent") {
    const mapped = lcuEventTypeFromUri(String(payload?.uri ?? ""))
    if (!mapped) {
      return { type: "__unknown__" as any, data: payload?.data }
    }
    return { type: mapped, data: payload?.data }
  }

  return { type: type as any, data: payload?.data }
}

function isDoomBotChampion(champ: Champion) {
  const name = champ.name ?? ""
  return /^doom\s*bot\b/i.test(name)
}

const store = new Store()

async function main() {
  await app.whenReady()
  const win = await createWindow()

  ipcMain.handle(IpcChannels.GET_LCU_DATA, async (): Promise<LcuData | null> => {
    console.log("🎮 Searching for League Client...")
    const creds = await getLCUCredentials()
    if (!creds) {
      console.error("❌ League Client not found.")
      return null
    }
    console.log(`✅ Connected on Port ${creds.port}`)

    try {
      console.log("📥 Downloading data from Client...")
      const summoner = await lcuRequest<Summoner>(
        creds.port,
        creds.token,
        "/lol-summoner/v1/current-summoner"
      )

      const [champions, challenges] = await Promise.all([
        fetchChampions(creds, summoner.summonerId),
        lcuRequest<Record<string, RawChallenge>>(
          creds.port,
          creds.token,
          "/lol-challenges/v1/challenges/local-player"
        ),
      ])
      const filteredChampions = champions.filter((c) => !isDoomBotChampion(c))
      console.log("✅ Data successfully loaded.")

      connectWebsocket(win, creds)
      return { summoner, champions: filteredChampions, challenges }
    } catch (err) {
      console.error("❌ ERROR fetching LCU data:", err)
      return null
    }
  })

  ipcMain.on(IpcChannels.STORE_SET, (_, key: string, value: any) => {
    store.set(key, value)
  })

  ipcMain.handle(IpcChannels.STORE_GET, (_e, arg: string) => {
    return store.get(arg)
  })

  ipcMain.on(IpcChannels.STORE_DELETE, (_, key: string) => {
    store.delete(key)
  })

  app.on(
    "certificate-error",
    (event, _webContents, _url, _error, certificate, callback) => {
      if (
        certificate.fingerprint ===
        "sha256/TQ1pFVrt3Msu+IVgubjrrixp75XCuDFovDbcTcqTJjw="
      ) {
        event.preventDefault()
        callback(true)
      } else {
        callback(false)
      }
    }
  )

  app.on("window-all-closed", () => {
    app.quit()
  })

  ipcMain.on(IpcChannels.PROCESS_CLOSE, () => {
    process.exit(0)
  })
}

app.commandLine.appendSwitch("ignore-certificate-errors")

main()
