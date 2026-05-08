<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed, watch } from "vue"
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome"
import { faGear } from "@fortawesome/free-solid-svg-icons"
import { LcuData, StoredSettings } from "./types/app"
import { AramStats, Challenge, Champion, Summoner } from "./types/lol"
import {
  challengeFromCompletedIds as challengeFromRaw,
  parseMerakiFile,
} from "./helpers/utils"
import { challengeWithCompletion } from "./constants"
import ChallengeSection from "./components/ChallengeSection.vue"
import Settings from "./components/Settings.vue"
import LeagueDropdown from "./components/LeagueDropdown.vue"

const allChampions = ref<Champion[] | null>(null)
const summoner = ref<Summoner | null>(null)
const challenges = ref<Challenge[]>([])
const stats = ref<AramStats | null>(null)
const selectedChampId = ref<number | null>(null)
const benchChampionIds = ref<number[]>([])
const crowdFavoriteChampionIds = ref<number[]>([])
const sessionGameMode = ref<string | null>(null)
let lcuRetryTimeout: ReturnType<typeof setTimeout> | null = null

const scheduleLCURetry = () => {
  if (lcuRetryTimeout) return
  lcuRetryTimeout = setTimeout(() => {
    lcuRetryTimeout = null
    fetchAllDataFromMain()
  }, 2500)
}

const fetchAllDataFromMain = async () => {
  const data = (await window.ipcRenderer.invoke(
    "get-lcu-data"
  )) as LcuData | null

  if (!data || !data.summoner) {
    console.log("LCU data not found, waiting for client...")
    summoner.value = null
    allChampions.value = null
    challenges.value = []
    scheduleLCURetry()
    return
  }

  if (lcuRetryTimeout) {
    clearTimeout(lcuRetryTimeout)
    lcuRetryTimeout = null
  }

  summoner.value = data.summoner
  const allChamps = data.champions
    .filter((c: Champion) => c.id > 0)
    .sort((a: Champion, b: Champion) => (a.name ?? "").localeCompare(b.name ?? ""))
  allChampions.value = allChamps

  challenges.value = challengeWithCompletion
    .map((c) => {
      const challengeData = data.challenges[c.id]
      if (!challengeData) return null
      return challengeFromRaw(challengeData, allChamps, c.gameMode)
    })
    .filter((c): c is Challenge => c !== null)
}

const fetchAramStats = async () => {
  try {
    const res = await fetch(
      `https://cdn.merakianalytics.com/riot/lol/resources/latest/en-US/champions.json`
    )
    if (!res.ok) throw new Error("Failed to fetch ARAM stats")

    const parsed = parseMerakiFile(await res.json())
    window.ipcRenderer.send("store-set", "aram-stats", JSON.stringify(parsed))
    stats.value = parsed
  } catch (e) {
    console.error("Could not fetch ARAM stats:", e)
  }
}

onMounted(async () => {
  await fetchAllDataFromMain()

  const storedAramStats = await window.ipcRenderer.invoke("store-get", "aram-stats")
  if (storedAramStats) {
    stats.value = JSON.parse(storedAramStats)
  } else {
    await fetchAramStats()
  }

  const storedSettings = await window.ipcRenderer.invoke("store-get", "settings")
  if (storedSettings) {
    const settings: StoredSettings = JSON.parse(storedSettings)
    isColoredWhenDone.value = settings.isColoredWhenDone
    showChampionNames.value = settings.showChampionNames
  }

  // Reset to default challenge (All Random All Champs - index 0)
  window.ipcRenderer.send("store-delete", "selected-challenge-index")
})

onUnmounted(() => {
  if (lcuRetryTimeout) {
    clearTimeout(lcuRetryTimeout)
    lcuRetryTimeout = null
  }
})

const selectedChallengeIndex = ref(0)
const isColoredWhenDone = ref(false)
const showChampionNames = ref(false)

const autoChallengeIndexForSession = (mode: string | null) => {
  const v = (mode ?? "").toUpperCase()
  if (!v) return null
  if (v === "ARAM" || v === "KIWI") return 0
  if (v.includes("ARENA") || v === "CHERRY") return 2
  return null
}

watch(sessionGameMode, (mode) => {
  const idx = autoChallengeIndexForSession(mode)
  if (idx === null) return
  selectedChallengeIndex.value = idx
})

const selectedChamp = computed(() => {
  const champId = selectedChampId.value
  if (champId === null) return null
  const champ = challenges.value[selectedChallengeIndex.value]?.champions.find(
    (c) => c.id === champId
  )
  return champ ?? null
})

const updateSettings = (settings: StoredSettings) => {
  isColoredWhenDone.value = settings.isColoredWhenDone
  showChampionNames.value = settings.showChampionNames
  window.ipcRenderer.send("store-set", "settings", JSON.stringify(settings))
}

type ChampSelectUpdatePayload =
  | number
  | null
  | {
      championId: number | null
      benchChampionIds?: number[]
    }

const handlePickEvent = (champId: number | null) => {
  selectedChampId.value = champId
}

const handleChampSelectUpdate = (payload: ChampSelectUpdatePayload) => {
  if (typeof payload === "number" || payload === null) {
    handlePickEvent(payload)
    benchChampionIds.value = []
    return
  }

  handlePickEvent(payload.championId ?? null)
  benchChampionIds.value = payload.benchChampionIds ?? []
}

window.ipcRenderer.on("end-of-game", () => {
  selectedChampId.value = null
  benchChampionIds.value = []
  crowdFavoriteChampionIds.value = []
  sessionGameMode.value = null
  fetchAllDataFromMain()
})

window.ipcRenderer.on("pick", (_event, payload: ChampSelectUpdatePayload) => {
  handleChampSelectUpdate(payload)
})

window.ipcRenderer.on("crowd-favorites", (_event, ids: number[] | null) => {
  crowdFavoriteChampionIds.value = ids ?? []
})

window.ipcRenderer.on(
  "gameflow",
  (_event, payload: { phase?: string; gameMode?: string | null } | null) => {
    sessionGameMode.value = payload?.gameMode ?? null
  }
)

window.ipcRenderer.on(
  "game-start",
  (_event, champSelect: { championId: number; puuid: string }[]) => {
    if (!summoner.value) return
    const localPuuid = summoner.value.puuid
    const localPickedChamp = champSelect.find((c) => c.puuid === localPuuid)
    if (localPickedChamp) {
      handlePickEvent(localPickedChamp.championId)
      benchChampionIds.value = []
    }
  }
)

const settingsVisible = ref(false)
const challengeOptions = computed(() =>
  challenges.value.map((challenge, idx) => ({
    name: challenge.name,
    value: idx,
  }))
)
</script>

<template>
  <div class="app">
    <div class="app-heading">
      <LeagueDropdown
        v-if="challengeOptions.length > 0"
        v-model="selectedChallengeIndex"
        :options="challengeOptions"
      />
    </div>
    <button class="league-button settings-button" @click="settingsVisible = !settingsVisible">
      <FontAwesomeIcon :icon="faGear" />
    </button>
    <div class="challenges" v-if="summoner && allChampions">
      <ChallengeSection
        v-if="challenges[selectedChallengeIndex]"
        :challenge="challenges[selectedChallengeIndex]"
        :all-champions="allChampions"
        :selectedChamp="selectedChamp"
        :bench-champion-ids="benchChampionIds"
        :crowd-favorite-champion-ids="crowdFavoriteChampionIds"
        :session-game-mode="sessionGameMode"
        :isColoredWhenDone="isColoredWhenDone"
        :showChampionNames="showChampionNames"
        :stats="stats"
      />
    </div>
    <div v-else>Waiting for a League client...</div>
    <Settings
      v-model:visible="settingsVisible"
      :isColoredWhenDone="isColoredWhenDone"
      :showChampionNames="showChampionNames"
      @update:isColoredWhenDone="
        (v) => updateSettings({ isColoredWhenDone: v, showChampionNames })
      "
      @update:showChampionNames="
        (v) => updateSettings({ isColoredWhenDone, showChampionNames: v })
      "
      @refetch="fetchAllDataFromMain"
      @refetch-aram-stats="fetchAramStats"
    />
  </div>
</template>

<style>
.app {
  background: var(--main-bg-gradient);
  border-top: solid 2px #785a28;
  position: relative;
  padding: 16px;
  color: var(--main-text-color);
}

.app-heading {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
  position: relative;
  width: 300px;
}

.tab {
  cursor: pointer;
  padding: 8px;
  border: solid 2px transparent;
}

.tab:hover {
  border-bottom: solid 2px #785a28;
  border-right: solid 2px #785a28;
}

.tab.selected {
  border-bottom: solid 2px #785a28;
  border-right: solid 2px #785a28;
}

.c
hallenges > * {
  margin-bottom: 32px;
}

button.settings-button {
  position: absolute;
  right: 16px;
  top: 18px;
  font-size: 16px;
  height: 40px;
  width: 40px;
  padding: 10px;
  border-radius: 50%;
}
</style>
